import type { CapabilitiesDetectRequest } from '@/sync/api/capabilities/capabilitiesProtocol';
import {
    AGENT_IDS,
    buildMachineDetailsCapabilitiesDetectRequest,
} from '@happier-dev/agents';
import { CHECKLIST_IDS } from '@happier-dev/protocol/checklists';
import { buildProviderCliCapabilityId } from './cliCapabilityId';
import { getInstallablesRegistryEntries } from './installablesRegistry';

export const CAPABILITIES_REQUEST_NEW_SESSION: CapabilitiesDetectRequest = {
    checklistId: CHECKLIST_IDS.NEW_SESSION,
};

export const CAPABILITIES_REQUEST_MACHINE_DETAILS = buildMachineDetailsCapabilitiesDetectRequest();

/**
 * What the Updates surface asks each online machine while it is open: every agent CLI with its
 * latest version (K6) and every helper installable that has its own latest-version check.
 */
export function buildUpdatesCapabilitiesRequest(installableRequests: readonly CapabilitiesDetectRequest[]): CapabilitiesDetectRequest {
    return {
        requests: [
            ...AGENT_IDS.map((agentId) => ({ id: buildProviderCliCapabilityId(agentId), params: { includeLatestVersion: true } })),
            // K5: whether this daemon can update its own CLI (`cli.update.v1` among the kinds).
            { id: 'tool.systemTasks' as const },
            ...installableRequests.flatMap((request) => request.requests ?? []),
        ],
    };
}

/**
 * The update-facts request every Updates owner sends (the background owner, the open surface's
 * refresh) and the one Updates coverage is measured against: every agent CLI with its latest
 * version, every helper's latest-version check, the task kinds.
 */
export function buildMachineUpdateFactsRequest(): CapabilitiesDetectRequest {
    const installables = getInstallablesRegistryEntries().filter((entry) => entry.shouldPrefetchLatestVersion({}));
    return buildUpdatesCapabilitiesRequest(installables.map((entry) => entry.buildLatestVersionDetectRequest()));
}
