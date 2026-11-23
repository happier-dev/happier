import { areSameAgentRoutingIdentity, type BundledAgentId } from '@happier-dev/agents';

import type { AgentLocalAuthPlugin } from '@/agents/catalog/localAuth/agentLocalAuthPlugin';
import { createCatalogAgentLocalAuthPlugin } from '@/agents/catalog/localAuth/createCatalogAgentLocalAuthPlugin';
import { CANONICAL_AGENT_IDS } from '@/agents/registry/registryCore';

export const AGENT_LOCAL_AUTH_PLUGINS: readonly AgentLocalAuthPlugin[] = CANONICAL_AGENT_IDS
    .flatMap((agentId) => {
        const plugin = createCatalogAgentLocalAuthPlugin(agentId);
        return plugin ? [plugin] : [];
    });

export function getAgentLocalAuthPlugin(agentId: string | null | undefined): AgentLocalAuthPlugin | null {
    const normalized = String(agentId ?? '').trim().toLowerCase();
    if (!normalized) return null;
    return AGENT_LOCAL_AUTH_PLUGINS.find((plugin) => String(plugin.agentId ?? '').trim().toLowerCase() === normalized) ?? null;
}

// These are terminal prompts from the bundled Agents' native sign-in commands.
const deviceCodePrompts = [
    ['codex', /^(?:2\. )?Enter this one-time code \(expires in [0-9]+ minutes\)\r?\n[ \t]*([A-Z0-9]+-[A-Z0-9]+)\r?\n/m],
    ['copilot', /^! (?:First copy your one-time code: ([A-Z0-9]+-[A-Z0-9]+)|One-time code \(([A-Z0-9]+-[A-Z0-9]+)\) copied to clipboard)\r?\n/m],
] as const satisfies readonly (readonly [BundledAgentId, RegExp])[];

export function readAgentSignInDeviceCode(agentId: string, preview: string): string | null {
    const prompt = deviceCodePrompts.find(([id]) => areSameAgentRoutingIdentity(id, agentId));
    if (!prompt) return null;
    const match = prompt[1].exec(preview.replace(/\u001b\[[0-9;]*m/g, ''));
    return match?.[1] ?? match?.[2] ?? null;
}
