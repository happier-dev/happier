export const BROWSER_RECORDING_ACTION_IDS_V1 = {
  start: 'browser.recording.start',
  stop: 'browser.recording.stop',
  cancel: 'browser.recording.cancel',
  status: 'browser.recording.status',
  list: 'browser.recording.listForView',
  discard: 'browser.recording.discard',
  cleanupExpired: 'browser.recording.cleanupExpired',
  attachToComposer: 'browser.recording.attachToComposer',
} as const;

export const COMPUTER_RECORDING_ACTION_IDS_V1 = {
  start: 'computer.recording.start',
  stop: 'computer.recording.stop',
  cancel: 'computer.recording.cancel',
  status: 'computer.recording.status',
  list: 'computer.recording.listForTarget',
  discard: 'computer.recording.discard',
  cleanupExpired: 'computer.recording.cleanupExpired',
  attachToComposer: 'computer.recording.attachToComposer',
} as const;

export type ComputerRecordingActionIdV1 = (typeof COMPUTER_RECORDING_ACTION_IDS_V1)[keyof typeof COMPUTER_RECORDING_ACTION_IDS_V1];
export function isComputerRecordingActionIdV1(value: string): value is ComputerRecordingActionIdV1 {
  return (Object.values(COMPUTER_RECORDING_ACTION_IDS_V1) as readonly string[]).includes(value);
}
