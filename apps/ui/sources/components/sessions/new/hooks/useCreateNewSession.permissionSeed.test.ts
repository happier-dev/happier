import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import type { PermissionMode, ModelMode } from '@/sync/domains/permissions/permissionTypes';
import type { Settings } from '@/sync/domains/settings/settings';
import type { NewSessionAutomationDraft } from '@/sync/domains/automations/automationDraft';
import type { UseMachineEnvPresenceResult } from '@/hooks/machine/useMachineEnvPresence';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type SpawnPayloadCapture = {
    serverId?: string;
    permissionMode?: string;
    permissionModeUpdatedAt?: number;
} | null;

type AutomationCreateCapture = {
    name: string;
    enabled: boolean;
    schedule: { kind: string; everyMs?: number };
    targetType: 'new_session' | 'existing_session';
    templateCiphertext: string;
    assignments?: Array<{ machineId: string; enabled?: boolean; priority?: number }>;
} | null;

async function setupUseCreateNewSessionHarness() {
    const captured: { value: SpawnPayloadCapture } = { value: null };
    const automationCaptured: { value: AutomationCreateCapture } = { value: null };
    const encryptRawSpy = vi.fn(async (value: unknown) => {
        return `cipher:${Buffer.from(JSON.stringify(value)).toString('base64')}`;
    });
    const modalAlertSpy = vi.fn((..._args: unknown[]) => {});
    const modalConfirmSpy = vi.fn(async () => false);
    const setActiveServerSpy = vi.fn((..._args: unknown[]) => {});
    const switchConnectionToActiveServerSpy = vi.fn(async (..._args: unknown[]) => ({ token: 'next-token', secret: 'next-secret' }));
    const refreshMachinesSpy = vi.fn(async () => {});
    const refreshSessionsSpy = vi.fn(async () => {});
    const refreshAutomationsSpy = vi.fn(async () => {});
    const getMachineCapabilitiesSnapshotSpy = vi.fn(() => ({ supported: true, response: { protocolVersion: 1, results: {} } }));
    const prefetchMachineCapabilitiesSpy = vi.fn(async () => {});
    const syncSendMessageSpy = vi.fn(async () => {});
    const machineSpawnNewSessionSpy = vi.fn<(...args: unknown[]) => Promise<any>>(async (...args: unknown[]) => {
        const opts = args[0] as SpawnPayloadCapture;
        captured.value = opts;
        return { type: 'error', errorCode: 'unexpected', errorMessage: 'stop' };
    });

    vi.doMock('@/text', () => ({ t: (key: string) => key }));
    vi.doMock('@/modal', () => ({
        Modal: {
            alert: modalAlertSpy,
            confirm: modalConfirmSpy,
        },
    }));
    vi.doMock('@/sync/sync', () => ({
        sync: {
            applySettings: vi.fn(),
            createAutomation: vi.fn(async (input: AutomationCreateCapture) => {
                automationCaptured.value = input;
                return { id: 'auto_1', ...input };
            }),
            encryption: {
                encryptRaw: encryptRawSpy,
                encryptAutomationTemplateRaw: encryptRawSpy,
            },
            decryptSecretValue: vi.fn(),
            refreshAutomations: refreshAutomationsSpy,
            refreshSessions: refreshSessionsSpy,
            refreshMachines: refreshMachinesSpy,
            sendMessage: syncSendMessageSpy,
        },
    }));
    vi.doMock('@/sync/domains/state/storage', () => ({
        storage: {
            getState: () => ({
                settings: {},
                machines: { m1: { id: 'm1' } },
                updateSessionPermissionMode: vi.fn(),
                updateSessionModelMode: vi.fn(),
                updateSessionDraft: vi.fn(),
            }),
        },
    }));
    vi.doMock('@/sync/domains/state/persistence', () => ({
        clearNewSessionDraft: vi.fn(),
    }));
    vi.doMock('@/sync/domains/server/serverRuntime', () => ({
        getActiveServerSnapshot: vi.fn(() => ({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            kind: 'custom',
            generation: 1,
        })),
        setActiveServer: setActiveServerSpy,
    }));
    vi.doMock('@/sync/runtime/orchestration/connectionManager', () => ({
        switchConnectionToActiveServer: switchConnectionToActiveServerSpy,
    }));
    vi.doMock('@/sync/domains/settings/terminalSettings', () => ({
        resolveTerminalSpawnOptions: vi.fn(() => null),
    }));
    vi.doMock('@/hooks/server/useMachineCapabilitiesCache', () => ({
        getMachineCapabilitiesSnapshot: getMachineCapabilitiesSnapshotSpy,
        prefetchMachineCapabilities: prefetchMachineCapabilitiesSpy,
    }));
    vi.doMock('@/agents/catalog/catalog', async () => {
        const actual = await vi.importActual<typeof import('@/agents/catalog/catalog')>('@/agents/catalog/catalog');
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
    vi.doMock('@/agents/runtime/acpRuntimeResume', () => ({
        describeAcpLoadSessionSupport: vi.fn(() => ({ kind: 'unknown' })),
    }));
    vi.doMock('@/agents/runtime/resumeCapabilities', () => ({
        canAgentResume: vi.fn(() => false),
    }));
    vi.doMock('@/components/sessions/new/modules/formatResumeSupportDetailCode', () => ({
        formatResumeSupportDetailCode: vi.fn(() => ''),
    }));
    vi.doMock('@/sync/ops', () => ({
        machineSpawnNewSession: (...args: unknown[]) => machineSpawnNewSessionSpy(...args),
    }));

    const { useCreateNewSession } = await import('./useCreateNewSession');
    return {
        useCreateNewSession,
        captured,
        automationCaptured,
        encryptRawSpy,
        modalAlertSpy,
        modalConfirmSpy,
        setActiveServerSpy,
        switchConnectionToActiveServerSpy,
        refreshMachinesSpy,
        refreshAutomationsSpy,
        getMachineCapabilitiesSnapshotSpy,
        prefetchMachineCapabilitiesSpy,
        syncSendMessageSpy,
        machineSpawnNewSessionSpy,
    };
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
                targetServerId: null,
                allowedTargetServerIds: ['server-a'],
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

    it('routes spawn to the target server without switching global active server', async () => {
        const {
            useCreateNewSession,
            getMachineCapabilitiesSnapshotSpy,
            captured,
        } = await setupUseCreateNewSessionHarness();

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
                targetServerId: 'server-b',
                allowedTargetServerIds: ['server-a', 'server-b'],
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

        expect(captured.value?.serverId).toBe('server-b');
        expect(getMachineCapabilitiesSnapshotSpy).toHaveBeenCalledWith('m1', 'server-b');
    });

    it('falls back to active server when targetServerId is outside the allowed target server IDs', async () => {
        const {
            useCreateNewSession,
            modalAlertSpy,
            captured,
        } = await setupUseCreateNewSessionHarness();

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
                targetServerId: 'server-c',
                allowedTargetServerIds: ['server-a'],
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

        expect(modalAlertSpy).not.toHaveBeenCalledWith('common.error', 'newSession.serverSelectionUnavailable');
        expect(captured.value).not.toBeNull();
        expect(captured.value?.serverId).toBe('server-a');
    });

    it('creates an automation instead of spawning immediately when automation mode is enabled', async () => {
        const { useCreateNewSession, captured, automationCaptured, refreshAutomationsSpy } = await setupUseCreateNewSessionHarness();

        let handleCreateSession: null | (() => Promise<void>) = null;
        const routerPush = vi.fn();
        const routerReplace = vi.fn();
        const settings = { experiments: false } as unknown as Settings;
        const machineEnvPresence: UseMachineEnvPresenceResult = {
            isPreviewEnvSupported: false,
            isLoading: false,
            meta: {},
            refreshedAt: null,
            refresh: () => {},
        };
	        const automationDraft: NewSessionAutomationDraft = {
	            enabled: true,
	            name: 'Nightly',
	            description: 'desc',
	            scheduleKind: 'interval',
	            everyMinutes: 15,
	            cronExpr: '0 * * * *',
	            timezone: null,
	        };

        function Test() {
            const hook = useCreateNewSession({
                router: { push: routerPush, replace: routerReplace },
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
                sessionPrompt: 'Run the nightly maintenance checklist',
                automationDraft,
                resumeSessionId: '',
                agentNewSessionOptions: null,
                machineEnvPresence,
                secrets: [],
                secretBindingsByProfileId: {},
                selectedSecretIdByProfileIdByEnvVarName: {},
                sessionOnlySecretValueByProfileIdByEnvVarName: {},
                selectedMachineCapabilities: null,
                targetServerId: null,
                allowedTargetServerIds: ['server-a'],
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

        expect(captured.value).toBeNull();
        expect(automationCaptured.value?.name).toBe('Nightly');
        expect(automationCaptured.value?.schedule.kind).toBe('interval');
        expect(automationCaptured.value?.schedule.everyMs).toBe(900000);
        expect(automationCaptured.value?.assignments?.[0]?.machineId).toBe('m1');
        expect(refreshAutomationsSpy).toHaveBeenCalledTimes(1);
        expect(routerReplace).toHaveBeenCalledWith('/automations');
        const templateEnvelope = JSON.parse(String(automationCaptured.value?.templateCiphertext));
        expect(templateEnvelope.kind).toBe('happier_automation_template_encrypted_v1');
        expect(typeof templateEnvelope.payloadCiphertext).toBe('string');
        expect(templateEnvelope.payloadCiphertext.length).toBeGreaterThan(0);
    });

    it('does not apply Happier replay when resume is requested but vendor resume is unavailable (new-session flow)', async () => {
        const {
            useCreateNewSession,
            modalConfirmSpy,
            syncSendMessageSpy,
            machineSpawnNewSessionSpy,
        } = await setupUseCreateNewSessionHarness();

        machineSpawnNewSessionSpy.mockResolvedValueOnce({ type: 'success', sessionId: 'sess_new' });
        modalConfirmSpy.mockResolvedValueOnce(true);

        let handleCreateSession: null | (() => Promise<void>) = null;
        const routerReplace = vi.fn();
        const settings = {
            experiments: false,
            sessionReplayEnabled: true,
            sessionReplayStrategy: 'recent_messages',
            sessionReplayRecentMessagesCount: 16,
        } as unknown as Settings;
        const machineEnvPresence: UseMachineEnvPresenceResult = {
            isPreviewEnvSupported: false,
            isLoading: false,
            meta: {},
            refreshedAt: null,
            refresh: () => {},
        };

        function Test() {
            const hook = useCreateNewSession({
                router: { push: vi.fn(), replace: routerReplace },
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
                sessionPrompt: 'PROMPT',
                resumeSessionId: 'sess_old',
                agentNewSessionOptions: null,
                machineEnvPresence,
                secrets: [],
                secretBindingsByProfileId: {},
                selectedSecretIdByProfileIdByEnvVarName: {},
                sessionOnlySecretValueByProfileIdByEnvVarName: {},
                selectedMachineCapabilities: null,
                targetServerId: null,
                allowedTargetServerIds: ['server-a'],
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

        expect(syncSendMessageSpy).toHaveBeenCalledTimes(1);
        expect(syncSendMessageSpy).toHaveBeenCalledWith('sess_new', 'PROMPT');
    });
});
