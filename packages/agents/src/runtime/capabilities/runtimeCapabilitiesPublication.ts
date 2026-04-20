import type { RuntimeCapabilities } from './runtimeCapabilities.js';

export function publishRuntimeCapabilities(
  params: Readonly<Partial<RuntimeCapabilities>>,
): RuntimeCapabilities {
  return {
    ...(typeof params.localControl !== 'undefined' ? { localControl: params.localControl } : {}),
    ...(typeof params.sessionStorage !== 'undefined' ? { sessionStorage: params.sessionStorage } : {}),
    ...(typeof params.sessionCapabilities !== 'undefined' ? { sessionCapabilities: params.sessionCapabilities } : {}),
    ...(typeof params.tools !== 'undefined' ? { tools: params.tools } : {}),
    ...(typeof params.handoff !== 'undefined' ? { handoff: params.handoff } : {}),
    executionRun: params.executionRun ?? null,
  };
}
