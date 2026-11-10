import { MachineLiveStreamPayloadErrorV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/payloadV1';

import { readAccountE2eeCustody } from '@/auth/storage/tokenStorage';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import { resolveRunnerMachineContentKeyTrustV1 } from '@/sync/domains/machines/runnerMachineContentKeyTrust';
import type { ResolvedMachineLiveStreamContent } from '@/sync/domains/machines/peer/mediation/stream/socketTransport';

import { createServerRequestForExplicitServerScope } from './createServerRequestWithServerScope';
import { resolveScopedMachineTransport } from './serverScopedRpcPool';
import type { ScopedServerRpcContext } from './serverScopedRpcTypes';
import { resolveScopedSessionCryptoContext, initializeScopedSessionReader } from './resolveScopedSessionDataKey';

/** Streams open content under their admitted Session or Machine scope, including cold reads. */
export async function resolveMachineLiveStreamContent(
    context: Pick<ScopedServerRpcContext, 'machineId' | 'targetServerId' | 'targetServerUrl' | 'targetAccountId'
        | 'runtimeOrigin' | 'homeCarrier' | 'token' | 'credentials' | 'encryption' | 'readTransport' | 'accountEncryptionObservation'> & Readonly<{ timeoutMs?: number }>,
    sessionId?: string,
): Promise<ResolvedMachineLiveStreamContent> {
    const machineId = context.machineId;
    const credentials = context.credentials ?? { token: context.token };
    if (sessionId) {
        const encryption = context.encryption;
        const crypto = await resolveScopedSessionCryptoContext({ sessionId, serverId: context.targetServerId,
            serverUrl: context.targetServerUrl, runtimeOrigin: context.runtimeOrigin, homeCarrier: context.homeCarrier,
            token: context.token, credentials, timeoutMs: context.timeoutMs, readTransport: context.readTransport,
            ...(encryption ? { decryptEncryptionKey: (value: string) => encryption.decryptEncryptionKey(value,
                { serverId: context.targetServerId, workClass: 'interactive' }) } : {}) });
        if (crypto.encryptionMode === 'plain') return { mode: 'plain' };
        if (!encryption || !await initializeScopedSessionReader({ sessionId, serverId: context.targetServerId,
            context: crypto, encryption })) throw new MachineLiveStreamPayloadErrorV1('stream_encryption_material_unavailable');
        const cipher = encryption.getSessionEncryption(sessionId);
        if (!cipher) throw new MachineLiveStreamPayloadErrorV1('stream_encryption_material_unavailable');
        return { mode: 'e2ee', cipher, isCurrent: () => encryption.getSessionEncryption(sessionId) === cipher };
    }
    const trust = context.encryption ? await resolveRunnerMachineContentKeyTrustV1({
        credentials, homeServerIdentityId: context.targetServerId, machineId,
    }) : null;
    const machine = await resolveScopedMachineTransport({
        serverId: context.targetServerId, serverUrl: context.targetServerUrl,
        runtimeOrigin: context.runtimeOrigin, homeCarrier: context.homeCarrier,
        token: context.token, machineId, accountId: context.targetAccountId,
        accountE2eeCustody: readAccountE2eeCustody(credentials),
        readTransport: context.readTransport,
        readAccountMode: async () => (await fetchAccountEncryptionMode(credentials, {
            request: createServerRequestForExplicitServerScope({
                serverUrl: context.targetServerUrl, token: context.token,
                serverId: context.targetServerId, credentials,
                accountEncryptionObservation: context.accountEncryptionObservation,
                runtimeOrigin: context.runtimeOrigin, homeCarrier: context.homeCarrier, timeoutMs: context.timeoutMs,
            }),
            usage: 'identity',
        })).mode,
        expectedRunnerBinding: trust?.expectedRunnerBinding,
        trustedMachineKind: trust?.trustedMachineKind, timeoutMs: context.timeoutMs,
        ...(context.encryption ? { encryption: context.encryption,
            decryptEncryptionKey: (value: string) => context.encryption!.decryptEncryptionKey(value) } : {}),
    });
    if (!machine) throw new MachineLiveStreamPayloadErrorV1('stream_payload_mode_mismatch');
    const isMachineCurrent = () => machine.context?.isCurrent() !== false;
    if (machine.mode === 'plain') {
        context.encryption?.removeMachineEncryption(machineId);
        return { mode: 'plain', isCurrent: isMachineCurrent };
    }
    if (!context.encryption || !trust) throw new MachineLiveStreamPayloadErrorV1('stream_encryption_material_unavailable');
    const encryption = context.encryption;
    await encryption.initializeMachines(new Map([[machineId, machine.dataKey]]), undefined, { isMachineCurrent });
    const cipher = encryption.getMachineEncryption(machineId);
    if (!cipher || !isMachineCurrent()) throw new MachineLiveStreamPayloadErrorV1('stream_encryption_material_unavailable');
    return { mode: 'e2ee', cipher,
        isCurrent: () => isMachineCurrent() && encryption.getMachineEncryption(machineId) === cipher };
}
