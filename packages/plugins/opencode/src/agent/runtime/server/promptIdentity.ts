import type {
  RuntimePromptAcceptedInfoV1,
  RuntimeSendOptionsV1,
} from '@happier-dev/plugin-sdk/experimental/runtime/session';

export type OpenCodeRuntimePromptIdentity = Readonly<{
  localInputIds: readonly string[];
  userMessageSeq: number | null;
  userMessageSeqs: readonly number[];
}>;

function readRuntimeUserMessageSeq(options: RuntimeSendOptionsV1 | undefined): number | null {
  return typeof options?.userMessageSeq === 'number' && Number.isFinite(options.userMessageSeq)
    ? Math.trunc(options.userMessageSeq)
    : null;
}

function readRuntimeLocalInputIds(options: RuntimeSendOptionsV1 | undefined): string[] {
  const localIds: string[] = [];
  const append = (value: unknown) => {
    const localId = typeof value === 'string' ? value.trim() : '';
    if (!localId || localIds.includes(localId)) return;
    localIds.push(localId);
  };
  append(options?.localInputId);
  for (const localId of options?.localInputIds ?? []) append(localId);
  return localIds;
}

function readRuntimeUserMessageSeqs(options: RuntimeSendOptionsV1 | undefined): number[] {
  const seqs: number[] = [];
  const append = (value: unknown) => {
    if (!Number.isSafeInteger(value) || (value as number) < 0) return;
    if (seqs.includes(value as number)) return;
    seqs.push(value as number);
  };
  append(options?.userMessageSeq);
  for (const seq of options?.userMessageSeqs ?? []) append(seq);
  return seqs;
}

export function readRuntimePromptIdentity(
  options: RuntimeSendOptionsV1 | undefined,
): OpenCodeRuntimePromptIdentity {
  return {
    localInputIds: readRuntimeLocalInputIds(options),
    userMessageSeq: readRuntimeUserMessageSeq(options),
    userMessageSeqs: readRuntimeUserMessageSeqs(options),
  };
}

export function toRuntimePromptCallbackInfo(
  identity: OpenCodeRuntimePromptIdentity,
): RuntimePromptAcceptedInfoV1 {
  return {
    ...(identity.localInputIds.length === 0 ? {} : { localInputIds: identity.localInputIds }),
    userMessageSeq: identity.userMessageSeq,
    ...(identity.userMessageSeqs.length === 0 ? {} : { userMessageSeqs: identity.userMessageSeqs }),
  };
}
