import type { BackendTargetRefV1 } from '@happier-dev/protocol/backends/targets/backendTargetRef';
import { legacyCustomAcpCompat } from '@happier-dev/agents';

const LEGACY_COMPAT_AGENT_IDS = legacyCustomAcpCompat.LEGACY_COMPAT_AGENT_IDS;
type LegacyCompatAgentId = (typeof LEGACY_COMPAT_AGENT_IDS)[number];

export const LEGACY_COMPAT_PRIMARY_AGENT_ID = LEGACY_COMPAT_AGENT_IDS[0] ?? '';
export const LEGACY_COMPAT_PRIMARY_AGENT_ID_NORMALIZED = LEGACY_COMPAT_PRIMARY_AGENT_ID.toLowerCase();

export function isLegacyCompatAgentType(value: unknown): value is LegacyCompatAgentId {
    return typeof value === 'string'
        && LEGACY_COMPAT_AGENT_IDS.some((agentId) => agentId === value);
}

export function isLegacyCompatBuiltInTarget(target: BackendTargetRefV1 | null | undefined): boolean {
    return target?.kind === 'builtInAgent' && isLegacyCompatAgentType(target.agentId);
}
