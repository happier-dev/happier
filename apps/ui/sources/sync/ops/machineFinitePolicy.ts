import {
    getMachineFinitePolicyV1,
    mutateMachineFinitePolicyV1,
    type MachineFinitePolicyGetResultV1,
    type MachineFinitePolicyMutationResultV1,
} from '@happier-dev/protocol/machines/machineFinitePolicyV1';
import {
    decodePlainMachineStoredContent,
    encodePlainMachineStoredContent,
    machineStoredContentMatchesAccountMode,
} from '@happier-dev/protocol/machines/machineStoredContent';
import { MachineUpdateMetadataResponseSchema, type MachineUpdateMetadataResponse } from '@happier-dev/protocol/machines/metadataUpdate';
import { mutateMachineMetadataFieldV1, type MachineMetadataFieldPortV1 } from '@happier-dev/protocol/machines/machineMetadataFieldV1';
import type { MachineMetadataUpdateInputSchema } from '@happier-dev/protocol/actions/specs/machineConnection';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { z } from 'zod/mini';
import { parseMachinePublishedMetadataV1 } from '@happier-dev/protocol/machines/machinePublishedContentV1';

import { apiSocket } from '../api/session/apiSocket';
import { getActiveServerSnapshot } from '../domains/server/serverRuntime';
import { storage } from '../domains/state/storage';
import { MachineMetadataSchema } from '../domains/state/storageTypes';
import { serverFetch } from '../http/client';
import { getSyncSingleton } from '../runtime/getSyncSingleton';
import { MACHINE_ENCRYPT_RAW_ATTRIBUTION_EVENTS, measureMachineEncryptRawAttribution, readMachineEncryptionContextInput } from '../encryption/machineEncryption';
import { runWithServerRequestAuthorityForServerAccountScope } from '../runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { readMachineRows } from '../api/machines/machineRowsApi';

function createMachineMetadataFieldPort(machineId: string, options?: Readonly<{
    signal?: AbortSignal;
    isCredentialCurrent?: () => boolean;
    fresh?: boolean;
    useObservedMetadata?: boolean;
    onRefusal?: (failure: Extract<MachineUpdateMetadataResponse, { error: string }>) => void;
}>): MachineMetadataFieldPortV1 {
    const { signal, isCredentialCurrent, fresh } = options ?? {};
    let useObservedMetadata = options?.useObservedMetadata === true;
    const server = getActiveServerSnapshot();
    const account = storage.getState().profileScope;
    let open: ((value: string) => Promise<unknown>) | null = null;
    let seal: ((value: unknown) => Promise<string>) | null = null;
    let expectedDataEncryptionKey: string | null | undefined;
    let isMachineCurrent = () => false;
    const isCurrent = () => {
        const currentServer = getActiveServerSnapshot();
        const currentAccount = storage.getState().profileScope;
        return !signal?.aborted && isCredentialCurrent?.() !== false && !!account && currentServer.serverId === server.serverId
            && currentServer.generation === server.generation && currentAccount?.serverId === account.serverId
            && currentAccount.accountId === account.accountId;
    };
    const readOpened = async (metadata: string) => {
        const value = await open!(metadata);
        const parsed = MachineMetadataSchema.safeParse(value);
        if (!parsed.success || !value || typeof value !== 'object' || Array.isArray(value)) return null;
        return parsed.data;
    };
    const port: MachineMetadataFieldPortV1 = {
        read: async () => {
            open = null;
            seal = null;
            expectedDataEncryptionKey = undefined;
            isMachineCurrent = () => false;
            if (!account || !isCurrent()) return { status: 'unavailable' };
            const machine = storage.getState().machines[machineId];
            if (!machine || (!machine.storageMode && !machine.access)) return { status: 'unavailable' };
            if (machine.availability?.kind === 'locked') return { status: 'locked' };
            if (machine.access && machine.access.accessState !== 'ready') return { status: 'locked' };
            const mode = machine.access?.resourceMode ?? machine.storageMode!;
            const encryption = getSyncSingleton().encryption;
            const cipher = mode === 'e2ee' ? encryption?.getMachineEncryption(machineId) : null;
            if (mode === 'e2ee' && !cipher) return { status: 'locked' };
            const localBasis = readMachineEncryptionContextInput(machine, account.accountId);
            if (localBasis.expectedDataEncryptionKey === undefined) return { status: 'locked' };
            expectedDataEncryptionKey = localBasis.expectedDataEncryptionKey;
            isMachineCurrent = () => {
                const current = storage.getState().machines[machineId];
                if (!current || current.availability?.kind === 'locked' || (current.access && current.access.accessState !== 'ready')) return false;
                const currentBasis = readMachineEncryptionContextInput(current, account?.accountId ?? null);
                return currentBasis.dataEncryptionKey === localBasis.dataEncryptionKey
                    && currentBasis.expectedDataEncryptionKey === localBasis.expectedDataEncryptionKey
                    && (current.access?.resourceMode ?? current.storageMode) === mode
                    && (mode === 'plain' || (getSyncSingleton().encryption === encryption && encryption?.getMachineEncryption(machineId) === cipher));
            };
            open = mode === 'plain' ? async (value) => decodePlainMachineStoredContent(value) : async (value) => cipher!.decryptRaw(value);
            seal = mode === 'plain' ? async (value) => encodePlainMachineStoredContent(value) : async (value) => measureMachineEncryptRawAttribution(MACHINE_ENCRYPT_RAW_ATTRIBUTION_EVENTS.metadataWrite,
                () => cipher!.encryptRaw(value));
            if (useObservedMetadata) {
                useObservedMetadata = false;
                if (machine.metadata) return { status: 'ready', metadata: machine.metadata, metadataVersion: machine.metadataVersion };
            }
            const payload: unknown = await runWithServerRequestAuthorityForServerAccountScope({ scope: account, activeRequest: serverFetch }, async authority => {
                if (!isCurrent()) return null;
                if (authority.readTransport) {
                    const row = (await readMachineRows({ readTransport: authority.readTransport, machineIds: [machineId], signal, fresh })).get(machineId);
                    return row ? { machine: row } : null;
                }
                const response = await authority.request(`/v1/machines/${encodeURIComponent(machineId)}`, { method: 'GET', signal });
                return response.ok ? await response.json() as unknown : null;
            });
            if (!isCurrent() || payload === null) return { status: 'unavailable' };
            if (!payload || typeof payload !== 'object' || !('machine' in payload)) return { status: 'invalid' };
            const raw = payload.machine;
            if (!raw || typeof raw !== 'object' || !('id' in raw) || raw.id !== machineId
                || !('metadata' in raw) || typeof raw.metadata !== 'string'
                || !('metadataVersion' in raw) || typeof raw.metadataVersion !== 'number'
                || !Number.isSafeInteger(raw.metadataVersion) || raw.metadataVersion < 0) return { status: 'invalid' };
            const key = 'dataEncryptionKey' in raw ? raw.dataEncryptionKey : undefined;
            if (key !== undefined && key !== null && typeof key !== 'string') return { status: 'invalid' };
            const basis = readMachineEncryptionContextInput({
                dataEncryptionKey: key,
                ...('keyBasis' in raw ? { keyBasis: raw.keyBasis } : {}),
                ...('access' in raw ? { access: raw.access } : {}),
            }, account?.accountId ?? null);
            if (basis.expectedDataEncryptionKey === undefined || basis.dataEncryptionKey !== localBasis.dataEncryptionKey
                || basis.expectedDataEncryptionKey !== localBasis.expectedDataEncryptionKey) return { status: 'locked' };
            if (mode === 'e2ee' && !machineStoredContentMatchesAccountMode({ mode, metadata: raw.metadata, dataEncryptionKey: key })) return { status: 'locked' };
            const metadata = await readOpened(raw.metadata);
            if (!isCurrent() || !isMachineCurrent()) return { status: 'unavailable' };
            return metadata ? { status: 'ready', metadata, metadataVersion: raw.metadataVersion } : { status: 'invalid' };
        },
        compareAndSwap: async ({ metadata, expectedMetadataVersion }) => {
            if (!isCurrent() || !isMachineCurrent() || !open || !seal || expectedDataEncryptionKey === undefined) return { status: 'unavailable' };
            const stored = await seal(parseMachinePublishedMetadataV1(metadata));
            if (!isCurrent() || !isMachineCurrent()) return { status: 'unavailable' };
            const response = await apiSocket.emitWithAck<MachineUpdateMetadataResponse>('machine-update-metadata', {
                machineId, metadata: stored, expectedVersion: expectedMetadataVersion, expectedDataEncryptionKey,
            });
            const parsed = MachineUpdateMetadataResponseSchema.safeParse(response);
            if (!parsed.success) return { status: 'outcomeUnknown' };
            const answer = parsed.data;
            // A verified success receipt belongs to this captured invoker even
            // after retirement. Other answers cannot authorize fresh reads then.
            if ((!isCurrent() || !isMachineCurrent()) && ('error' in answer || answer.result !== 'success')) return { status: 'outcomeUnknown' };
            if ('error' in answer) {
                options?.onRefusal?.(answer);
                return { status: 'unavailable' };
            }
            if (answer.result === 'error') return { status: 'unavailable' };
            if (answer.result === 'key-mismatch') {
                await getSyncSingleton().refreshMachines();
                const latest = await port.read();
                return latest.status === 'ready'
                    ? { status: 'conflict', metadata: latest.metadata, metadataVersion: latest.metadataVersion }
                    : { status: 'unavailable' };
            }
            const opened = await readOpened(answer.metadata);
            if (!opened) return { status: 'outcomeUnknown' };
            const currentMachine = storage.getState().machines[machineId];
            if (isCurrent() && isMachineCurrent() && currentMachine && answer.version >= currentMachine.metadataVersion) {
                storage.getState().applyMachines([{ ...currentMachine, metadata: MachineMetadataSchema.parse(opened), metadataVersion: answer.version }]);
            }
            return { status: answer.result === 'success' ? 'applied' : 'conflict', metadata: opened, metadataVersion: answer.version };
        },
    };
    return port;
}

export async function machineWorkerPolicyGet(machineId: string, options?: Readonly<{ signal?: AbortSignal; isCredentialCurrent?: () => boolean }>): Promise<MachineFinitePolicyGetResultV1> {
    return getMachineFinitePolicyV1(createMachineMetadataFieldPort(machineId, options));
}

export async function machineWorkerPolicySet(machineId: string, input: unknown, options?: Readonly<{ signal?: AbortSignal; isCredentialCurrent?: () => boolean }>): Promise<MachineFinitePolicyMutationResultV1> {
    return mutateMachineFinitePolicyV1(input, createMachineMetadataFieldPort(machineId, { ...options, fresh: true }), options);
}

type EditableMachineMetadata = z.infer<typeof MachineMetadataUpdateInputSchema>['patch'];

/** Rename and Windows launch mode share one field-scoped, atomic update. */
export async function machineUpdateMetadata(
    machineId: string,
    patch: EditableMachineMetadata,
    expectedVersion: number,
    signal?: AbortSignal,
): Promise<{ version: number }> {
    const observed = storage.getState().machines[machineId]?.metadata;
    if (!observed) throw Object.assign(new Error('Machine metadata unavailable'), { code: 'machine_metadata_unavailable' });
    const editsDisplayName = patch.displayName !== undefined;
    const editsLaunchMode = patch.windowsRemoteSessionLaunchMode !== undefined;
    const project = (metadata: Record<string, unknown>) => ({
        ...(editsDisplayName ? { displayName: metadata.displayName } : {}),
        ...(editsLaunchMode ? { windowsRemoteSessionLaunchMode: metadata.windowsRemoteSessionLaunchMode,
            windowsRemoteSessionConsole: metadata.windowsRemoteSessionConsole } : {}),
    });
    const policy = {
        ...(editsDisplayName ? { displayName: patch.displayName?.trim() || undefined } : {}),
        ...(editsLaunchMode ? { windowsRemoteSessionLaunchMode: patch.windowsRemoteSessionLaunchMode ?? undefined,
            windowsRemoteSessionConsole: undefined } : {}),
    };
    let refusal: Extract<MachineUpdateMetadataResponse, { error: string }> | undefined;
    const port = createMachineMetadataFieldPort(machineId, {
        signal, fresh: true, useObservedMetadata: true,
        onRefusal: failure => { refusal = failure; },
    });
    const result = await mutateMachineMetadataFieldV1({
        expectedMetadataVersion: expectedVersion, expectedPolicy: project(observed), policy, comparison: 'field',
    }, port, {
        project,
        apply: (metadata, next) => ({ ...metadata, ...next }),
        equal: (a, b) => sameStrictJsonValue(a, b, { omitUndefinedObjectMembers: true }),
    }, { signal });
    if (result.status === 'applied' || result.status === 'satisfied' || result.status === 'unchanged') {
        return { version: result.metadataVersion };
    }
    if (refusal) throw Object.assign(new Error('Machine metadata update requires a compatible client.'), {
        code: refusal.error, retryable: false, requirement: refusal.requirement,
    });
    const code = result.status === 'conflict' ? 'machine_metadata_conflict'
        : result.status === 'outcomeUnknown' ? 'action_outcome_unknown' : 'machine_metadata_unavailable';
    throw Object.assign(new Error(code), { code });
}
