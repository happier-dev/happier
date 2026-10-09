import { MachineAccessRecipientCensusResponseV1Schema, MachineAccessRefusalV1Schema, MachineRecipientKeyEnvelopeCommitInputV1Schema, MachineRecipientKeyEnvelopeCommitResponseV1Schema, type MachineAccessRecipientCensusResponseV1, type MachineKeyPreparationResultV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import { MachineDataKeyPreparationErrorV1 } from '@happier-dev/protocol/machines/prepareMachineDataKeyEnvelopesV1';
import { MachineContentKeyTransitionResultV1Schema, MachinePublishedRowV1Schema } from '@happier-dev/protocol/machines/machineContentKeyTransitionV1';
import { AccountEncryptionModeResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import { computeMachineOwnerEnvelopeFingerprintV1 } from '@happier-dev/protocol/machines/machineOwnerEnvelopeFingerprintV1';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { runSessionDataKeyPreparationDetached } from '@happier-dev/protocol/sessions/encryption/sessionDataKeyPreparationPass';
import { serverAccountScopedResourceKey, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { captureEncryptionGenerationCurrentness } from '@/sync/encryption/encryption';
import { prepareCurrentMachineDataKeyEnvelopes } from '@/sync/encryption/prepareCurrentMachineDataKeyEnvelopes';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { runWithServerAccountScopeRequestGuard } from '@/sync/runtime/orchestration/serverScopedRpc/serverAccountScopeRequestGuard';

/** One captured Home/Account authority owns the entire physical continuation. */
export async function prepareMachineDataKeyEnvelopesForScope(params: Readonly<{
    scope: ServerAccountScope;
    machineId: string;
    isCurrent?: () => boolean;
    signal?: AbortSignal;
    /** Trusted lifecycle dependency, never a public grant/Action parameter. */
    resolveTransferableMachineDataKey?: (page: MachineAccessRecipientCensusResponseV1) => Promise<Uint8Array | null>;
}>): Promise<MachineKeyPreparationResultV1> {
    try {
        return await runWithServerAccountScopeRequestGuard({
            scope: params.scope, isCurrent: params.isCurrent, signal: params.signal,
            staleError: () => new MachineDataKeyPreparationErrorV1('machine_key_changed'),
        }, guard => runWithServerRequestAuthorityForServerAccountScope({
            scope: params.scope,
            activeRequest: async () => { throw new MachineDataKeyPreparationErrorV1('machine_key_changed'); },
        }, async authority => {
            guard.check();
            const encryptionCurrent = captureEncryptionGenerationCurrentness(authority.context.encryption);
            const isCurrent = () => guard.isCurrent() && encryptionCurrent.isCurrent();
            const path = `/v1/machines/${encodeURIComponent(params.machineId)}/data-key-envelopes`;
            const request = async (requestPath: string, init?: RequestInit): Promise<unknown> => {
                guard.check();
                if (!isCurrent()) throw new MachineDataKeyPreparationErrorV1('machine_key_changed');
                const response = await authority.request(requestPath, { ...init, signal: guard.signal });
                guard.check();
                const payload: unknown = await response.json();
                guard.check();
                if (!isCurrent()) throw new MachineDataKeyPreparationErrorV1('machine_key_changed');
                const refusal = MachineAccessRefusalV1Schema.safeParse(payload);
                if (refusal.success) throw new MachineDataKeyPreparationErrorV1(refusal.data.code);
                if (!response.ok) throw new MachineDataKeyPreparationErrorV1(
                    response.status === 401 || response.status === 403 ? 'access_denied'
                        : response.status === 404 || response.status === 405 || response.status === 501 ? 'unsupported_operation' : 'machine_unavailable',
                );
                return payload;
            };
            let preparedOwner: Awaited<ReturnType<NonNullable<typeof authority.context.encryption>['prepareMachineContentKey']>> | null = null;
            const observeMachine = async () => {
                const payload = await request(`/v1/machines/${encodeURIComponent(params.machineId)}`);
                if (!payload || typeof payload !== 'object' || !('machine' in payload)) throw new MachineDataKeyPreparationErrorV1('machine_unavailable');
                return payload.machine;
            };
            const encryption = authority.context.encryption;
            return prepareCurrentMachineDataKeyEnvelopes({
                serverId: authority.scope.serverId, machineId: params.machineId,
                isHostScopeCurrent: isCurrent,
                ...(!params.resolveTransferableMachineDataKey && encryption ? {
                    ownerPreparation: {
                        accountId: authority.scope.accountId,
                        observeMachine,
                        prepareContentKey: async () => {
                            const accountMode = AccountEncryptionModeResponseSchema.parse(await request('/v1/account/encryption')).mode;
                            preparedOwner = await encryption.prepareMachineContentKey({ machineId: params.machineId,
                                custodianAccountId: authority.scope.accountId, accountMode, isCurrent, signal: guard.signal,
                                observe: async () => MachinePublishedRowV1Schema.parse(await observeMachine()),
                                transition: async input => MachineContentKeyTransitionResultV1Schema.parse(await request(`/v1/machines/${encodeURIComponent(params.machineId)}/content-key/transition`, {
                                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
                                })),
                            });
                        },
                    },
                } : {}),
                resolveTransferableMachineDataKey: async page => {
                    if (params.resolveTransferableMachineDataKey) return params.resolveTransferableMachineDataKey(page);
                    // The authenticated Manage worklist owns permission and currentness. Foreign
                    // tuples only exist after conditional recipient delivery. The custodian's
                    // envelope instead uses the same C40 provenance decision as owner conversion.
                    if (!page.callerDataEncryptionKey || !encryption) return null;
                    if (authority.scope.accountId === page.custodianAccountId) {
                        if (!preparedOwner || preparedOwner.encryptionMode !== 'e2ee' || !preparedOwner.encryptionKey
                            || preparedOwner.row.dataEncryptionKey !== page.callerDataEncryptionKey
                            || preparedOwner.row.metadataVersion !== page.content.metadataVersion || preparedOwner.row.daemonStateVersion !== page.content.daemonStateVersion
                            || computeMachineOwnerEnvelopeFingerprintV1(decodeBase64(page.callerDataEncryptionKey)) !== page.machineOwnerEnvelopeFingerprint) {
                            throw new MachineDataKeyPreparationErrorV1('machine_key_changed');
                        }
                        return preparedOwner.encryptionKey;
                    }
                    return await authority.context.encryption?.decryptEncryptionKey(page.callerDataEncryptionKey) ?? null;
                },
                transport: {
                    fetchPage: async cursor => {
                        const query = new URLSearchParams({ state: 'action_required' });
                        if (cursor) query.set('cursor', cursor);
                        return MachineAccessRecipientCensusResponseV1Schema.parse(await request(`${path}?${query}`));
                    },
                    patchPage: async input => {
                        const { machineId: _machineId, ...body } = MachineRecipientKeyEnvelopeCommitInputV1Schema.parse(input);
                        return MachineRecipientKeyEnvelopeCommitResponseV1Schema.parse(await request(path, {
                            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
                        }));
                    },
                },
            });
        }));
    } catch (error) {
        return { kind: 'unavailable', code: error instanceof MachineDataKeyPreparationErrorV1 ? error.code : 'machine_unavailable' };
    }
}

/** Machine invalidation reuses the existing in-flight pass owner, never a second queue. */
export function prepareMachineDataKeyEnvelopesDetachedForScope(
    params: Parameters<typeof prepareMachineDataKeyEnvelopesForScope>[0],
): Promise<MachineKeyPreparationResultV1> {
    return runSessionDataKeyPreparationDetached(
        serverAccountScopedResourceKey(params.scope, 'machine-data-key-envelopes', params.machineId),
        () => prepareMachineDataKeyEnvelopesForScope(params),
    );
}
