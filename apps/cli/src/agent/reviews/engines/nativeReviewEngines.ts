import { getNativeReviewEngine, listNativeReviewEngines, type NativeReviewEngineId } from '@happier-dev/protocol';
import type { BackendTargetRefV1, ExecutionRunRetentionPolicy } from '@happier-dev/protocol';

import type { ExecutionRunProfileBoundedCompleteResult } from '../../executionRuns/profiles/ExecutionRunIntentProfile';
import type { ExecutionRunBackendFactory } from '../../executionRuns/registry/executionRunBackendTypes';
import type {
  ExecutionRunIntentStartPreflightParams,
  ExecutionRunStartIntentPolicyResult,
} from '../../executionRuns/policy/executionRunStartPreflight';

import { executionRunBackendFactory as coderabbitBackendFactory } from './coderabbit/executionRunBackendFactory';
import { normalizeCodeRabbitPlainReviewOutput } from './coderabbit/normalizeCodeRabbitPlainReviewOutput';
import { runCodeRabbitReviewStartPreflight } from './coderabbit/runCodeRabbitReviewStartPreflight';

export type NativeReviewOutputNormalizer = (params: Readonly<{
  runId: string;
  callId: string;
  sidechainId: string;
  backendId: string;
  backendTarget: BackendTargetRefV1;
  startedAtMs: number;
  finishedAtMs: number;
  rawText: string;
  intentInput?: unknown;
  retentionPolicy?: ExecutionRunRetentionPolicy;
}>) => ExecutionRunProfileBoundedCompleteResult;

export type NativeReviewEngineDescriptor = Readonly<{
  id: NativeReviewEngineId;
  title: string;
  executionRunBackendFactory: ExecutionRunBackendFactory;
  reviewOutputNormalizer: NativeReviewOutputNormalizer;
  reviewStartPreflight?: (
    params: ExecutionRunIntentStartPreflightParams,
  ) => Promise<ExecutionRunStartIntentPolicyResult>;
}>;

const NATIVE_REVIEW_ENGINE_BINDINGS = Object.freeze({
  coderabbit: {
    executionRunBackendFactory: coderabbitBackendFactory,
    reviewOutputNormalizer: normalizeCodeRabbitPlainReviewOutput,
    reviewStartPreflight: runCodeRabbitReviewStartPreflight,
  },
} satisfies Record<
  NativeReviewEngineId,
  Omit<NativeReviewEngineDescriptor, 'id' | 'title'>
>);

export function listNativeReviewEngineDescriptors(): readonly NativeReviewEngineDescriptor[] {
  return listNativeReviewEngines().map((engine) => ({
    id: engine.id,
    title: engine.title,
    ...NATIVE_REVIEW_ENGINE_BINDINGS[engine.id],
  }));
}

export function getNativeReviewEngineDescriptor(id: string): NativeReviewEngineDescriptor | null {
  const key = String(id ?? '').trim() as NativeReviewEngineId;
  if (!key) return null;
  const engine = getNativeReviewEngine(key);
  if (!engine) return null;
  return {
    id: engine.id,
    title: engine.title,
    ...NATIVE_REVIEW_ENGINE_BINDINGS[engine.id],
  };
}

export function resolveNativeReviewExecutionRunBackendFactory(id: string): ExecutionRunBackendFactory | null {
  return getNativeReviewEngineDescriptor(id)?.executionRunBackendFactory ?? null;
}

export function resolveNativeReviewOutputNormalizer(id: string): NativeReviewOutputNormalizer | null {
  return getNativeReviewEngineDescriptor(id)?.reviewOutputNormalizer ?? null;
}

export function resolveNativeReviewStartPreflight(
  id: string,
): ((params: ExecutionRunIntentStartPreflightParams) => Promise<ExecutionRunStartIntentPolicyResult>) | null {
  return getNativeReviewEngineDescriptor(id)?.reviewStartPreflight ?? null;
}

export function listNativeReviewEngineIds(): readonly string[] {
  return listNativeReviewEngineDescriptors().map((e) => e.id);
}
