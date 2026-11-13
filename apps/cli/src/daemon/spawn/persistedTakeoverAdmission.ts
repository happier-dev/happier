import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';
import type { StoredCredentials } from '@/persistence';
import type { LoadedLinkedExternalSession } from '@/api/session/external/takeover/loadLinkedExternalSession';
import type { ExternalSessionOperationAccountScope } from '@/session/actions/externalSessions/operationRecordStore';

export const HAPPIER_PERSISTED_TAKEOVER_ADMISSION_ENV_KEY =
  'HAPPIER_PERSISTED_TAKEOVER_ADMISSION';

export type TakeoverAdmissionMode = 'persisted' | 'external_linked';

export type HostPrivatePersistedTakeoverAdmission = Readonly<{
  mode: TakeoverAdmissionMode;
  operationId: string;
  attemptId: string;
}>;

export type PersistedTakeoverAdmissionPhase = 'admit' | 'runtime_bound';

export type PersistedTakeoverAdmissionOutcome =
  | Readonly<{ status: 'committed' }>
  | Readonly<{ status: 'failed'; errorCode: string }>;

export type PersistedTakeoverAdmissionWaitRegistration = Readonly<{
  /** In-memory authority of this exact admitted attempt; never serialized. */
  context?: PersistedTakeoverAdmissionContext;
  outcome: Promise<PersistedTakeoverAdmissionOutcome>;
  readOutcome(): PersistedTakeoverAdmissionOutcome | null;
  cancel(): void;
}>;

export type PersistedTakeoverAdmissionContext = Readonly<{
  credentials?: StoredCredentials;
  accountScope?: ExternalSessionOperationAccountScope;
  linked?: LoadedLinkedExternalSession;
}>;

export type PersistedTakeoverAdmissionWaiter = Readonly<{
  isPending(correlation: HostPrivatePersistedTakeoverAdmission): boolean;
  register(
    correlation: HostPrivatePersistedTakeoverAdmission,
    options?: Readonly<{ signal?: AbortSignal; context?: PersistedTakeoverAdmissionContext }>,
  ): PersistedTakeoverAdmissionWaitRegistration;
  getRegistration(
    correlation: HostPrivatePersistedTakeoverAdmission,
  ): PersistedTakeoverAdmissionWaitRegistration | null;
  settle(
    correlation: HostPrivatePersistedTakeoverAdmission,
    outcome: PersistedTakeoverAdmissionOutcome,
  ): boolean;
  reserveRuntimeBound(
    correlation: HostPrivatePersistedTakeoverAdmission,
  ):
    | Readonly<{
        status: 'reserved';
        reservation: Readonly<{
          isActive(): boolean;
          commit(): boolean;
          fail(errorCode: string): boolean;
        }>;
      }>
    | Readonly<{
        status: 'already_reserved';
        outcome: Promise<PersistedTakeoverAdmissionOutcome>;
      }>
    | Readonly<{ status: 'unavailable' }>;
}>;

export function createPersistedTakeoverAdmissionWaiter(): PersistedTakeoverAdmissionWaiter {
  type PendingAdmission = {
    readonly outcome: Promise<PersistedTakeoverAdmissionOutcome>;
    readonly resolve: (outcome: PersistedTakeoverAdmissionOutcome) => void;
    registration: PersistedTakeoverAdmissionWaitRegistration;
    removeAbortListener: () => void;
    settledOutcome: PersistedTakeoverAdmissionOutcome | null;
    state: 'pending' | 'runtime_bound_reserved';
  };
  const pendingByAttempt = new Map<string, PendingAdmission>();
  const keyFor = (correlation: HostPrivatePersistedTakeoverAdmission): string => {
    const parsed = parsePersistedTakeoverAdmission(correlation);
    return JSON.stringify([parsed.mode, parsed.operationId, parsed.attemptId]);
  };

  const settle = (
    correlation: HostPrivatePersistedTakeoverAdmission,
    outcome: PersistedTakeoverAdmissionOutcome,
  ): boolean => {
    const key = keyFor(correlation);
    const pending = pendingByAttempt.get(key);
    if (!pending) return false;
    pendingByAttempt.delete(key);
    pending.removeAbortListener();
    pending.settledOutcome = outcome;
    pending.resolve(outcome);
    return true;
  };

  return Object.freeze({
    isPending(correlation) {
      return pendingByAttempt.get(keyFor(correlation))?.state === 'pending';
    },
    getRegistration(correlation) {
      return pendingByAttempt.get(keyFor(correlation))?.registration ?? null;
    },
    register(correlation, options = {}) {
      const parsed = parsePersistedTakeoverAdmission(correlation);
      const key = keyFor(parsed);
      if (pendingByAttempt.has(key)) {
        throw new Error('Persisted takeover admission attempt is already pending');
      }
      let resolveOutcome!: (outcome: PersistedTakeoverAdmissionOutcome) => void;
      const outcome = new Promise<PersistedTakeoverAdmissionOutcome>((resolve) => {
        resolveOutcome = resolve;
      });
      const cancel = () => {
        if (pendingByAttempt.get(key) !== pending) return;
        settle(parsed, {
          status: 'failed',
          errorCode: 'persisted_takeover_admission_cancelled',
        });
      };
      const registration: PersistedTakeoverAdmissionWaitRegistration = Object.freeze({
        ...(options.context ? { context: options.context } : {}),
        outcome,
        readOutcome: () => pending.settledOutcome,
        cancel,
      });
      const pending: PendingAdmission = {
        outcome,
        resolve: resolveOutcome,
        registration,
        removeAbortListener: () => options.signal?.removeEventListener('abort', cancel),
        settledOutcome: null,
        state: 'pending',
      };
      pendingByAttempt.set(key, pending);
      options.signal?.addEventListener('abort', cancel, { once: true });
      if (options.signal?.aborted) cancel();
      return registration;
    },
    settle,
    reserveRuntimeBound(correlation) {
      const parsed = parsePersistedTakeoverAdmission(correlation);
      const key = keyFor(parsed);
      const pending = pendingByAttempt.get(key);
      if (!pending) return Object.freeze({ status: 'unavailable' as const });
      if (pending.state === 'runtime_bound_reserved') {
        return Object.freeze({
          status: 'already_reserved' as const,
          outcome: pending.outcome,
        });
      }
      pending.state = 'runtime_bound_reserved';
      const finish = (outcome: PersistedTakeoverAdmissionOutcome): boolean => {
        const current = pendingByAttempt.get(key);
        if (current !== pending || pending.state !== 'runtime_bound_reserved') {
          return false;
        }
        pendingByAttempt.delete(key);
        pending.removeAbortListener();
        pending.settledOutcome = outcome;
        pending.resolve(outcome);
        return true;
      };
      return Object.freeze({
        status: 'reserved' as const,
        reservation: Object.freeze({
          isActive: () =>
            pendingByAttempt.get(key) === pending
            && pending.state === 'runtime_bound_reserved',
          commit: () => finish({ status: 'committed' }),
          fail: (errorCode: string) => finish({ status: 'failed', errorCode }),
        }),
      });
    },
  });
}

function readBoundedIdentity(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 256 ? normalized : null;
}

export function parsePersistedTakeoverAdmission(
  value: unknown,
): HostPrivatePersistedTakeoverAdmission {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
  const mode = record?.mode === 'persisted' || record?.mode === 'external_linked'
    ? record.mode
    : null;
  const operationId = readBoundedIdentity(record?.operationId);
  const attemptId = readBoundedIdentity(record?.attemptId);
  if (
    !mode
    || !operationId
    || !attemptId
    || !record
    || Object.keys(record).some(
      (key) => key !== 'mode' && key !== 'operationId' && key !== 'attemptId',
    )
  ) {
    throw new Error('Persisted takeover admission handoff is malformed');
  }
  return Object.freeze({ mode, operationId, attemptId });
}

export function serializePersistedTakeoverAdmissionForEnv(
  correlation: HostPrivatePersistedTakeoverAdmission,
): string {
  return JSON.stringify(parsePersistedTakeoverAdmission(correlation));
}

export function consumePersistedTakeoverAdmissionFromEnv(
  env: NodeJS.ProcessEnv = sessionProcessEnvironment(),
): HostPrivatePersistedTakeoverAdmission | null {
  const raw = env[HAPPIER_PERSISTED_TAKEOVER_ADMISSION_ENV_KEY];
  if (raw === undefined) return null;
  delete env[HAPPIER_PERSISTED_TAKEOVER_ADMISSION_ENV_KEY];
  try {
    return parsePersistedTakeoverAdmission(JSON.parse(raw) as unknown);
  } catch {
    throw new Error('Persisted takeover admission handoff is malformed');
  }
}
