import type { AgentSessionModel } from '@happier-dev/plugin-sdk/agents/runtime';

/** Muse owns capability evidence for both native and gateway model descriptors.
 * Catalog membership, limits and offered options remain observations of each source.
 */
export function resolveMuseModelCapabilities(
  modelId: string,
  modelOptions?: AgentSessionModel['modelOptions'],
): NonNullable<AgentSessionModel['capabilities']> {
  return {
    // Neither catalog establishes a model's tool round-trip contract.
    toolRoundTrips: 'unknown',
    reasoningControls: modelOptions?.some(option => option.id === 'reasoning_effort'
      && option.type === 'select' && (option.options?.length ?? 0) > 0) ? 'supported' : 'unknown',
    // Meta's JSON-schema contract, verified via CLIProxyAPI v8.0.61 with
    // this exact contributor model (2026-11-16). Unknown models stay unknown.
    ...(modelId === 'muse-spark-1.3-contributor' ? { structuredOutput: 'supported' } : {}),
  };
}

/** Both catalogs identify the exact Meta model, including any contributor suffix. */
export function resolveMuseModelUpstreamRef(modelId: string): NonNullable<AgentSessionModel['upstreamRef']> {
  return { vendor: 'meta', vendorModelId: modelId };
}
