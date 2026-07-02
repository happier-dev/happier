import type { CatalogAgentLookupId } from '@/backends/types';

import { resolveAgentCliRuntimeSpecForLookupId } from './requireProviderCliCommand';

export function buildProviderCliUnavailableMessage(params: Readonly<{
  agentId: CatalogAgentLookupId;
  resolvedCommand?: string | null;
  alternativeCommandHint?: string | null;
}>): string {
  const runtimeSpec = resolveAgentCliRuntimeSpecForLookupId(params.agentId);
  const setupGuideUrl = runtimeSpec.installGuideUrl ?? runtimeSpec.docsUrl ?? null;
  const resolvedCommand = typeof params.resolvedCommand === 'string' ? params.resolvedCommand.trim() : '';
  const alternativeCommandHint = typeof params.alternativeCommandHint === 'string'
    ? params.alternativeCommandHint.trim()
    : '';

  return [
    `${runtimeSpec.title} not found or not executable${resolvedCommand ? `: ${resolvedCommand}` : ''}`,
    '',
    `Install ${runtimeSpec.title} via the Happier provider settings or add "${runtimeSpec.binaryName}" to PATH.`,
    ...(setupGuideUrl ? ['', `Setup guide: ${setupGuideUrl}`] : []),
    ...(alternativeCommandHint ? ['', alternativeCommandHint] : []),
  ].join('\n');
}
