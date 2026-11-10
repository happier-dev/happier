import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import { resolvePortableServerIdentityForRoutingId } from '@/sync/domains/server/resolvePortableServerIdentityForRoutingId';

/** Exact Agent/Machine destination shared by admitted attempts and passive Settings. */
export type VoiceAttemptRecoveryRuntimeTarget = Readonly<{
    agentId: string;
    pluginId: string;
    machineId: string;
    serverIdentityId: string;
}>;

export function resolveVoiceAttemptRecoveryRuntimeTarget(input: Readonly<{
    agentRuntime: Readonly<{ localId: string; pluginId: string }> | null;
    serverId: unknown;
    machineId: unknown;
}>): VoiceAttemptRecoveryRuntimeTarget | null {
    const agentId = normalizeNonEmptyString(input.agentRuntime?.localId);
    const pluginId = normalizeNonEmptyString(input.agentRuntime?.pluginId);
    const machineId = normalizeNonEmptyString(input.machineId);
    const serverIdentityId = resolvePortableServerIdentityForRoutingId(normalizeNonEmptyString(input.serverId));
    return agentId && pluginId && machineId && serverIdentityId ? { agentId, pluginId, machineId, serverIdentityId } : null;
}
