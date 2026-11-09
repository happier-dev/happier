import { MachineAccessRecipientCensusResponseV1Schema, MachineAccessRefusalV1Schema, MachineRecipientKeyEnvelopeCommitInputV1Schema, MachineRecipientKeyEnvelopeCommitResponseV1Schema, type MachineAccessRecipientCensusResponseV1, type MachineKeyPreparationResultV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import { isMachineRetiredForKeyPreparationV1, MachineDataKeyPreparationErrorV1 } from '@happier-dev/protocol/machines/prepareMachineDataKeyEnvelopesV1';
import { MachineContentKeyTransitionResultV1Schema, MachinePublishedRowV1Schema, type MachinePublishedRowV1 } from '@happier-dev/protocol/machines/machineContentKeyTransitionV1';
import { readAccountE2eeCustody } from '@/auth/storage/tokenStorage';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import { computeMachineOwnerEnvelopeFingerprintV1 } from '@happier-dev/protocol/machines/machineOwnerEnvelopeFingerprintV1';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { runSessionDataKeyPreparationDetached } from '@happier-dev/protocol/sessions/encryption/sessionDataKeyPreparationPass';
import { serverAccountScopedResourceKey, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { captureEncryptionGenerationCurrentness } from '@/sync/encryption/encryption';
import { prepareCurrentMachineDataKeyEnvelopes } from '@/sync/encryption/prepareCurrentMachineDataKeyEnvelopes';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { runWithServerAccountScopeRequestGuard } from '@/sync/runtime/orchestration/serverScopedRpc/serverAccountScopeRequestGuard';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { FetchedMachineRow } from '@/sync/engine/machines/syncMachines';

/** One captured Home/Account authority owns the entire physical continuation. */
export async function prepareMachineDataKeyEnvelopesForScope(params: Readonly<{
    scope: ServerAccountScope;
    machineId: string;
    /** First observation from this scope's authenticated list; never a warm display row. */
    initialMachineRow?: MachinePublishedRowV1;
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
            let observedOwner: ReturnType<typeof MachinePublishedRowV1Schema.parse> | null = null;
            let initialMachineRow = params.initialMachineRow;
            const observeMachine = async () => {
                guard.check();
                if (!isCurrent()) throw new MachineDataKeyPreparationErrorV1('machine_key_changed');
                // C40 admits the exact published basis and conditional transition;
                // the fresh recipient census separately reauthorizes delivery.
                // Consume the list observation once so conflict/unknown outcomes
                // always read the Home again.
                const payload = initialMachineRow === undefined
                    ? await request(`/v1/machines/${encodeURIComponent(params.machineId)}`)
                    : { machine: initialMachineRow };
                initialMachineRow = undefined;
                if (!payload || typeof payload !== 'object' || !('machine' in payload)) throw new MachineDataKeyPreparationErrorV1('machine_unavailable');
                observedOwner = MachinePublishedRowV1Schema.parse(payload.machine);
                return observedOwner;
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
                            preparedOwner = await encryption.prepareMachineContentKey({ machineId: params.machineId,
                                custodianAccountId: authority.scope.accountId, isCurrent, signal: guard.signal,
                                accountE2eeCustody: readAccountE2eeCustody(authority.context.credentials ?? { token: authority.context.token }),
                                readAccountMode: async () => {
                                    guard.check();
                                    const result = await fetchAccountEncryptionMode(authority.context.credentials ?? { token: authority.context.token }, {
                                        request: authority.request, signal: guard.signal, usage: 'identity',
                                    });
                                    guard.check();
                                    if (!isCurrent()) throw new MachineDataKeyPreparationErrorV1('machine_key_changed');
                                    return result.mode;
                                },
                                observe: async () => {
                                    // The owner lifecycle has just admitted this exact row.
                                    // Consume it once; conflict/unknown-outcome observations
                                    // still read the Home afresh before accepting a winner.
                                    if (observedOwner) {
                                        const row = observedOwner;
                                        observedOwner = null;
                                        return row;
                                    }
                                    const row = await observeMachine();
                                    observedOwner = null;
                                    return row;
                                },
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

type MachineRecipientPreparationInput = Pick<Machine, 'id' | 'dataEncryptionKey' | 'keyBasis'
    | 'access' | 'storageMode' | 'revokedAt' | 'replacedByMachineId'>
    & Pick<FetchedMachineRow, 'recipientWorkPending' | 'recipientWorkCursor'>;

function recipientPreparationInputs(machine: MachineRecipientPreparationInput, recipientChangeCursor: number | undefined) {
    return { callerDataEncryptionKey: machine.dataEncryptionKey,
        ownerDataEncryptionKey: machine.keyBasis?.dataEncryptionKey ?? machine.dataEncryptionKey,
        custodianAccountId: machine.access?.custodian.accountId, role: machine.access?.role,
        accessState: machine.access?.accessState, resourceMode: machine.access?.resourceMode,
        storageMode: machine.storageMode, revokedAt: machine.revokedAt,
        recipientWorkPending: machine.recipientWorkPending,
        recipientChangeCursor: recipientChangeCursor ?? null };
}

const machineRecipientPreparations = new Map<string, Readonly<{
    inputs: ReturnType<typeof recipientPreparationInputs>;
    isCurrent: () => boolean;
    result: Promise<void>;
}> & { invalidated: boolean; unprepared: boolean }>();

/** Refresh admission is keyed by owner-envelope/access/mode inputs and recipient-access change cursors,
 * not presence or row sequence. Only successful preparation is retained across reads; failed/pending
 * work remains retryable by the next admitted census (a recipient's missing Account binding can be
 * repaired without a Machine edit). Display/hydration publication is not new recipient demand.
 * Explicit Actions still use the fresh scoped owner above. */
export async function prepareMachineDataKeyEnvelopesForMachines(params: Readonly<{
    scope: ServerAccountScope;
    machines: readonly MachineRecipientPreparationInput[];
    publishedRows?: readonly FetchedMachineRow[];
    recipientChangeCursors: ReadonlyMap<string, number>;
    isCurrent: () => boolean;
}>): Promise<void> {
    for (const [key, entry] of machineRecipientPreparations) {
        if (!entry.isCurrent()) machineRecipientPreparations.delete(key);
    }
    const publishedRows = new Map(params.publishedRows?.map(row => [row.id, row]));
    await Promise.all(params.machines.map(async machine => {
        const key = serverAccountScopedResourceKey(params.scope, 'machine-data-key-envelopes', machine.id);
        if (isMachineRetiredForKeyPreparationV1(machine)
            || machine.access?.role !== 'manage' || machine.access.accessState !== 'ready' || machine.access.resourceMode !== 'e2ee') {
            const previous = machineRecipientPreparations.get(key);
            if (previous) previous.invalidated = true;
            return;
        }
        const publishedRow = publishedRows.get(machine.id);
        const pending = publishedRow?.recipientWorkPending ?? machine.recipientWorkPending;
        const rowCursor = publishedRow?.recipientWorkCursor ?? machine.recipientWorkCursor;
        const changeCursor = params.recipientChangeCursors.get(machine.id);
        const cursor = rowCursor === undefined ? changeCursor : changeCursor === undefined ? rowCursor : Math.max(rowCursor, changeCursor);
        const inputs = recipientPreparationInputs({ ...machine, recipientWorkPending: pending }, cursor);
        const previous = machineRecipientPreparations.get(key);
        const recipientChanged = previous !== undefined && previous.inputs.recipientChangeCursor !== inputs.recipientChangeCursor;
        if (previous) {
            if (!previous.invalidated && sameStrictJsonValue(previous.inputs, inputs)
                && !previous.unprepared) return previous.result;
            // A changed recipient input must not be mistaken for the old in-flight result.
            await previous.result;
            if (!params.isCurrent()) return;
            if (machineRecipientPreparations.get(key) !== previous) {
                return prepareMachineDataKeyEnvelopesForMachines({ ...params, machines: [machine] });
            }
        }
        if (!params.isCurrent()) return;
        // Only an explicit server answer proves no recipient work; an absent fact runs the exact pass.
        if (pending === false && !recipientChanged) {
            machineRecipientPreparations.set(key, { inputs, isCurrent: params.isCurrent, result: Promise.resolve(),
                invalidated: false, unprepared: false });
            return;
        }
        const initialMachineRow = publishedRow ? MachinePublishedRowV1Schema.parse({ ...publishedRow,
            daemonState: publishedRow.daemonState ?? null, daemonStateVersion: publishedRow.daemonStateVersion ?? 0 }) : undefined;
        const result: Promise<void> = prepareMachineDataKeyEnvelopesDetachedForScope({ scope: params.scope, machineId: machine.id,
            ...(initialMachineRow ? { initialMachineRow } : {}),
            isCurrent: params.isCurrent }).then(prepared => {
            if (prepared.kind !== 'prepared') entry.unprepared = true;
            if (entry.invalidated || !params.isCurrent()) {
                if (machineRecipientPreparations.get(key) === entry) machineRecipientPreparations.delete(key);
            }
        }).catch((error: unknown) => {
            if (machineRecipientPreparations.get(key) === entry) machineRecipientPreparations.delete(key);
            throw error;
        });
        const entry = { inputs, isCurrent: params.isCurrent, result, invalidated: false, unprepared: false };
        machineRecipientPreparations.set(key, entry);
        await result;
    }));
}
