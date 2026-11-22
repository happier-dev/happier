import { INSTALLABLE_KEYS } from '@happier-dev/protocol/installables';

import type { AgentUiBehavior, NewSessionRelevantInstallableDepsContext } from '@/agents/registry/registryUiBehavior';

/** Only connected accounts run the pinned ACP server; native login runs the separately installed `agy` CLI. */
export function getAgyNewSessionRelevantInstallableDepKeys(ctx: NewSessionRelevantInstallableDepsContext): readonly string[] {
    if (ctx.agentId !== 'agy') return [];
    return ctx.connectedServices?.bindingsByServiceId.antigravity?.source === 'connected' ? [INSTALLABLE_KEYS.AGY_ACP_SERVER] : [];
}

export const AGY_UI_BEHAVIOR_OVERRIDE: AgentUiBehavior = {
    newSession: {
        getRelevantInstallableDepKeys: getAgyNewSessionRelevantInstallableDepKeys,
    },
};
