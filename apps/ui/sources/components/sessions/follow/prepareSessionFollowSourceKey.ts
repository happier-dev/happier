import { isPersistentMachine, type MachineKind } from '@happier-dev/protocol/machines/machineKind';
import { SessionFollowSourceKeyPrepareResponseV1Schema, buildSessionFollowSourceKeyPrepareRequestV1, resolveSessionFollowSourceKeyPreparationFailureV1, type SessionFollowSourceKeyPrepareAuthorizationV1, type SessionFollowSourceKeyPrepareRequestV1, type SessionFollowSourceKeyPreparationResultV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceKeyPreparationV1';
import { supportsMachineSessionFollowContextV1 } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { encodeBase64 } from '@/encryption/base64';
import { resolveServerScopedMachine } from '@/sync/store/domains/machines/resolveServerScopedMachine';
import { storage } from '@/sync/domains/state/storage';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { resolveSessionMachineId } from '@/sync/domains/session/external/resolveSessionMachineId';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { readMachineControlTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import {
    resolveScopedSessionCryptoContext,
    type ScopedSessionCryptoContext,
} from '@/sync/runtime/orchestration/serverScopedRpc/resolveScopedSessionDataKey';
import { resolveServerAccountRequestContext } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerAccountRequestContext';
import { isMachineOnline } from '@/utils/sessions/machineUtils';

export type SessionFollowSourceKeyPreparationResult = SessionFollowSourceKeyPreparationResultV1;

// Only a standalone `e2ee` DEK is transferable; the owner-only historical reader
// (`legacy_fallback`) and `unknown` both leave the source key unavailable.
type SourceCryptoContext = ScopedSessionCryptoContext;

type PreparationContext = Readonly<{
    scope: 'scoped';
    serverId: string;
    accountId: string;
    resolveSourceCrypto: (sessionId: string) => Promise<SourceCryptoContext>;
    release: () => Promise<void>;
}>;

type DestinationMachine = Readonly<{
    machineId: string;
    machine: Readonly<{
        kind?: MachineKind;
        active: boolean;
        activeAt?: number | null;
        revokedAt?: number | null;
        operationProtocolCapabilities?: unknown;
    }>;
}>;

export type PrepareSessionFollowSourceKeyDeps = Readonly<{
    resolveContext: (serverId: string) => Promise<PreparationContext>;
    resolveDestination: (input: Readonly<{
        serverId: string;
        accountId: string;
        sessionId: string;
    }>) => DestinationMachine | null;
    callMachine: (input: Readonly<{
        serverId: string;
        accountId: string;
        machineId: string;
        request: SessionFollowSourceKeyPrepareRequestV1;
        authorization: SessionFollowSourceKeyPrepareAuthorizationV1;
    }>) => Promise<unknown>;
}>;

const defaultDeps: PrepareSessionFollowSourceKeyDeps = {
    resolveContext: async (serverId) => {
        const context = await resolveServerAccountRequestContext({ serverId, preferScoped: true });
        if (context.scope !== 'scoped') throw new Error('Expected scoped Follow preparation context');
        return {
            scope: 'scoped',
            serverId: context.targetServerId,
            accountId: context.targetAccountId,
            resolveSourceCrypto: async (sessionId) => await resolveScopedSessionCryptoContext({
                serverId: context.targetServerId,
                serverUrl: context.targetServerUrl,
                ...(context.runtimeOrigin ? { runtimeOrigin: context.runtimeOrigin } : {}),
                ...(context.homeCarrier ? { homeCarrier: context.homeCarrier } : {}),
                token: context.token,
                sessionId,
                timeoutMs: context.timeoutMs,
                ...(context.encryption ? {
                    decryptEncryptionKey: (value: string) => context.encryption!.decryptEncryptionKey(value),
                } : {}),
            }),
            release: async () => { await context.release?.(); },
        };
    },
    resolveDestination: ({ serverId, accountId, sessionId }) => {
        const state = storage.getState();
        const scopedRow = readSessionListRowForServerId(state.sessionListRowsByServerId, serverId, sessionId);
        const directSession = state.sessions[sessionId];
        const exactMachineId = resolveSessionMachineId(
            scopedRow?.metadata
            ?? (
                directSession && areServerProfileIdentifiersEquivalent(directSession.serverId, serverId)
                    ? readSessionOwnerMetadataView(directSession)
                    : null
            ),
        );
        if (!exactMachineId) return null;
        const target = readMachineControlTargetForSession({ serverId, accountId, sessionId });
        // The control-target owner may resolve a same-locality replacement for
        // ordinary Session operations. A Session Follow DEK is bound to the
        // current exact Runner and must never follow that redirect.
        if (!target || target.machineId !== exactMachineId) return null;
        const machine = resolveServerScopedMachine(state, serverId, exactMachineId);
        return machine ? { machineId: exactMachineId, machine } : null;
    },
    callMachine: async ({ serverId, accountId, machineId, request, authorization }) => (
        await machineRpcWithServerScope({
            serverId,
            accountId,
            machineId,
            method: RPC_METHODS.DAEMON_SESSION_FOLLOW_SOURCE_KEY_PREPARE,
            payload: request,
            authorization,
            // Server admission for this operation is part of the exact route; never
            // bypass it through a direct peer decision made only by the client.
            preferScoped: true,
        })
    ),
};

/**
 * Prepares one already-committed Follow edge for an E2EE ephemeral Runner.
 * Every invocation re-opens the source Session and re-resolves the destination's
 * exact current Machine; no readiness is inferred from edge eligibility.
 */
export async function prepareSessionFollowSourceKey(
    input: Readonly<{ serverId: string; sourceSessionId: string; destinationSessionId: string }>,
    deps: PrepareSessionFollowSourceKeyDeps = defaultDeps,
): Promise<SessionFollowSourceKeyPreparationResult> {
    let context: PreparationContext;
    try {
        context = await deps.resolveContext(input.serverId);
    } catch {
        return { kind: 'waiting', reason: 'runner_unreachable' };
    }

    try {
        const sourceCrypto = await context.resolveSourceCrypto(input.sourceSessionId);
        if (sourceCrypto.encryptionMode === 'plain') return { kind: 'not_needed' };
        if (sourceCrypto.encryptionMode !== 'e2ee') {
            return { kind: 'waiting', reason: 'source_key_unavailable' };
        }

        const destination = deps.resolveDestination({
            serverId: context.serverId,
            accountId: context.accountId,
            sessionId: input.destinationSessionId,
        });
        if (!destination) return { kind: 'waiting', reason: 'runner_unreachable' };
        if (isPersistentMachine(destination.machine)) return { kind: 'not_needed' };
        if (!isMachineOnline(destination.machine)) return { kind: 'waiting', reason: 'runner_unreachable' };
        if (!supportsMachineSessionFollowContextV1(destination.machine.operationProtocolCapabilities)) {
            return { kind: 'waiting', reason: 'unsupported' };
        }

        const { authorization, request } = buildSessionFollowSourceKeyPrepareRequestV1({
            sourceSessionId: input.sourceSessionId,
            destinationSessionId: input.destinationSessionId,
            sourceDataEncryptionKeyBase64: encodeBase64(sourceCrypto.sessionDataKey),
        });
        try {
            const response = await deps.callMachine({
                serverId: context.serverId,
                accountId: context.accountId,
                machineId: destination.machineId,
                request,
                authorization,
            });
            SessionFollowSourceKeyPrepareResponseV1Schema.parse(response);
            return { kind: 'prepared' };
        } catch (error) {
            return resolveSessionFollowSourceKeyPreparationFailureV1(error);
        }
    } finally {
        try {
            await context.release();
        } catch {
            // The operation result is already decided; scoped transport cleanup
            // cannot turn a receiver ACK into an unprepared edge.
        }
    }
}
