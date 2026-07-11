import type { CatalogAgentLookupId } from '@/agent/catalog/ids';

import { resolveAgentCliRuntimeSpecForLookupId } from './requireAgentCliCommand';

export function buildAgentCliUnavailableMessage(params: Readonly<{
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
    `Install ${runtimeSpec.title} via the Happier agent settings or add "${runtimeSpec.binaryName}" to PATH.`,
    ...(setupGuideUrl ? ['', `Setup guide: ${setupGuideUrl}`] : []),
    ...(alternativeCommandHint ? ['', alternativeCommandHint] : []),
  ].join('\n');
}
