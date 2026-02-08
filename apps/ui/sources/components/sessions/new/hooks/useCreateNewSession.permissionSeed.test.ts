import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import type { PermissionMode, ModelMode } from '@/sync/permissionTypes';
import type { Settings } from '@/sync/settings';
import type { UseMachineEnvPresenceResult } from '@/hooks/useMachineEnvPresence';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type SpawnPayloadCapture = {
    permissionMode?: string;
    permissionModeUpdatedAt?: number;
} | null;

async function setupUseCreateNewSessionHarness() {
    const captured: { value: SpawnPayloadCapture } = { value: null };

    vi.doMock('@/text', () => ({ t: (key: string) => key }));
    vi.doMock('@/modal', () => ({
        Modal: {
            alert: vi.fn(),
            confirm: vi.fn(async () => false),
        },
    }));
    vi.doMock('@/sync/sync', () => ({
        sync: {
            applySettings: vi.fn(),
            decryptSecretValue: vi.fn(),
            refreshSessions: vi.fn(),
            sendMessage: vi.fn(),
        },
    }));
    vi.doMock('@/sync/storage', () => ({
        storage: {
            getState: () => ({ settings: {} }),
        },
    }));
    vi.doMock('@/sync/terminalSettings', () => ({
        resolveTerminalSpawnOptions: vi.fn(() => null),
    }));
    vi.doMock('@/hooks/useMachineCapabilitiesCache', () => ({
        getMachineCapabilitiesSnapshot: () => ({ supported: true, response: { protocolVersion: 1, results: {} } }),
        prefetchMachineCapabilities: vi.fn(async () => {}),
    }));
    vi.doMock('@/agents/catalog', async () => {
        const actual = await vi.importActual<typeof import('@/agents/catalog')>('@/agents/catalog');
        return {
            ...actual,
            getAgentCore: vi.fn(() => ({ model: { supportsSelection: false } })),
            buildSpawnEnvironmentVariablesFromUiState: vi.fn((opts: { environmentVariables?: Record<string, string> }) => opts.environmentVariables),
            buildSpawnSessionExtrasFromUiState: vi.fn(() => ({})),
            getAgentResumeExperimentsFromSettings: vi.fn(() => ({})),
            getNewSessionPreflightIssues: vi.fn(() => []),
            getResumeRuntimeSupportPrefetchPlan: vi.fn(() => null),
            buildResumeCapabilityOptionsFromUiState: vi.fn(() => ({})),
        };
    });
    vi.doMock('@/agents/acpRuntimeResume', () => ({
        describeAcpLoadSessionSupport: vi.fn(() => ({ kind: 'unknown' })),
    }));
    vi.doMock('@/agents/resumeCapabilities', () => ({
        canAgentResume: vi.fn(() => false),
    }));
    vi.doMock('@/components/sessions/new/modules/formatResumeSupportDetailCode', () => ({
        formatResumeSupportDetailCode: vi.fn(() => ''),
    }));
    vi.doMock('@/sync/ops', () => ({
        machineSpawnNewSession: vi.fn(async (opts: unknown) => {
            captured.value = opts as SpawnPayloadCapture;
            return { type: 'error', errorCode: 'unexpected', errorMessage: 'stop' } as const;
        }),
    }));

    const { useCreateNewSession } = await import('./useCreateNewSession');
    return { useCreateNewSession, captured };
}

describe('useCreateNewSession permission seeding', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-02-05T00:00:00.000Z'));
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('passes a canonical permission mode and timestamp into machineSpawnNewSession', async () => {
        const { useCreateNewSession, captured } = await setupUseCreateNewSessionHarness();

        let handleCreateSession: null | (() => Promise<void>) = null;
        const settings = { experiments: false } as unknown as Settings;
        const machineEnvPresence: UseMachineEnvPresenceResult = {
            isPreviewEnvSupported: false,
            isLoading: false,
            meta: {},
            refreshedAt: null,
            refresh: () => {},
        };

        function Test() {
            const hook = useCreateNewSession({
                router: { push: vi.fn(), replace: vi.fn() },
                selectedMachineId: 'm1',
                selectedPath: '/tmp',
                selectedMachine: { metadata: {} },
                setIsCreating: vi.fn(),
                setIsResumeSupportChecking: vi.fn(),
                sessionType: 'simple',
                settings,
                useProfiles: false,
                selectedProfileId: null,
                profileMap: new Map(),
                recentMachinePaths: [],
                agentType: 'codex',
                permissionMode: 'acceptEdits' as unknown as PermissionMode,
                modelMode: 'default' as ModelMode,
                sessionPrompt: '',
                resumeSessionId: '',
                agentNewSessionOptions: null,
                machineEnvPresence,
                secrets: [],
                secretBindingsByProfileId: {},
                selectedSecretIdByProfileIdByEnvVarName: {},
                sessionOnlySecretValueByProfileIdByEnvVarName: {},
                selectedMachineCapabilities: null,
            });

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        act(() => {
            renderer.create(React.createElement(Test));
        });

        await act(async () => {
            await handleCreateSession?.();
        });

        expect(captured.value).not.toBeNull();
        expect(captured.value?.permissionMode).toBe('safe-yolo');
        expect(typeof captured.value?.permissionModeUpdatedAt).toBe('number');
        expect(Number.isFinite(captured.value?.permissionModeUpdatedAt)).toBe(true);
        expect((captured.value?.permissionModeUpdatedAt ?? 0)).toBeGreaterThan(0);
    });
});
