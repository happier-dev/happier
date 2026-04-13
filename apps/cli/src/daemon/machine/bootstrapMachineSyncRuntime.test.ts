import { describe, expect, it, vi } from 'vitest';

import type { Machine } from '@/api/types';
import { createPromptAssetAdapterRegistry } from '@/promptAssets/createPromptAssetAdapterRegistry';
import { createPromptRegistryAdapterRegistry } from '@/promptRegistries/createPromptRegistryAdapterRegistry';
import { DEFAULT_MEMORY_SETTINGS } from '@/settings/memorySettings';

import { buildUnavailableMemoryEmbeddingsDiagnostics } from '../memory/resolveOperationalMemoryEmbeddingsSettings';
import type { MemoryWorkerHandle } from '../memory/memoryWorker';
import type { AutomationWorkerHandle } from '../automation/automationWorker';

import { bootstrapMachineSyncRuntime } from './bootstrapMachineSyncRuntime';
import type { SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';

describe('bootstrapMachineSyncRuntime', () => {
    it('does not start automation or memory workers when machine sync is disabled', async () => {
        const startAutomationWorkerForMachine = vi.fn((): AutomationWorkerHandle => ({
            stop: vi.fn(),
            refreshAssignments: vi.fn(async () => {}),
            pause: vi.fn(),
            resume: vi.fn(),
            handleServerUpdate: vi.fn(),
        }));
        const memoryWorker: MemoryWorkerHandle = {
            stop: vi.fn(),
            reloadSettings: vi.fn(async () => {}),
            ensureUpToDate: vi.fn(async () => {}),
            getSettings: vi.fn(() => DEFAULT_MEMORY_SETTINGS),
            getEmbeddingsDiagnostics: vi.fn(() =>
                buildUnavailableMemoryEmbeddingsDiagnostics(DEFAULT_MEMORY_SETTINGS.embeddings),
            ),
            getTier1DbPath: vi.fn(() => null),
            getDeepDbPath: vi.fn(() => null),
        };
        const startMemoryWorkerForMachine = vi.fn(async (): Promise<MemoryWorkerHandle> => memoryWorker);
        const createConnectedApiMachine = vi.fn(() => null);
        const attachTransferRuntimeStatePublisher = vi.fn(async () => {});
        const machine: Machine = {
            id: 'machine-disabled',
            encryptionKey: new Uint8Array(),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };

        const result = await bootstrapMachineSyncRuntime({
            cliVersion: '0.0.0-test',
            machineId: 'machine-disabled',
            machine,
            preferredHost: 'host.local',
            happyHomeDir: '/tmp/happy-home',
            happyLibDir: '/tmp/happy-lib',
            takeoverRequested: false,
            isShuttingDown: () => false,
            createConnectedApiMachine,
            attachTransferRuntimeStatePublisher,
            startAutomationWorkerForMachine,
            startMemoryWorkerForMachine,
            spawnSession: vi.fn(async (): Promise<SpawnSessionResult> => ({ type: 'success', sessionId: 'sess-1' })),
            stopSession: vi.fn(async () => true),
            isSessionAlreadyRunning: vi.fn(async () => false),
            loadLocalSessionMetadataForHandoff: vi.fn(async () => null),
            savePreparedTargetLocalMetadata: vi.fn(async () => {}),
            beforeShutdown: vi.fn(async () => {}),
            requestShutdown: vi.fn(),
            directPeerServerLifecycle: null,
            directTransferPromptAssetAdapterRegistry: createPromptAssetAdapterRegistry(),
            directTransferPromptRegistryRegistry: createPromptRegistryAdapterRegistry(),
            connectedServiceRefreshLoopHandle: null,
            connectedServiceQuotasLoopHandle: null,
        });

        expect(createConnectedApiMachine).toHaveBeenCalledTimes(1);
        expect(attachTransferRuntimeStatePublisher).not.toHaveBeenCalled();
        expect(startAutomationWorkerForMachine).not.toHaveBeenCalled();
        expect(startMemoryWorkerForMachine).not.toHaveBeenCalled();
        expect(result).toEqual({
            apiMachine: null,
            apiMachineForSessions: null,
            automationWorker: null,
            memoryWorker: null,
            daemonConnectivityCoordinator: null,
            machineConnectionStateCleanup: null,
        });
    });
});
