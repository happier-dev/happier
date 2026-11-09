import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';

/** The Account task adapter's unavailable state; the code remains available for support. */
export const INTERNAL_TASK_DATA_UNAVAILABLE_V1 = Object.freeze({
  class: 'transient',
  code: 'accountDataUnavailable',
  detail: 'Happier could not access your task data.',
} satisfies TriageSourceFailureV1);
