import type {
  RuntimePromptAcceptedInfoV1,
  RuntimeSendOptionsV1,
} from '@happier-dev/plugin-sdk';

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readNumberList(value: readonly number[] | undefined): readonly number[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
    .map((item) => Math.trunc(item));
}

function readStringList(value: readonly string[] | undefined): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => readString(item))
    .filter((item): item is string => item !== null);
}

export function buildAntigravityPromptAcceptedInfo(
  options: RuntimeSendOptionsV1 | undefined,
): RuntimePromptAcceptedInfoV1 {
  const localInputId = readString(options?.localInputId);
  const localInputIds = readStringList(options?.localInputIds);
  const userMessageSeq = typeof options?.userMessageSeq === 'number' && Number.isFinite(options.userMessageSeq)
    ? Math.trunc(options.userMessageSeq)
    : null;
  const userMessageSeqs = readNumberList(options?.userMessageSeqs);
  return {
    ...(localInputId ? { localInputId } : {}),
    ...(localInputIds.length > 0 ? { localInputIds } : {}),
    userMessageSeq,
    ...(userMessageSeqs.length > 0 ? { userMessageSeqs } : {}),
  };
}
