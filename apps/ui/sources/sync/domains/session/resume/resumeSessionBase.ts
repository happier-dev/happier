import type { Session } from '@/sync/domains/state/storageTypes';
import type { ResumeSessionOptions } from '@/sync/ops';
import type { ResumeCapabilityOptions } from '@/agents/runtime/resumeCapabilities';
import { canAgentResume, getAgentVendorResumeId } from '@/agents/runtime/resumeCapabilities';
import { getAgentCore, resolveAgentIdFromFlavor } from '@/agents/catalog/catalog';
import type { PermissionModeOverrideForSpawn } from '@/sync/domains/permissions/permissionModeOverride';
import type { ModelOverrideForSpawn } from '@/sync/domains/models/modelOverride';

export type ResumeSessionBaseOptions = Omit<
    ResumeSessionOptions,
    'sessionEncryptionKeyBase64' | 'sessionEncryptionVariant'
>;

export function buildResumeSessionBaseOptionsFromSession(opts: {
    sessionId: string;
    session: Session;
    resumeCapabilityOptions: ResumeCapabilityOptions;
    permissionOverride?: PermissionModeOverrideForSpawn | null;
    modelOverride?: ModelOverrideForSpawn | null;
}): ResumeSessionBaseOptions | null {
    const { sessionId, session, resumeCapabilityOptions, permissionOverride, modelOverride } = opts;

    const machineId = session.metadata?.machineId;
    const directory = session.metadata?.path;
    const flavor = session.metadata?.flavor;
    if (!machineId || !directory || !flavor) return null;

    const agentId = resolveAgentIdFromFlavor(flavor);
    if (!agentId) return null;

    // Note: vendor resume IDs can be missing even for otherwise-resumable sessions.
    // Wake/resume still needs to work (e.g. pending-queue wake) and should attach the vendor id only when present.
    if (!canAgentResume(flavor, resumeCapabilityOptions)) return null;

    const resume = getAgentVendorResumeId(session.metadata, agentId, resumeCapabilityOptions);

    return {
        sessionId,
        machineId,
        directory,
        agent: getAgentCore(agentId).cli.spawnAgent,
        ...(resume ? { resume } : {}),
        ...(permissionOverride ? permissionOverride : {}),
        ...(modelOverride ? modelOverride : {}),
    };
}
