// One frame owner per platform: the web canvas reader also serves the desktop webview; native decodes with Skia.
export { readHeldPlayerFrame, readVideoFrame, withVideoFrameSource } from './videoFrameAccess.web';
export type { MediaPlayerFrame, MediaPlayerFrameOptions, MediaPlayerPlayback, MediaPlayerVideoControls } from './videoFrameAccess.types';
