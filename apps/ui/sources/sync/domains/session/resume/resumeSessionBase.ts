import type { Session } from '@/sync/domains/state/storageTypes';
import type { ResumeSessionOptions } from '@/sync/ops';
import type { ResumeCapabilityOptions } from '@/agents/runtime/resumeCapabilities';
import { canResumeSessionWithOptions, getAgentVendorResumeId } from '@/agents/runtime/resumeCapabilities';
import { deriveAcpBackendIdFromFlavor } from '@/agents/runtime/acpFlavor';
import { getAgentCore, resolveAgentIdFromFlavor } from '@/agents/catalog/catalog';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import type { PermissionModeOverrideForSpawn } from '@/sync/domains/permissions/permissionModeOverride';
import type { ModelOverrideForSpawn } from '@/sync/domains/models/modelOverride';
import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';

export type ResumeSessionBaseOptions = ResumeSessionOptions;

type ResumeSessionTargetOverride = Readonly<{
    machineId?: string | null;
    directory?: string | null;
}>;

function normalizeNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function buildResumeSessionBaseOptionsFromSession(opts: {
    sessionId: string;
    session: Session;
    resumeCapabilityOptions: ResumeCapabilityOptions;
    resumeTargetOverride?: ResumeSessionTargetOverride | null;
    permissionOverride?: PermissionModeOverrideForSpawn | null;
    modelOverride?: ModelOverrideForSpawn | null;
}): ResumeSessionBaseOptions | null {
    const { sessionId, session, resumeCapabilityOptions, resumeTargetOverride, permissionOverride, modelOverride } = opts;

    const reachableTarget = readMachineTargetForSession(sessionId);
    const machineId = normalizeNonEmptyString(resumeTargetOverride?.machineId)
        ?? normalizeNonEmptyString(reachableTarget?.machineId)
        ?? normalizeNonEmptyString(session.metadata?.machineId);
    const directory = normalizeNonEmptyString(resumeTargetOverride?.directory)
        ?? normalizeNonEmptyString(reachableTarget?.basePath)
        ?? normalizeNonEmptyString(session.metadata?.path);
    const flavor = session.metadata?.flavor;
    if (!machineId || !directory) return null;

    const configuredAcpBackendIdFromMetadata =
        typeof session.metadata?.acpConfiguredBackendV1?.backendId === 'string'
            ? session.metadata.acpConfiguredBackendV1.backendId.trim()
            : '';
    const configuredAcpBackendIdFromFlavor = deriveAcpBackendIdFromFlavor(flavor);
    const configuredAcpBackendId =
        configuredAcpBackendIdFromFlavor !== null
            ? (configuredAcpBackendIdFromMetadata.length > 0 ? configuredAcpBackendIdFromMetadata : configuredAcpBackendIdFromFlavor)
            : null;

    // Note: vendor resume IDs can be missing even for otherwise-resumable sessions.
    // Wake/resume still needs to work (e.g. pending-queue wake) and should attach the vendor id only when present.
    if (!canResumeSessionWithOptions(session.metadata, resumeCapabilityOptions)) return null;

    if (configuredAcpBackendId !== null) {
        return {
            sessionId,
            machineId,
            directory,
            backendTarget: { kind: 'configuredAcpBackend', backendId: configuredAcpBackendId },
            ...(permissionOverride ? permissionOverride : {}),
            ...(modelOverride ? modelOverride : {}),
        };
    }

    const agentId = resolveAgentIdFromSessionMetadata(session.metadata) ?? resolveAgentIdFromFlavor(flavor);
    if (!agentId) return null;

    const resume = getAgentVendorResumeId(session.metadata, agentId, resumeCapabilityOptions);

    return {
        sessionId,
        machineId,
        directory,
        backendTarget: { kind: 'builtInAgent', agentId: getAgentCore(agentId).cli.spawnAgent },
        ...(resume ? { resume } : {}),
        ...(session.metadata?.agentRuntimeDescriptorV1 ? { agentRuntimeDescriptorV1: session.metadata.agentRuntimeDescriptorV1 } : {}),
        ...(permissionOverride ? permissionOverride : {}),
        ...(modelOverride ? modelOverride : {}),
    };
}
