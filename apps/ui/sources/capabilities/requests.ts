import type { CapabilitiesDetectRequest } from '@/sync/api/capabilities/capabilitiesProtocol';
import {
    AGENT_PROVIDER_IDS,
    getAgentLocalCliConfig,
    type AgentId,
    isAgentAuthProbeSafeForBackgroundChecks,
} from '@happier-dev/agents';
import { CHECKLIST_IDS } from '@happier-dev/protocol/checklists';

const CLI_PROBE_AGENT_IDS = AGENT_PROVIDER_IDS;

function buildCliLoginStatusOverrides(): Record<string, { params: { includeLoginStatus: true } }> {
    const overrides: Record<string, { params: { includeLoginStatus: true } }> = {};
    for (const agentId of CLI_PROBE_AGENT_IDS) {
        if (!isAgentAuthProbeSafeForBackgroundChecks(agentId)) continue;
        overrides[`cli.${getAgentLocalCliConfig(agentId).detectKey}`] = { params: { includeLoginStatus: true } };
    }
    return overrides;
}

export const CAPABILITIES_REQUEST_NEW_SESSION: CapabilitiesDetectRequest = {
    checklistId: CHECKLIST_IDS.NEW_SESSION,
};

export const CAPABILITIES_REQUEST_MACHINE_DETAILS: CapabilitiesDetectRequest = {
    checklistId: CHECKLIST_IDS.MACHINE_DETAILS,
    overrides: buildCliLoginStatusOverrides() as any,
};
