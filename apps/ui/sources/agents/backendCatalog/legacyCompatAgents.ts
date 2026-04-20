import type { BackendTargetRefV1 } from '@happier-dev/protocol';
import { legacyCustomAcpCompat } from '@happier-dev/agents';

type LegacyCompatAgentId = string;

function readLegacyCompatAgentIds(): readonly string[] {
    const raw = (legacyCustomAcpCompat as any)?.LEGACY_COMPAT_AGENT_IDS;
    return Array.isArray(raw) ? raw.filter((id) => typeof id === 'string' && id.trim().length > 0) : [];
}

const LEGACY_COMPAT_AGENT_IDS = readLegacyCompatAgentIds();

// If the agents package is mocked in tests without legacy compat wiring, avoid crashing at import time.
// In production, an empty list simply means there is no legacy compat agent to hide/redirect.
export const LEGACY_COMPAT_PRIMARY_AGENT_ID = (LEGACY_COMPAT_AGENT_IDS[0] ?? '').trim();
export const LEGACY_COMPAT_PRIMARY_AGENT_ID_NORMALIZED = LEGACY_COMPAT_PRIMARY_AGENT_ID.toLowerCase();

export function isLegacyCompatAgentType(value: unknown): value is LegacyCompatAgentId {
    return typeof value === 'string'
        && LEGACY_COMPAT_AGENT_IDS.includes(value);
}

export function isLegacyCompatBuiltInTarget(target: BackendTargetRefV1 | null | undefined): boolean {
    return target?.kind === 'builtInAgent' && isLegacyCompatAgentType(target.agentId);
}
