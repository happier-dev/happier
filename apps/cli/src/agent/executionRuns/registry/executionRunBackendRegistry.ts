import { listNativeReviewEngineDescriptors } from '@/agent/reviews/engines/nativeReviewEngines';
import type { ExecutionRunBackendDescriptor, ExecutionRunBackendFactory } from './executionRunBackendTypes';

const REGISTRY: Record<string, ExecutionRunBackendDescriptor> = {
};

for (const descriptor of listNativeReviewEngineDescriptors()) {
  REGISTRY[descriptor.id] = { factory: descriptor.executionRunBackendFactory };
}

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
