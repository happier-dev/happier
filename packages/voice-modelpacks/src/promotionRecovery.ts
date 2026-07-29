export type ModelPackPromotionPriorInstallV1 = Readonly<{
  scopeKey: string;
  identityKey: string;
}> | null;

export type ModelPackDurableRecoveryRecord = Readonly<{
  kind: string;
  value: unknown;
}>;

export const MODEL_PACK_PROMOTION_INTENT_MAX_BYTES = 64 * 1024;

export type ModelPackPromotionIntentV1 = Readonly<{
  schemaVersion: 1;
  packId: string;
  phase: 'swap_prepared' | 'metadata_pending' | 'metadata_committed' | 'rollback_pending';
  startedAtMs: number;
  token: string;
  priorInstall: ModelPackPromotionPriorInstallV1;
  recovery: ModelPackDurableRecoveryRecord | null;
}>;

const PHASES = new Set<ModelPackPromotionIntentV1['phase']>([
  'swap_prepared',
  'metadata_pending',
  'metadata_committed',
  'rollback_pending',
]);
const INTENT_KEYS = new Set([
  'schemaVersion',
  'packId',
  'phase',
  'startedAtMs',
  'token',
  'priorInstall',
  'recovery',
]);

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && value.trim() === value;
}

function invalidIntent(): never {
  throw new Error('model_pack_promotion_intent_invalid');
}

export function parseModelPackPromotionIntentV1(
  raw: unknown,
  expectedPackId: string,
): ModelPackPromotionIntentV1 {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalidIntent();
  const value = raw as Readonly<Record<string, unknown>>;
  if (Object.keys(value).some((key) => !INTENT_KEYS.has(key))) invalidIntent();
  if (
    value.schemaVersion !== 1
    || value.packId !== expectedPackId
    || !PHASES.has(value.phase as ModelPackPromotionIntentV1['phase'])
    || typeof value.startedAtMs !== 'number'
    || !Number.isSafeInteger(value.startedAtMs)
    || value.startedAtMs < 0
    || !boundedString(value.token, 256)
  ) invalidIntent();

  const prior = value.priorInstall;
  if (prior !== null) {
    if (!prior || typeof prior !== 'object' || Array.isArray(prior)) invalidIntent();
    const record = prior as Readonly<Record<string, unknown>>;
    if (
      Object.keys(record).some((key) => key !== 'scopeKey' && key !== 'identityKey')
      || !boundedString(record.scopeKey, 1024)
      || !boundedString(record.identityKey, 1024)
    ) invalidIntent();
  }

  const recovery = value.recovery;
  if (recovery !== null) {
    if (!recovery || typeof recovery !== 'object' || Array.isArray(recovery)) invalidIntent();
    const record = recovery as Readonly<Record<string, unknown>>;
    if (
      Object.keys(record).some((key) => key !== 'kind' && key !== 'value')
      || !boundedString(record.kind, 256)
      || !Object.prototype.hasOwnProperty.call(record, 'value')
    ) invalidIntent();
  }

  return Object.freeze({
    schemaVersion: 1,
    packId: expectedPackId,
    phase: value.phase as ModelPackPromotionIntentV1['phase'],
    startedAtMs: value.startedAtMs as number,
    token: value.token as string,
    priorInstall: prior === null
      ? null
      : Object.freeze({
          scopeKey: (prior as Readonly<Record<string, unknown>>).scopeKey as string,
          identityKey: (prior as Readonly<Record<string, unknown>>).identityKey as string,
        }),
    recovery: recovery === null
      ? null
      : Object.freeze({
          kind: (recovery as Readonly<Record<string, unknown>>).kind as string,
          value: (recovery as Readonly<Record<string, unknown>>).value,
        }),
  });
}

export function isLegacyModelPackPromotionIntent(
  raw: unknown,
  expectedPackId: string,
): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const value = raw as Readonly<Record<string, unknown>>;
  if (
    Object.prototype.hasOwnProperty.call(value, 'schemaVersion')
    || Object.prototype.hasOwnProperty.call(value, 'phase')
    || Object.prototype.hasOwnProperty.call(value, 'priorInstall')
    || Object.prototype.hasOwnProperty.call(value, 'recovery')
  ) return false;
  return value.packId === undefined || value.packId === expectedPackId;
}
