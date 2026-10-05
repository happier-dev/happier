import {
  SessionCreationTerminalSpawnErrorDetailSchema,
  type SessionCreationTerminalSpawnErrorDetail,
} from '@happier-dev/protocol';

type InitialTriggerRefusal = Extract<SessionCreationTerminalSpawnErrorDetail, {
  kind: 'session_creation_initial_trigger_refused';
}>;

export class SessionCreationInitialTriggerError extends Error {
  readonly retryable = false;

  constructor(readonly code: InitialTriggerRefusal['code'], readonly status: number) {
    super('Session initial trigger admission was refused');
    this.name = 'SessionCreationInitialTriggerError';
  }
}

export function readSessionCreationInitialTriggerError(
  payload: unknown,
  status: number,
): SessionCreationInitialTriggerError | null {
  if ((status !== 400 && status !== 409) || !payload || typeof payload !== 'object') return null;
  const response = payload as Record<string, unknown>;
  if (response.error !== 'initial_trigger_admission_failed') return null;
  const parsed = SessionCreationTerminalSpawnErrorDetailSchema.safeParse({
    kind: 'session_creation_initial_trigger_refused', code: response.code,
  });
  return parsed.success && parsed.data.kind === 'session_creation_initial_trigger_refused'
    ? new SessionCreationInitialTriggerError(parsed.data.code, status)
    : null;
}
