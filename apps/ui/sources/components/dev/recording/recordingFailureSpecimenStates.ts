/** The recording results the specimen opens, in the order a person meets them. */
export const RECORDING_FAILURE_SPECIMEN_STATES = [
    'start-not-owned', 'start-session-unavailable', 'start-encoder-unavailable',
    'stop-not-saved-gone', 'stop-not-saved-in-files', 'stop-not-saved', 'stop-capture-failed', 'stop-no-answer',
] as const;
export type RecordingFailureSpecimenState = typeof RECORDING_FAILURE_SPECIMEN_STATES[number];
