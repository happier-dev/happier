import type { ExecutionRunBackendDescriptor, ExecutionRunBackendFactory } from './executionRunBackendTypes';
import { executionRunBackendFactory as coderabbitExecutionRunBackendFactory } from '@/agent/reviews/engines/coderabbit/executionRunBackendFactory';
import { runCodeRabbitReviewStartPreflight } from '@/agent/reviews/engines/coderabbit/runCodeRabbitReviewStartPreflight';

const REGISTRY: Record<string, ExecutionRunBackendDescriptor> = {
  coderabbit: {
    factory: coderabbitExecutionRunBackendFactory,
    startPreflight: runCodeRabbitReviewStartPreflight,
  },
};

export function resolveExecutionRunBackendDescriptor(backendId: string): ExecutionRunBackendDescriptor | null {
  const key = String(backendId ?? '').trim();
  if (!key) return null;
  return Object.prototype.hasOwnProperty.call(REGISTRY, key) ? REGISTRY[key]! : null;
}

export function resolveExecutionRunBackendFactory(backendId: string): ExecutionRunBackendFactory | null {
  return resolveExecutionRunBackendDescriptor(backendId)?.factory ?? null;
}

// Preferred name: matches plan terminology and makes call sites self-describing.
export function getExecutionRunBackendFactory(backendId: string): ExecutionRunBackendFactory | null {
  return resolveExecutionRunBackendFactory(backendId);
}

export function getExecutionRunBackendDescriptor(backendId: string): ExecutionRunBackendDescriptor | null {
  return resolveExecutionRunBackendDescriptor(backendId);
}
