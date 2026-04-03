# MuNote Listen Together

Web nghe YouTube cùng nhau theo thời gian thực với giao diện MuNote.

## Tính năng chính

- Trang chủ riêng để giới thiệu web
- Đăng ký / đăng nhập demo bằng localStorage
- Tạo phòng hoặc vào phòng demo
- Đồng bộ YouTube realtime qua Socket.IO
- Chủ phòng / thành viên
- Chủ phòng có thể kick thành viên
- Chủ phòng có thể trao quyền quản lý cho member
- Chat realtime trong phòng
- Tìm kiếm YouTube bằng API key
- Gửi ảnh chat qua Cloudinary (tùy chọn)

## Chạy local

```bash
npm install
npm start
```

Mở `http://localhost:3000`

## Biến môi trường

Copy file `.env.example` thành `.env` nếu chạy local.

### Bắt buộc nếu muốn tìm kiếm YouTube

- `YOUTUBE_API_KEY`

### Tùy chọn nếu muốn gửi ảnh trong chat

- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`

### Tùy chọn cho CORS

- `CORS_ORIGIN`

Ví dụ:

```env
YOUTUBE_API_KEY=your_key
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret
CORS_ORIGIN=https://your-render-domain.onrender.com
```

## Route chính

- `/` trang chủ
- `/room/:roomId` phòng nghe
- `/healthz` health check cho Render

## Deploy lên Render

### Cách 1: Dùng render.yaml

Repo đã có sẵn `render.yaml`.

1. Push code lên GitHub
2. Vào Render > New > Blueprint
3. Chọn repo GitHub của bạn
4. Thêm env vars trong Render dashboard
5. Deploy

### Cách 2: Tạo Web Service thủ công

- Environment: `Node`
- Build Command: `npm install`
- Start Command: `npm start`
- Health Check Path: `/healthz`

## Lưu ý

- Đăng nhập / đăng ký hiện là bản demo bằng localStorage phía client, phù hợp để test flow UI trước khi làm auth thật.
- Nếu không set `YOUTUBE_API_KEY`, phần tìm kiếm YouTube sẽ báo thiếu cấu hình.
- Nếu không set Cloudinary, phần gửi ảnh chat sẽ bị tắt và trả lỗi rõ ràng.
