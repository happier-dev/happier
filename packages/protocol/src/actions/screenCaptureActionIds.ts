export const SCREEN_CAPTURE_DELIVERY_ACTION_IDS = [
  'screenCapture.open', 'screenCapture.addToDraft', 'screenCapture.send', 'screenCapture.discard',
  'screenCapture.copy', 'screenCapture.showInFolder',
] as const;

export type ScreenCaptureDeliveryActionId = typeof SCREEN_CAPTURE_DELIVERY_ACTION_IDS[number];

export const SCREEN_CAPTURE_NATIVE_ACTION_IDS = [
  'screenCapture.start', 'screenCapture.targets.list', 'screenCapture.permissions.read',
  'screenCapture.permissions.request', 'screenCapture.windowText.read', 'screenCapture.recent.list',
  'screenCapture.recording.status', 'screenCapture.recording.pause',
  'screenCapture.recording.resume', 'screenCapture.recording.stop',
  'screenCapture.recording.edit', 'screenCapture.recording.read',
] as const;
export type ScreenCaptureNativeActionId = typeof SCREEN_CAPTURE_NATIVE_ACTION_IDS[number];
export const SCREEN_CAPTURE_ACTION_IDS = [...SCREEN_CAPTURE_DELIVERY_ACTION_IDS, ...SCREEN_CAPTURE_NATIVE_ACTION_IDS] as const;
export type ScreenCaptureActionId = typeof SCREEN_CAPTURE_ACTION_IDS[number];

export function isScreenCaptureActionId(value: string): value is ScreenCaptureActionId {
  return SCREEN_CAPTURE_ACTION_IDS.some(id => id === value);
}

export function isScreenCaptureDeliveryActionId(value: string): value is ScreenCaptureDeliveryActionId {
  return SCREEN_CAPTURE_DELIVERY_ACTION_IDS.some(id => id === value);
}
