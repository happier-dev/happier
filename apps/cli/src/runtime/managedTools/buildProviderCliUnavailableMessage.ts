import { getProviderCliInstallGuideUrl, getProviderCliRuntimeSpec, type AgentId } from '@happier-dev/agents';

export function buildProviderCliUnavailableMessage(params: Readonly<{
  agentId: AgentId;
  resolvedCommand?: string | null;
  alternativeCommandHint?: string | null;
}>): string {
  const runtimeSpec = getProviderCliRuntimeSpec(params.agentId);
  const setupGuideUrl = getProviderCliInstallGuideUrl(params.agentId);
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
