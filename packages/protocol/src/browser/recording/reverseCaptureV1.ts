import { z } from 'zod';

/**
 * Reverse (daemon -> UI) browser-recording native-view capture contract (W2C-BA-1).
 *
 * The desktop Wry WebView is owned by the UI process; the spawned cli daemon runs in a SEPARATE OS
 * process and cannot `invokeDesktopHost` directly. So the daemon `nativeViewCapture` recording producer
 * asks the connected desktop UI — over the existing daemon<->UI session RPC channel
 * (`RPC_METHODS.UI_BROWSER_RECORDING_CAPTURE_FRAME`) — to capture ONE frame from the view it owns.
 *
 * Reference-only invariant (BRW-15): the daemon names the local `outputPath` + the negotiated byte
 * cap; the UI's native capture writes the PNG to that path and returns ONLY a reference + metadata.
 * The raw pixel buffer never crosses the RPC boundary in either direction.
 */

const IdSchema = z.string().trim().min(1).max(256);
const NonNegativeIntSchema = z.number().int().nonnegative();
const PositiveIntSchema = z.number().int().positive();

/**
 * Request the daemon sends the connected desktop UI to capture one recording frame. Mirrors the
 * daemon-facing `DesktopBrowserRecordingFrameCaptureRequest` so the UI handler can forward it
 * straight to the A2-registered `desktop_browser_capture_recording_frame` Tauri command.
 */
export const UiBrowserRecordingCaptureFrameRequestV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    browserSessionId: IdSchema,
    viewId: IdSchema,
    navigationGeneration: NonNegativeIntSchema,
    captureRequestId: IdSchema,
    /** Local filesystem path the native side must write the captured PNG to. */
    outputPath: z.string().trim().min(1),
    /** Recording byte cap; the native side rejects a capture larger than this. */
    maxBytes: PositiveIntSchema,
  })
  .strict();
export type UiBrowserRecordingCaptureFrameRequestV1 = z.infer<
  typeof UiBrowserRecordingCaptureFrameRequestV1Schema
>;

/**
 * Reference-only frame the UI returns: a local file path the native side wrote + metadata. No inline
 * bytes — the daemon resolves the artifact from `path` under the recording working directory.
 */
export const UiBrowserRecordingCaptureFrameResultV1Schema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      frame: z
        .object({
          mimeType: IdSchema,
          width: NonNegativeIntSchema,
          height: NonNegativeIntSchema,
          sizeBytes: NonNegativeIntSchema,
          /** Path the native side actually wrote the PNG to (echoes the requested `outputPath`). */
          path: z.string().trim().min(1),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      errorCode: IdSchema,
    })
    .strict(),
]);
export type UiBrowserRecordingCaptureFrameResultV1 = z.infer<
  typeof UiBrowserRecordingCaptureFrameResultV1Schema
>;

export const UiBrowserRecordingCaptureFrameResponseV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    result: UiBrowserRecordingCaptureFrameResultV1Schema,
  })
  .strict();
export type UiBrowserRecordingCaptureFrameResponseV1 = z.infer<
  typeof UiBrowserRecordingCaptureFrameResponseV1Schema
>;
