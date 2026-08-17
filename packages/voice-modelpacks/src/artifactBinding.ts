/**
 * Voice-owned correspondence between a public model-pack declaration and the
 * plugin artifact/custody fact that made it available to this daemon.
 *
 * `sourceIntegrity` deliberately preserves the acquisition owner's exact SRI
 * string. `materialization` is the opaque daemon generation identity used for
 * mutable local/path sources. Neither arm is a hash of extracted plugin files.
 */
export type VoiceModelPackArtifactBindingV1 =
  | Readonly<{
      kind: 'sourceIntegrity';
      integrity: string;
    }>
  | Readonly<{
      kind: 'materialization';
      immutableGenerationId: string;
    }>;

const MAX_SOURCE_INTEGRITY_LENGTH = 1024;
const MAX_MATERIALIZATION_ID_LENGTH = 512;

function invalid(): never {
  throw new Error('voice_model_pack_artifact_binding_invalid');
}

function readStrictRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid();
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return invalid();
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return invalid();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return invalid();
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return invalid();
  }
}

function readExactKeys(record: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(record);
  if (keys.length !== expected.length || expected.some((key) => !Object.hasOwn(record, key))) invalid();
}

function readBoundedString(value: unknown, maximumLength: number): string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maximumLength
    || value.trim() !== value
  ) {
    return invalid();
  }
  return value;
}

/** Parses the strict persisted/protocol binding without canonicalizing source-owned SRI. */
export function parseVoiceModelPackArtifactBindingV1(value: unknown): VoiceModelPackArtifactBindingV1 {
  const record = readStrictRecord(value);
  if (record.kind === 'sourceIntegrity') {
    readExactKeys(record, ['kind', 'integrity']);
    return Object.freeze({
      kind: 'sourceIntegrity',
      integrity: readBoundedString(record.integrity, MAX_SOURCE_INTEGRITY_LENGTH),
    });
  }
  if (record.kind === 'materialization') {
    readExactKeys(record, ['kind', 'immutableGenerationId']);
    return Object.freeze({
      kind: 'materialization',
      immutableGenerationId: readBoundedString(
        record.immutableGenerationId,
        MAX_MATERIALIZATION_ID_LENGTH,
      ),
    });
  }
  return invalid();
}

export function voiceModelPackArtifactBindingsEqualV1(
  left: VoiceModelPackArtifactBindingV1,
  right: VoiceModelPackArtifactBindingV1,
): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === 'sourceIntegrity'
    ? right.kind === 'sourceIntegrity' && left.integrity === right.integrity
    : right.kind === 'materialization'
      && left.immutableGenerationId === right.immutableGenerationId;
}
