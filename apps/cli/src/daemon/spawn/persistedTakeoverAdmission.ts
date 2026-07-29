export const HAPPIER_PERSISTED_TAKEOVER_ADMISSION_ENV_KEY =
  'HAPPIER_PERSISTED_TAKEOVER_ADMISSION';

export type HostPrivatePersistedTakeoverAdmission = Readonly<{
  operationId: string;
  attemptId: string;
}>;

export type PersistedTakeoverAdmissionPhase = 'admit' | 'runtime_bound';

export type PersistedTakeoverAdmissionOutcome =
  | Readonly<{ status: 'committed' }>
  | Readonly<{ status: 'failed'; errorCode: string }>;

export type PersistedTakeoverAdmissionWaitRegistration = Readonly<{
  outcome: Promise<PersistedTakeoverAdmissionOutcome>;
  readOutcome(): PersistedTakeoverAdmissionOutcome | null;
  cancel(): void;
}>;

export type PersistedTakeoverAdmissionWaiter = Readonly<{
  isPending(correlation: HostPrivatePersistedTakeoverAdmission): boolean;
  register(
    correlation: HostPrivatePersistedTakeoverAdmission,
  ): PersistedTakeoverAdmissionWaitRegistration;
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

export function createPersistedTakeoverAdmissionWaiter(options: Readonly<{
  timeoutMs?: number;
}> = {}): PersistedTakeoverAdmissionWaiter {
  type PendingAdmission = {
    readonly outcome: Promise<PersistedTakeoverAdmissionOutcome>;
    readonly resolve: (outcome: PersistedTakeoverAdmissionOutcome) => void;
    timer: ReturnType<typeof setTimeout>;
    settledOutcome: PersistedTakeoverAdmissionOutcome | null;
    state: 'pending' | 'runtime_bound_reserved';
  };
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Persisted takeover admission timeout must be positive');
  }
  const pendingByAttempt = new Map<string, PendingAdmission>();
  const keyFor = (correlation: HostPrivatePersistedTakeoverAdmission): string => {
    const parsed = parsePersistedTakeoverAdmission(correlation);
    return JSON.stringify([parsed.operationId, parsed.attemptId]);
  };

  const settle = (
    correlation: HostPrivatePersistedTakeoverAdmission,
    outcome: PersistedTakeoverAdmissionOutcome,
  ): boolean => {
    const key = keyFor(correlation);
    const pending = pendingByAttempt.get(key);
    if (!pending) return false;
    pendingByAttempt.delete(key);
    clearTimeout(pending.timer);
    pending.settledOutcome = outcome;
    pending.resolve(outcome);
    return true;
  };

  return Object.freeze({
    isPending(correlation) {
      return pendingByAttempt.get(keyFor(correlation))?.state === 'pending';
    },
    register(correlation) {
      const parsed = parsePersistedTakeoverAdmission(correlation);
      const key = keyFor(parsed);
      if (pendingByAttempt.has(key)) {
        throw new Error('Persisted takeover admission attempt is already pending');
      }
      let resolveOutcome!: (outcome: PersistedTakeoverAdmissionOutcome) => void;
      const outcome = new Promise<PersistedTakeoverAdmissionOutcome>((resolve) => {
        resolveOutcome = resolve;
      });
      const pending: PendingAdmission = {
        outcome,
        resolve: resolveOutcome,
        settledOutcome: null,
        state: 'pending',
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
      };
      pending.timer = setTimeout(() => {
        settle(parsed, {
          status: 'failed',
          errorCode: 'persisted_takeover_admission_timeout',
        });
      }, timeoutMs);
      pendingByAttempt.set(key, pending);
      return Object.freeze({
        outcome,
        readOutcome: () => pending.settledOutcome,
        cancel() {
          const current = pendingByAttempt.get(key);
          if (current !== pending) return;
          settle(parsed, {
            status: 'failed',
            errorCode: 'persisted_takeover_admission_cancelled',
          });
        },
      });
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
  const operationId = readBoundedIdentity(record?.operationId);
  const attemptId = readBoundedIdentity(record?.attemptId);
  if (
    !operationId
    || !attemptId
    || !record
    || Object.keys(record).some((key) => key !== 'operationId' && key !== 'attemptId')
  ) {
    throw new Error('Persisted takeover admission handoff is malformed');
  }
  return Object.freeze({ operationId, attemptId });
}

export function serializePersistedTakeoverAdmissionForEnv(
  correlation: HostPrivatePersistedTakeoverAdmission,
): string {
  return JSON.stringify(parsePersistedTakeoverAdmission(correlation));
}

export function consumePersistedTakeoverAdmissionFromEnv(
  env: NodeJS.ProcessEnv = process.env,
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
