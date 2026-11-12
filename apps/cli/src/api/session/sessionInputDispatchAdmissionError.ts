/** A protected input could not be admitted before any provider effect. */
export class SessionInputDispatchAdmissionError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(status: 'rejected' | 'held' | 'outcomeUnknown', options?: ErrorOptions) {
    super('Session input is not currently admitted for provider dispatch', options);
    this.code = status === 'rejected' ? 'session_input_rejected' : status === 'held' ? 'session_input_held' : 'session_input_admission_unavailable';
    this.retryable = status !== 'rejected';
  }
}
