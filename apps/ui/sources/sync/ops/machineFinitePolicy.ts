import {
    getMachineFinitePolicyV1,
    mutateMachineFinitePolicyV1,
    type MachineFinitePolicyGetResultV1,
    type MachineFinitePolicyMetadataPortV1,
    type MachineFinitePolicyMutationResultV1,
} from '@happier-dev/protocol/machines/machineFinitePolicyV1';
import {
    decodePlainMachineStoredContent,
    encodePlainMachineStoredContent,
    machineStoredContentMatchesAccountMode,
} from '@happier-dev/protocol/machines/machineStoredContent';
import { MachineUpdateMetadataResponseSchema, type MachineUpdateMetadataResponse } from '@happier-dev/protocol/machines/metadataUpdate';
import { parseMachinePublishedMetadataV1 } from '@happier-dev/protocol/machines/machinePublishedContentV1';

import { apiSocket } from '../api/session/apiSocket';
import { getActiveServerSnapshot } from '../domains/server/serverRuntime';
import { storage } from '../domains/state/storage';
import { MachineMetadataSchema } from '../domains/state/storageTypes';
import { serverFetch } from '../http/client';
import { getSyncSingleton } from '../runtime/getSyncSingleton';
import { readMachineEncryptionContextInput } from '../encryption/machineEncryption';

function createPolicyPort(machineId: string, signal?: AbortSignal, isCredentialCurrent?: () => boolean): MachineFinitePolicyMetadataPortV1 {
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
    const port: MachineFinitePolicyMetadataPortV1 = {
        read: async () => {
            open = null;
            seal = null;
            expectedDataEncryptionKey = undefined;
            isMachineCurrent = () => false;
            if (!isCurrent()) return { status: 'unavailable' };
            const machine = storage.getState().machines[machineId];
            if (!machine || (!machine.storageMode && !machine.access)) return { status: 'unavailable' };
            if (machine.availability?.kind === 'locked') return { status: 'locked' };
            if (machine.access && machine.access.accessState !== 'ready') return { status: 'locked' };
            const mode = machine.access?.resourceMode ?? machine.storageMode!;
            const encryption = getSyncSingleton().encryption;
            const cipher = mode === 'e2ee' ? encryption?.getMachineEncryption(machineId) : null;
            if (mode === 'e2ee' && !cipher) return { status: 'locked' };
            const response = await serverFetch(`/v1/machines/${encodeURIComponent(machineId)}`, { method: 'GET', signal }, {
                expectedActiveServer: { serverId: server.serverId, generation: server.generation },
            });
            if (!response.ok || !isCurrent()) return { status: 'unavailable' };
            const payload: unknown = await response.json();
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
            const localBasis = readMachineEncryptionContextInput(machine, account?.accountId ?? null);
            if (basis.expectedDataEncryptionKey === undefined || basis.dataEncryptionKey !== localBasis.dataEncryptionKey
                || basis.expectedDataEncryptionKey !== localBasis.expectedDataEncryptionKey) return { status: 'locked' };
            if (mode === 'e2ee' && !machineStoredContentMatchesAccountMode({ mode, metadata: raw.metadata, dataEncryptionKey: key })) return { status: 'locked' };
            expectedDataEncryptionKey = basis.expectedDataEncryptionKey;
            isMachineCurrent = () => {
                const current = storage.getState().machines[machineId];
                if (!current || current.availability?.kind === 'locked' || (current.access && current.access.accessState !== 'ready')) return false;
                const currentBasis = readMachineEncryptionContextInput(current, account?.accountId ?? null);
                return currentBasis.dataEncryptionKey === basis.dataEncryptionKey
                    && currentBasis.expectedDataEncryptionKey === basis.expectedDataEncryptionKey
                    && (current.access?.resourceMode ?? current.storageMode) === mode
                    && (mode === 'plain' || (getSyncSingleton().encryption === encryption && encryption?.getMachineEncryption(machineId) === cipher));
            };
            open = mode === 'plain' ? async (value) => decodePlainMachineStoredContent(value) : async (value) => cipher!.decryptRaw(value);
            seal = mode === 'plain' ? async (value) => encodePlainMachineStoredContent(value) : async (value) => cipher!.encryptRaw(value);
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
            if ('error' in answer || answer.result === 'error') return { status: 'unavailable' };
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
    return getMachineFinitePolicyV1(createPolicyPort(machineId, options?.signal, options?.isCredentialCurrent));
}

export async function machineWorkerPolicySet(machineId: string, input: unknown, options?: Readonly<{ signal?: AbortSignal; isCredentialCurrent?: () => boolean }>): Promise<MachineFinitePolicyMutationResultV1> {
    return mutateMachineFinitePolicyV1(input, createPolicyPort(machineId, options?.signal, options?.isCredentialCurrent), options);
}
