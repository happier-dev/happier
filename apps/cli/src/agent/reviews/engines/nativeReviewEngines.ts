import { listNativeReviewEngines, type NativeReviewEngineId } from '@happier-dev/protocol';

import type { ExecutionRunProfileBoundedCompleteResult } from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';
import type { ExecutionRunBackendFactory } from '@/backends/executionRuns/types';

import { executionRunBackendFactory as coderabbitBackendFactory } from './coderabbit/executionRunBackendFactory';
import { normalizeCodeRabbitPlainReviewOutput } from './coderabbit/normalizeCodeRabbitPlainReviewOutput';

export type NativeReviewOutputNormalizer = (params: Readonly<{
  runId: string;
  callId: string;
  sidechainId: string;
  backendId: string;
  startedAtMs: number;
  finishedAtMs: number;
  rawText: string;
}>) => ExecutionRunProfileBoundedCompleteResult;

const NATIVE_BACKEND_FACTORIES: Record<NativeReviewEngineId, ExecutionRunBackendFactory> = {
  coderabbit: coderabbitBackendFactory,
};

const NATIVE_NORMALIZERS: Record<NativeReviewEngineId, NativeReviewOutputNormalizer> = {
  coderabbit: normalizeCodeRabbitPlainReviewOutput,
};

export function resolveNativeReviewExecutionRunBackendFactory(id: string): ExecutionRunBackendFactory | null {
  const key = String(id ?? '').trim() as NativeReviewEngineId;
  if (!key) return null;
  return Object.prototype.hasOwnProperty.call(NATIVE_BACKEND_FACTORIES, key) ? NATIVE_BACKEND_FACTORIES[key]! : null;
}

export function resolveNativeReviewOutputNormalizer(id: string): NativeReviewOutputNormalizer | null {
  const key = String(id ?? '').trim() as NativeReviewEngineId;
  if (!key) return null;
  return Object.prototype.hasOwnProperty.call(NATIVE_NORMALIZERS, key) ? NATIVE_NORMALIZERS[key]! : null;
}

export function listNativeReviewEngineIds(): readonly string[] {
  return listNativeReviewEngines().map((e) => e.id);
}

