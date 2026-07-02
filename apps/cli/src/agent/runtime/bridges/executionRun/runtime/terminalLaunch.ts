import {
  isExecutionRunHostRuntime,
  type ExecutionRunHostRuntime,
} from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import { createExecutionRunHostRuntimeFromRuntimeTurnOperations } from '@/agent/runtime/bridges/executionRun/hostRuntimeFromTurnOps';
import { isRuntimeTurnOperations, type RuntimeTurnOperations } from '@/agent/runtime/turns/runtimeTurnOperations';
import { normalizePublishedRuntimeFacetsV1 } from '@/agent/runtime/facets/runtimeFacetsPublication';
import type { ResolvedBackendContribution } from '@/plugins/projection/registry/types';
import type {
  RuntimeDescriptorV1,
  AgentRuntimeFacetsV1,
} from '@happier-dev/protocol';
import { readRuntimeDescriptorV1 } from '@happier-dev/protocol';

type NormalizedTerminalRuntimeLaunchResult = Readonly<{
  runtime: ExecutionRunHostRuntime;
  startedSessionId: string | null;
  runtimeDescriptor: RuntimeDescriptorV1 | null;
  runtimeCapabilities: unknown;
  runtimeFacets: AgentRuntimeFacetsV1 | null;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTerminalRuntimeExecutionRunInput(value: unknown): value is ExecutionRunHostRuntime | RuntimeTurnOperations {
  return isExecutionRunHostRuntime(value) || isRuntimeTurnOperations(value);
}

function coerceTerminalRuntimeExecutionRun(runtime: ExecutionRunHostRuntime | RuntimeTurnOperations): ExecutionRunHostRuntime {
  if (isExecutionRunHostRuntime(runtime)) {
    return runtime;
  }
  return createExecutionRunHostRuntimeFromRuntimeTurnOperations(runtime);
}

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function buildTerminalRuntimeDescriptor(backend: ResolvedBackendContribution): RuntimeDescriptorV1 | null {
  const runtimeKind = normalizeNonEmptyString(backend.runtimeKind);
  if (!runtimeKind) return null;

  return {
    v: 1,
    providerId: backend.providerId,
    provider: {
      backendMode: runtimeKind,
      providerExtra: {
        owner: 'happier',
        schemaId: 'happier.pluginRuntimeDescriptorExtra',
        v: 1,
        runtimeHandle: {
          backendId: backend.id,
          providerId: backend.providerId,
          provenance: backend.provenance,
          source: backend.source,
        },
      },
    },
  };
}

export function normalizeTerminalRuntimeLaunchResult(params: Readonly<{
  result: unknown;
  backend: ResolvedBackendContribution;
}>): NormalizedTerminalRuntimeLaunchResult {
  if (isTerminalRuntimeExecutionRunInput(params.result)) {
    return {
      runtime: coerceTerminalRuntimeExecutionRun(params.result),
      startedSessionId: null,
      runtimeDescriptor: buildTerminalRuntimeDescriptor(params.backend),
      runtimeCapabilities: null,
      runtimeFacets: null,
    };
  }

  if (!isRecord(params.result)) {
    throw new Error('Terminal runtime launch must return an object payload');
  }

  const runtimeValue = params.result.runtime;
  if (!isTerminalRuntimeExecutionRunInput(runtimeValue)) {
    throw new Error('Terminal runtime launch payload must include an execution-run runtime surface');
  }

  const startedSessionId = normalizeNonEmptyString(params.result.sessionId);
  const runtimeDescriptor = readRuntimeDescriptorV1(params.result.runtimeDescriptor)
    ?? buildTerminalRuntimeDescriptor(params.backend);
  return {
    runtime: coerceTerminalRuntimeExecutionRun(runtimeValue),
    startedSessionId: startedSessionId ?? null,
    runtimeDescriptor,
    runtimeCapabilities: params.result.runtimeCapabilities ?? null,
    runtimeFacets: normalizePublishedRuntimeFacetsV1(params.result.runtimeFacets),
  };
}
