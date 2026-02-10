import type { AgentId } from '@happier-dev/agents';

export function assertBackendEnabledByAccountSettings(params: Readonly<{
  agentId: AgentId;
  settings: Record<string, unknown>;
}>): void {
  const backendEnabledById = (params.settings as any)?.backendEnabledById as unknown;
  if (!backendEnabledById || typeof backendEnabledById !== 'object' || Array.isArray(backendEnabledById)) return;

  const enabled = (backendEnabledById as any)?.[params.agentId] as unknown;
  if (enabled === false) {
    throw new Error(`${params.agentId} is disabled in your account settings (enable it in the UI provider settings).`);
  }
}

