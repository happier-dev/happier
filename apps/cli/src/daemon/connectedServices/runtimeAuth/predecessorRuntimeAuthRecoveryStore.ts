import {
  ConnectedServiceCredentialRevisionV1Schema,
  TranscriptRawAgentEventV1Schema,
} from '@happier-dev/protocol';

import type { DurableBackoffRecoveryStore } from '../recoveryScheduler/DurableBackoffRecoveryScheduler';
import type { RecoveryIntentFileStore } from '../recoveryScheduler/recoveryIntentFileStore';
import {
  normalizeRuntimeAuthRecoveryIntent,
  type RuntimeAuthRecoveryIntent,
  type RuntimeAuthRecoveryPendingVisibleEvent,
} from './RuntimeAuthRecoveryScheduler';
import { buildRuntimeAuthRecoveryKey } from './runtimeAuthRecoveryKey';
import { sanitizeConnectedServiceRuntimeFailureClassification } from './sanitizeConnectedServiceRuntimeFailureClassification';

const PREDECESSOR_RUNTIME_AUTH_RECOVERY_KEY_PREFIX = 'runtime-auth:v1:';

type RuntimeAuthRecoveryPhysicalKeyParts = Readonly<{
  sessionId: string;
  serviceId: string;
  profileId: string | null;
  groupId: string | null;
  failingAccessTokenFingerprint?: string | null;
  classification?: Readonly<{
    failingAccessTokenFingerprint?: string | null;
  }>;
}>;

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readString(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 ? normalized : null;
}

function readNullableString(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  return readString(value) ?? undefined;
}

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function readNullableNonNegativeInteger(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  return readNonNegativeInteger(value) ?? undefined;
}

function readPredecessorPendingVisibleEvents(
  value: unknown,
  expected: Readonly<{
    attemptId: string;
    serviceId: string;
    profileId: string | null;
    groupId: string | null;
  }>,
): ReadonlyArray<RuntimeAuthRecoveryPendingVisibleEvent> | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const pendingEvents: RuntimeAuthRecoveryPendingVisibleEvent[] = [];
  const transitionKeys = new Set<string>();
  for (const candidate of value) {
    const pending = asRecord(candidate);
    const attemptId = readString(pending?.attemptId);
    const transition = pending?.transition === 'working' || pending?.transition === 'scheduled'
      ? pending.transition
      : null;
    const transcriptEvent = TranscriptRawAgentEventV1Schema.safeParse(pending?.transcriptEvent);
    if (
      !attemptId
      || attemptId !== expected.attemptId
      || !transition
      || !transcriptEvent.success
      || transcriptEvent.data.type !== 'connected-service-runtime-auth-recovery'
      || transcriptEvent.data.serviceId !== expected.serviceId
      || (transcriptEvent.data.profileId ?? null) !== expected.profileId
      || (transcriptEvent.data.groupId ?? null) !== expected.groupId
    ) {
      return null;
    }
    const transitionKey = `${attemptId}:${transition}`;
    if (transitionKeys.has(transitionKey)) return null;
    transitionKeys.add(transitionKey);
    pendingEvents.push({
      attemptId,
      transition,
      transcriptEvent: transcriptEvent.data,
    });
  }
  return pendingEvents;
}

/**
 * Converts the exact runtime-auth V2 persistence vector written by the moving
 * remote-dev predecessor at 6e6ecb42e7f9ab8607b5710547563bbc9c232728.
 *
 * Only passive waiting custody is accepted. In-flight/terminal/future records
 * fail closed because dev cannot prove their process/effect ownership.
 */
function normalizePredecessorRuntimeAuthRecoveryIntent(value: unknown): RuntimeAuthRecoveryIntent | null {
  const record = asRecord(value);
  if (!record || record.v !== 2) return null;
  if (record.status !== 'waiting' && record.status !== 'resumed_awaiting_proof') return null;

  const sessionId = readString(record.sessionId);
  const serviceId = readString(record.serviceId);
  const profileId = readNullableString(record.profileId);
  const groupId = readNullableString(record.groupId);
  const attemptId = readString(record.attemptId);
  const lastSettledTransition = record.lastSettledTransition === 'working'
    || record.lastSettledTransition === 'scheduled'
    ? record.lastSettledTransition
    : null;
  const armedAtMs = readNonNegativeInteger(record.armedAtMs);
  const attemptCount = readNonNegativeInteger(record.attemptCount);
  const maxAttempts = readNonNegativeInteger(record.maxAttempts);
  const switchesThisTurn = readNonNegativeInteger(record.switchesThisTurn);
  const pendingTargetProfileId = readNullableString(record.pendingTargetProfileId);
  const pendingTargetGeneration = readNullableNonNegativeInteger(record.pendingTargetGeneration);
  if (
    !sessionId
    || !serviceId
    || profileId === undefined
    || groupId === undefined
    || !attemptId
    || !lastSettledTransition
    || armedAtMs === null
    || attemptCount === null
    || maxAttempts === null
    || maxAttempts === 0
    || switchesThisTurn === null
    || pendingTargetProfileId === undefined
    || pendingTargetGeneration === undefined
  ) {
    return null;
  }

  const nextRetryAtMs = record.nextRetryAtMs === null
    ? null
    : readNonNegativeInteger(record.nextRetryAtMs);
  if (
    (record.nextRetryAtMs !== null && nextRetryAtMs === null)
    || (lastSettledTransition === 'working' && nextRetryAtMs !== null)
    || (lastSettledTransition === 'scheduled' && nextRetryAtMs === null)
  ) {
    return null;
  }
  if (record.failurePhase !== 'handler' && record.failurePhase !== 'apply') return null;
  const failureReason = readString(record.failureReason);
  if (!failureReason) return null;
  if (record.lastError !== null && readString(record.lastError) === null) return null;
  const lastErrorClassification = record.lastErrorClassification === null
    ? null
    : asRecord(record.lastErrorClassification);
  if (
    lastErrorClassification !== null
    && (
      !readString(lastErrorClassification.kind)
      || typeof lastErrorClassification.retryable !== 'boolean'
    )
  ) {
    return null;
  }
  if (record.terminalAtMs !== null && record.terminalAtMs !== undefined) return null;
  if (record.terminalReason !== null && record.terminalReason !== undefined) return null;

  const rawClassification = asRecord(record.classification);
  if (!rawClassification) return null;
  const predecessorCredentialRevision = rawClassification.credentialRevision === null
    || rawClassification.credentialRevision === undefined
    ? null
    : ConnectedServiceCredentialRevisionV1Schema.safeParse(rawClassification.credentialRevision);
  if (predecessorCredentialRevision !== null && !predecessorCredentialRevision.success) return null;
  const currentCredentialRevision = rawClassification.expectedCredentialRevision === null
    || rawClassification.expectedCredentialRevision === undefined
    ? null
    : ConnectedServiceCredentialRevisionV1Schema.safeParse(rawClassification.expectedCredentialRevision);
  if (currentCredentialRevision !== null && !currentCredentialRevision.success) return null;
  if (
    predecessorCredentialRevision
    && currentCredentialRevision
    && predecessorCredentialRevision.data !== currentCredentialRevision.data
  ) {
    return null;
  }
  const expectedCredentialRevision = predecessorCredentialRevision?.data
    ?? currentCredentialRevision?.data
    ?? null;
  const classification = sanitizeConnectedServiceRuntimeFailureClassification({
    ...rawClassification,
    ...(expectedCredentialRevision ? { expectedCredentialRevision } : {}),
  });
  if (
    !classification
    || classification.serviceId !== serviceId
    || classification.profileId !== profileId
    || classification.groupId !== groupId
  ) {
    return null;
  }

  const pendingVisibleEvents = readPredecessorPendingVisibleEvents(record.pendingVisibleEvents, {
    attemptId,
    serviceId,
    profileId,
    groupId,
  });
  if (pendingVisibleEvents === null) return null;

  const resumePromptMode = record.resumePromptMode === 'standard'
    || record.resumePromptMode === 'off'
    || record.resumePromptMode === 'custom'
    ? record.resumePromptMode
    : null;
  if (!resumePromptMode) return null;

  return {
    v: 1,
    attemptId,
    lastSettledTransition,
    ...(pendingVisibleEvents.length > 0 ? { pendingVisibleEvents } : {}),
    sessionId,
    serviceId,
    profileId,
    groupId,
    resumePromptMode,
    status: record.status,
    armedAtMs,
    nextRetryAtMs,
    attemptCount,
    maxAttempts,
    switchesThisTurn,
    classification,
    failurePhase: record.failurePhase,
    failureReason,
    lastError: record.lastError === null ? null : readString(record.lastError),
    lastErrorClassification: lastErrorClassification as RuntimeAuthRecoveryIntent['lastErrorClassification'],
    pendingTargetProfileId,
    pendingTargetGeneration,
    pendingTargetCredentialRevision: null,
    terminalAtMs: null,
    terminalReason: null,
    ...(readNonNegativeInteger(record.degradedAttemptCount) === null
      ? {}
      : { degradedAttemptCount: readNonNegativeInteger(record.degradedAttemptCount) as number }),
    ...(readNonNegativeInteger(record.coalescedReplayCount) === null
      ? {}
      : { coalescedReplayCount: readNonNegativeInteger(record.coalescedReplayCount) as number }),
  };
}

function buildPredecessorRuntimeAuthRecoveryKey(intent: RuntimeAuthRecoveryPhysicalKeyParts): string {
  return `${PREDECESSOR_RUNTIME_AUTH_RECOVERY_KEY_PREFIX}${Buffer.from(JSON.stringify([
    intent.sessionId,
    intent.serviceId,
    intent.groupId ? null : intent.profileId,
    intent.groupId,
  ]), 'utf8').toString('base64url')}`;
}

function buildCurrentRuntimeAuthRecoveryKey(
  intent: RuntimeAuthRecoveryPhysicalKeyParts,
): string {
  const failingAccessTokenFingerprint = intent.classification?.failingAccessTokenFingerprint
    ?? intent.failingAccessTokenFingerprint
    ?? null;
  return buildRuntimeAuthRecoveryKey({
    sessionId: intent.sessionId,
    serviceId: intent.serviceId,
    profileId: intent.profileId,
    groupId: intent.groupId,
    failingAccessTokenFingerprint,
  });
}

function parseCurrentRuntimeAuthRecoveryKey(key: string): RuntimeAuthRecoveryPhysicalKeyParts | null {
  if (!key.startsWith(PREDECESSOR_RUNTIME_AUTH_RECOVERY_KEY_PREFIX)) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(
      key.slice(PREDECESSOR_RUNTIME_AUTH_RECOVERY_KEY_PREFIX.length),
      'base64url',
    ).toString('utf8')) as unknown;
  } catch {
    return null;
  }
  if (!Array.isArray(decoded) || decoded.length !== 5) return null;
  const sessionId = readString(decoded[0]);
  const serviceId = readString(decoded[1]);
  const profileId = readNullableString(decoded[2]);
  const groupId = readNullableString(decoded[3]);
  const failingAccessTokenFingerprint = readNullableString(decoded[4]);
  if (
    !sessionId
    || !serviceId
    || profileId === undefined
    || groupId === undefined
    || failingAccessTokenFingerprint === undefined
  ) {
    return null;
  }
  const parts = {
    sessionId,
    serviceId,
    profileId,
    groupId,
    failingAccessTokenFingerprint,
  };
  return buildCurrentRuntimeAuthRecoveryKey(parts) === key ? parts : null;
}

function readIntentKeyParts(value: unknown): RuntimeAuthRecoveryIntent | null {
  const predecessor = normalizePredecessorRuntimeAuthRecoveryIntent(value);
  if (predecessor) return predecessor;
  const current = normalizeRuntimeAuthRecoveryIntent(value);
  if (
    !current
    || !current.sessionId
    || !current.serviceId
    || current.classification.serviceId !== current.serviceId
    || current.classification.profileId !== current.profileId
    || current.classification.groupId !== current.groupId
  ) return null;
  return current;
}

function normalizeCompatibleIntent(value: unknown): unknown | null {
  const record = asRecord(value);
  if (record?.v === 2) return normalizePredecessorRuntimeAuthRecoveryIntent(value);
  return record?.v === 1 ? value : null;
}

class RuntimeAuthRecoveryOwnerOccupiedError extends Error {
  readonly code = 'runtime_auth_recovery_owner_occupied_by_unsupported_version';

  constructor() {
    super('Runtime-auth recovery owner key is occupied by unsupported or conflicting state');
    this.name = 'RuntimeAuthRecoveryOwnerOccupiedError';
  }
}

/**
 * A scheduler-local key/shape adapter over the single canonical production file
 * store. It retains the predecessor key as the transaction/effect-claim owner and
 * exposes the current composite key to the current scheduler.
 *
 * Remove after the predecessor frontier no longer writes V2/four-part keys and
 * the bounded seven-day terminal-retention horizon for those records has elapsed.
 */
export function createPredecessorCompatibleRuntimeAuthRecoveryStore(
  store: RecoveryIntentFileStore<RuntimeAuthRecoveryIntent>,
): DurableBackoffRecoveryStore<RuntimeAuthRecoveryIntent> {
  const pruneStore = store.prune;

  function normalizeOwnedIntentForMutation(
    value: unknown,
    currentKey: string,
    actualKey: string,
  ): RuntimeAuthRecoveryIntent {
    const normalized = readIntentKeyParts(value);
    if (!normalized) throw new RuntimeAuthRecoveryOwnerOccupiedError();
    const currentKeyParts = parseCurrentRuntimeAuthRecoveryKey(currentKey);
    if (!currentKeyParts) return normalized;
    if (
      buildCurrentRuntimeAuthRecoveryKey(normalized) !== currentKey
      || (
        actualKey !== currentKey
        && actualKey !== buildPredecessorRuntimeAuthRecoveryKey(currentKeyParts)
      )
    ) {
      throw new RuntimeAuthRecoveryOwnerOccupiedError();
    }
    return normalized;
  }

  function readCompatiblePhysicalOwner(
    currentKey: string,
    readPhysicalOwner: (ownerKey: string) => unknown | null,
  ): unknown | null {
    const currentValue = readPhysicalOwner(currentKey);
    const currentKeyParts = parseCurrentRuntimeAuthRecoveryKey(currentKey);
    if (!currentKeyParts) {
      return normalizeCompatibleIntent(currentValue);
    }

    const predecessorKey = buildPredecessorRuntimeAuthRecoveryKey(currentKeyParts);
    const predecessorValue = readPhysicalOwner(predecessorKey);
    if (currentValue !== null && predecessorValue !== null) return null;
    const actualKey = predecessorValue === null ? currentKey : predecessorKey;
    const actualValue = predecessorValue ?? currentValue;
    if (actualValue === null) return null;
    try {
      const normalized = normalizeOwnedIntentForMutation(actualValue, currentKey, actualKey);
      return asRecord(actualValue)?.v === 2 ? normalized : actualValue;
    } catch {
      return null;
    }
  }

  async function transactPhysicalOwner<TResult>(
    currentKey: string,
    transaction: (current: Readonly<{
      intent: RuntimeAuthRecoveryIntent | null;
      effectClaimToken: string | null;
    }>) => Readonly<{
      intent: RuntimeAuthRecoveryIntent | null;
      effectClaimToken: string | null;
      result: TResult;
    }>,
  ): Promise<TResult> {
    const currentKeyParts = parseCurrentRuntimeAuthRecoveryKey(currentKey);
    const predecessorKey = currentKeyParts
      ? buildPredecessorRuntimeAuthRecoveryKey(currentKeyParts)
      : null;
    const physicalKeys = predecessorKey ? [currentKey, predecessorKey] : [currentKey];
    return await store.transactKeys(physicalKeys, (
      currentByPhysicalKey,
      allCurrentByPhysicalKey,
    ) => {
      const currentEntry = currentByPhysicalKey.get(currentKey) ?? {
        intent: null,
        effectClaimToken: null,
      };
      const predecessorEntry = predecessorKey
        ? currentByPhysicalKey.get(predecessorKey) ?? {
            intent: null,
            effectClaimToken: null,
          }
        : null;
      const hasCompetingCurrentOwner = predecessorKey !== null
        && [...allCurrentByPhysicalKey.keys()].some((physicalKey) => {
          if (physicalKey === currentKey) return false;
          const physicalKeyParts = parseCurrentRuntimeAuthRecoveryKey(physicalKey);
          return physicalKeyParts !== null
            && buildPredecessorRuntimeAuthRecoveryKey(physicalKeyParts) === predecessorKey;
        });
      if (hasCompetingCurrentOwner) {
        throw new RuntimeAuthRecoveryOwnerOccupiedError();
      }
      const currentIsPresent = allCurrentByPhysicalKey.has(currentKey);
      const predecessorIsPresent = predecessorKey !== null
        && allCurrentByPhysicalKey.has(predecessorKey);
      if (
        (currentIsPresent && predecessorIsPresent)
        || (currentIsPresent && currentEntry.intent === null)
        || (
          predecessorIsPresent
          && predecessorEntry !== null
          && predecessorEntry.intent === null
        )
      ) {
        throw new RuntimeAuthRecoveryOwnerOccupiedError();
      }

      const predecessorOwns = predecessorIsPresent
        && predecessorEntry !== null
        && predecessorEntry.intent !== null;
      const currentOwns = currentIsPresent && currentEntry.intent !== null;
      const sourceKey = predecessorOwns && predecessorKey ? predecessorKey : currentKey;
      const sourceEntry = predecessorOwns ? predecessorEntry : currentEntry;
      const normalized = sourceEntry.intent === null
        ? null
        : normalizeOwnedIntentForMutation(sourceEntry.intent, currentKey, sourceKey);
      const next = transaction({
        intent: normalized,
        effectClaimToken: sourceEntry.effectClaimToken,
      });
      // During predecessor coexistence, the four-part key is the only physical key
      // both versions know. Current-only owners move there on their next mutation.
      // The locked census above rejects another fifth-part fingerprint before it
      // can alias two logical owners onto that physical key.
      const targetKey = predecessorKey ?? currentKey;
      const mutations = currentOwns && sourceKey !== targetKey
        ? [
            {
              sessionId: sourceKey,
              intent: null,
              effectClaimToken: null,
            },
            ...(next.intent === null ? [] : [{
              sessionId: targetKey,
              intent: next.intent,
              effectClaimToken: next.effectClaimToken,
            }]),
          ]
        : [{
            sessionId: targetKey,
            intent: next.intent,
            effectClaimToken: next.effectClaimToken,
          }];
      return {
        mutations,
        result: next.result,
      };
    });
  }

  return {
    read: (currentKey) => readCompatiblePhysicalOwner(currentKey, (ownerKey) => store.read(ownerKey)),
    readAuthoritative: (currentKey) => {
      const currentKeyParts = parseCurrentRuntimeAuthRecoveryKey(currentKey);
      const physicalKeys = currentKeyParts
        ? [currentKey, buildPredecessorRuntimeAuthRecoveryKey(currentKeyParts)]
        : [currentKey];
      const currentByPhysicalKey = store.readKeysAuthoritative(physicalKeys);
      return readCompatiblePhysicalOwner(
        currentKey,
        (ownerKey) => currentByPhysicalKey.get(ownerKey) ?? null,
      );
    },
    readAll: () => {
      const candidatesByCurrentKey = new Map<string, Array<readonly [string, RuntimeAuthRecoveryIntent, unknown]>>();
      for (const [actualKey, value] of store.readAll?.() ?? []) {
        const intent = readIntentKeyParts(value);
        if (!intent) continue;
        const currentKey = buildCurrentRuntimeAuthRecoveryKey(intent);
        const predecessorKey = buildPredecessorRuntimeAuthRecoveryKey(intent);
        const isCurrentV1 = asRecord(value)?.v === 1;
        if (
          (!isCurrentV1 && actualKey !== predecessorKey)
          || (isCurrentV1 && actualKey !== currentKey && actualKey !== predecessorKey)
        ) continue;
        const candidates = candidatesByCurrentKey.get(currentKey) ?? [];
        candidates.push([actualKey, intent, value]);
        candidatesByCurrentKey.set(currentKey, candidates);
      }

      const compatible: Array<readonly [string, unknown]> = [];
      for (const [currentKey, candidates] of candidatesByCurrentKey) {
        // Two independently stored owners for the same current identity are ambiguous.
        if (candidates.length !== 1) continue;
        const [, intent, rawValue] = candidates[0]!;
        compatible.push([
          currentKey,
          asRecord(rawValue)?.v === 2 ? intent : rawValue,
        ]);
      }
      return compatible;
    },
    write: async (currentKey, intent) => {
      await transactPhysicalOwner(currentKey, (current) => ({
        intent,
        effectClaimToken: current.effectClaimToken,
        result: undefined,
      }));
    },
    remove: async (currentKey) => {
      await transactPhysicalOwner(currentKey, () => ({
        intent: null,
        effectClaimToken: null,
        result: undefined,
      }));
    },
    prune: pruneStore
      ? async (predicate) => {
          const currentKeyByPrunedActualKey = new Map<string, string>();
          const prunedActualKeys = await pruneStore(({ sessionId: actualKey, value }) => {
            const intent = readIntentKeyParts(value);
            if (!intent) return false;
            const currentKey = buildCurrentRuntimeAuthRecoveryKey(intent);
            const shouldPrune = predicate({
              sessionId: currentKey,
              value: asRecord(value)?.v === 2 ? intent : value,
            });
            if (shouldPrune) currentKeyByPrunedActualKey.set(actualKey, currentKey);
            return shouldPrune;
          });
          return prunedActualKeys.map(
            (actualKey) => currentKeyByPrunedActualKey.get(actualKey) ?? actualKey,
          );
        }
      : undefined,
    transact: async (currentKey, transaction) => {
      return await transactPhysicalOwner(currentKey, transaction);
    },
  };
}
