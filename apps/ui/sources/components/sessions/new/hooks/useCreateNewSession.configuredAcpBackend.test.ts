import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { buildNewSessionAuthoringDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
import type { PermissionMode, ModelMode } from '@/sync/domains/permissions/permissionTypes';
import type { Settings } from '@/sync/domains/settings/settings';
import type { UseMachineEnvPresenceResult } from '@/hooks/machine/useMachineEnvPresence';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type SpawnPayloadCapture = {
    backendTarget?: { kind: 'builtInAgent'; agentId: string } | { kind: 'configuredAcpBackend'; backendId: string };
} | null;

const applySettingsMock = vi.hoisted(() => vi.fn());

async function setupHarness() {
    const captured: { value: SpawnPayloadCapture } = { value: null };
    const createdAutomationTemplate: { value: Record<string, unknown> | null } = { value: null };

    vi.doMock('@/text', () => ({ t: (key: string) => key }));
    vi.doMock('@/modal', () => ({
        Modal: {
            alert: vi.fn(),
            confirm: vi.fn(async () => false),
        },
    }));
    vi.doMock('@/sync/sync', () => ({
        sync: {
            getCredentials: vi.fn(() => ({ token: 't' })),
            encryption: {
                encryptRaw: vi.fn(async (value: unknown) => value),
                encryptAutomationTemplateRaw: vi.fn(async (value: unknown) => value),
            },
            createAutomation: vi.fn(async (input: { templateCiphertext: string }) => {
                createdAutomationTemplate.value = JSON.parse(input.templateCiphertext) as Record<string, unknown>;
                return {};
            }),
            decryptSecretValue: vi.fn(),
            refreshAutomations: vi.fn(async () => {}),
            refreshSessions: vi.fn(async () => {}),
            sendMessage: vi.fn(async () => {}),
        },
    }));
    vi.doMock('@/sync/store/settingsWriters', () => ({
        useApplySettings: () => applySettingsMock,
    }));
    vi.doMock('@/sync/domains/state/storage', () => ({
        storage: {
            getState: () => ({
                settings: {},
                updateSessionPermissionMode: vi.fn(),
                updateSessionModelMode: vi.fn(),
            }),
        },
    }));
    vi.doMock('@/sync/domains/state/persistence', () => ({
        loadSettings: () => ({ settings: {}, version: null }),
        loadDeviceAnalyticsId: () => null,
        saveDeviceAnalyticsId: vi.fn(),
        saveSettings: vi.fn(),
        loadPendingSettings: () => ({}),
        savePendingSettings: vi.fn(),
        loadLocalSettings: () => ({}),
        saveLocalSettings: vi.fn(),
        loadThemePreference: () => 'adaptive',
        loadPurchases: () => ({}),
        savePurchases: vi.fn(),
        loadSessionDrafts: () => ({}),
        saveSessionDrafts: vi.fn(),
        loadSessionReviewCommentsDrafts: () => ({}),
        saveSessionReviewCommentsDrafts: vi.fn(),
        loadSessionActionDrafts: () => ({}),
        saveSessionActionDrafts: vi.fn(),
        loadNewSessionDraft: () => null,
        saveNewSessionDraft: vi.fn(),
        clearNewSessionDraft: vi.fn(),
        loadSessionPermissionModes: () => ({}),
        saveSessionPermissionModes: vi.fn(),
        loadSessionPermissionModeUpdatedAts: () => ({}),
        saveSessionPermissionModeUpdatedAts: vi.fn(),
        loadSessionLastViewed: () => ({}),
        saveSessionLastViewed: vi.fn(),
        loadSessionModelModes: () => ({}),
        saveSessionModelModes: vi.fn(),
        loadSessionModelModeUpdatedAts: () => ({}),
        saveSessionModelModeUpdatedAts: vi.fn(),
        loadSessionMaterializedMaxSeqById: () => ({}),
        saveSessionMaterializedMaxSeqById: vi.fn(),
        loadChangesCursor: () => null,
        saveChangesCursor: vi.fn(),
        loadLastChangesCursorByAccountId: () => ({}),
        saveLastChangesCursorByAccountId: vi.fn(),
        loadProfile: () => ({}),
        saveProfile: vi.fn(),
        clearPersistence: vi.fn(),
    }));
    vi.doMock('@/sync/domains/server/serverRuntime', () => ({
        getActiveServerSnapshot: vi.fn(() => ({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            kind: 'custom',
            generation: 1,
        })),
    }));
    vi.doMock('@/sync/domains/server/selection/serverSelectionResolver', () => ({
        resolveNewSessionServerTarget: vi.fn((params: { requestedServerId?: string | null; allowedServerIds: string[] }) => ({
            targetServerId: params.requestedServerId ?? params.allowedServerIds[0] ?? null,
            rejectedRequestedServerId: null,
        })),
    }));
    vi.doMock('@/sync/domains/features/featureLocalPolicy', () => ({
        resolveLocalFeaturePolicyEnabled: vi.fn(() => false),
    }));
    vi.doMock('@/utils/profiles/profileConfigRequirements', () => ({
        getMissingRequiredConfigEnvVarNames: vi.fn(() => []),
    }));
    vi.doMock('@/utils/secrets/secretSatisfaction', () => ({
        getSecretSatisfaction: vi.fn(() => ({ isSatisfied: true, items: [] })),
    }));
    vi.doMock('@/sync/domains/profiles/profileUtils', () => ({
        getBuiltInProfile: vi.fn(() => null),
    }));
    vi.doMock('@/sync/domains/session/spawn/windowsRemoteSessionConsole', () => ({
        resolveWindowsRemoteSessionConsoleFromMachineMetadata: vi.fn(() => undefined),
    }));
    vi.doMock('@/components/sessions/new/modules/profileHelpers', () => ({
        transformProfileToEnvironmentVars: vi.fn(() => ({})),
    }));
    vi.doMock('@/sync/runtime/time', () => ({
        nowServerMs: vi.fn(() => Date.now()),
    }));
    vi.doMock('@/sync/domains/automations/encodeAutomationTemplateCiphertextForAccount', () => ({
        encodeAutomationTemplateCiphertextForAccount: vi.fn(async ({ template }: { template: unknown }) => JSON.stringify(template)),
    }));
    vi.doMock('@/sync/domains/input/slashCommands/resolveSessionComposerSend', () => ({
        resolveSessionComposerSend: vi.fn(({ input }: { input: string }) => ({ kind: 'send', text: input })),
    }));
    vi.doMock('@/sync/domains/input/slashCommands/expandPromptTemplateInvocation', () => ({
        expandPromptTemplateInvocation: vi.fn(async () => 'expanded template'),
    }));
    vi.doMock('@/sync/domains/automations/automationValidation', () => ({
        buildAutomationScheduleFromDraft: vi.fn(() => ({ kind: 'interval' })),
        normalizeAutomationDescription: vi.fn((value: string) => value),
        normalizeAutomationName: vi.fn((value: string) => value),
        validateAutomationTemplateTarget: vi.fn(),
    }));
    vi.doMock('@/utils/timing/time', () => ({
        delay: vi.fn(async () => {}),
    }));
    vi.doMock('@/utils/errors/daemonUnavailableAlert', () => ({
        showDaemonUnavailableAlert: vi.fn(),
    }));
    vi.doMock('@/hooks/ui/useMountedRef', () => ({
        useMountedRef: vi.fn(() => ({ current: true })),
    }));
    vi.doMock('@/sync/domains/settings/terminalSettings', () => ({
        resolveTerminalSpawnOptions: vi.fn(() => null),
    }));
    vi.doMock('@/hooks/server/useMachineCapabilitiesCache', () => ({
        getMachineCapabilitiesSnapshot: vi.fn(() => ({ supported: true, response: { protocolVersion: 1, results: {} } })),
    }));
    vi.doMock('@/agents/catalog/catalog', async (importOriginal) => {
        const actual = await importOriginal<typeof import('@/agents/catalog/catalog')>();
        return {
            ...actual,
            getAgentCore: vi.fn(() => ({
                model: { supportsSelection: false },
                sessionModes: { kind: 'staticAgentModes' },
            })),
            buildSpawnEnvironmentVariablesFromUiState: vi.fn((opts: { environmentVariables?: Record<string, string> }) => opts.environmentVariables),
            buildSpawnSessionExtrasFromUiState: vi.fn(() => ({})),
            getAgentResumeExperimentsFromSettings: vi.fn(() => ({})),
            getNewSessionPreflightIssues: vi.fn(() => []),
            buildResumeCapabilityOptionsFromUiState: vi.fn(() => ({})),
        };
    });
    vi.doMock('@/sync/ops', () => ({
        machineSpawnNewSession: vi.fn(async (opts: SpawnPayloadCapture) => {
            captured.value = opts;
            return { type: 'error', errorCode: 'unexpected', errorMessage: 'stop' };
        }),
    }));

    const { useCreateNewSession } = await import('./useCreateNewSession');
    return { useCreateNewSession, captured, createdAutomationTemplate };
}

describe('useCreateNewSession configured ACP backend spawning', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-03-08T00:00:00.000Z'));
        applySettingsMock.mockReset();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('passes a configured ACP backend backend target into machineSpawnNewSession', async () => {
        const { useCreateNewSession, captured } = await setupHarness();

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
                settings,
                useProfiles: false,
                selectedProfileId: null,
                profileMap: new Map(),
                recentMachinePaths: [],
                agentType: 'customAcp',
                backendTarget: {
                    kind: 'configuredAcpBackend',
                    backendId: 'custom-kiro-preset',
                },
                permissionMode: 'default' as PermissionMode,
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
            } as any);

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        act(() => {
            renderer.create(React.createElement(Test));
        });

        expect(handleCreateSession).toBeTruthy();
        await handleCreateSession!();

        expect(captured.value).not.toBeNull();
        expect(applySettingsMock).toHaveBeenCalledWith({
            recentMachinePaths: [{ machineId: 'm1', path: '/tmp' }],
            lastUsedAgent: 'customAcp',
            lastUsedBackendTarget: { kind: 'configuredAcpBackend', backendId: 'custom-kiro-preset' },
        });
        expect(captured.value?.backendTarget).toEqual({ kind: 'configuredAcpBackend', backendId: 'custom-kiro-preset' });
    });

    it('passes a configured ACP backend target into new-session automation template building', async () => {
        const { useCreateNewSession, createdAutomationTemplate } = await setupHarness();

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
                settings,
                useProfiles: false,
                selectedProfileId: null,
                profileMap: new Map(),
                recentMachinePaths: [],
                agentType: 'customAcp',
                backendTarget: {
                    kind: 'configuredAcpBackend',
                    backendId: 'custom-kiro-preset',
                },
                permissionMode: 'default' as PermissionMode,
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
                authoringDraft: buildNewSessionAuthoringDraft({
                    directory: '/tmp',
                    checkoutCreationDraft: null,
                    prompt: '',
                    displayText: '',
                    agentId: 'customAcp',
                    backendTarget: {
                        kind: 'configuredAcpBackend',
                        backendId: 'custom-kiro-preset',
                    },
                    transcriptStorage: null,
                    profileId: null,
                    environmentVariables: null,
                    resumeSessionId: null,
                    permissionMode: 'default',
                    permissionModeUpdatedAt: null,
                    modelId: null,
                    modelUpdatedAt: null,
                    mcpSelection: null,
                    connectedServices: null,
                    terminal: null,
                    windowsRemoteSessionLaunchMode: null,
                    windowsRemoteSessionConsole: null,
                    codexBackendMode: null,
                    acpSessionModeId: null,
                    sessionConfigOptionOverrides: null,
                    automation: {
                        enabled: true,
                        name: 'Nightly',
                        description: '',
                        scheduleKind: 'interval',
                        everyMinutes: 60,
                        cronExpr: '0 * * * *',
                        timezone: null,
                    },
                }),
            } as any);

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        act(() => {
            renderer.create(React.createElement(Test));
        });

        expect(handleCreateSession).toBeTruthy();
        await handleCreateSession!();

        expect(createdAutomationTemplate.value).toEqual(expect.objectContaining({
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'custom-kiro-preset' },
        }));
    });

    it('writes codex backend mode into automation templates without the experimental shadow flag', async () => {
        const { useCreateNewSession, createdAutomationTemplate } = await setupHarness();

        const { buildSpawnSessionExtrasFromUiState } = await import('@/agents/catalog/catalog');
        (buildSpawnSessionExtrasFromUiState as any).mockReturnValue({
            codexBackendMode: 'appServer',
            experimentalCodexAcp: false,
        });

        let handleCreateSession: null | (() => Promise<void>) = null;
        const settings = { codexBackendMode: 'appServer' } as unknown as Settings;
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
                settings,
                useProfiles: false,
                selectedProfileId: null,
                profileMap: new Map(),
                recentMachinePaths: [],
                agentType: 'codex',
                backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                permissionMode: 'default' as PermissionMode,
                modelMode: 'default' as ModelMode,
                sessionPrompt: 'Review the repo',
                resumeSessionId: '',
                agentNewSessionOptions: { experimentalCodexAcp: false },
                machineEnvPresence,
                secrets: [],
                secretBindingsByProfileId: {},
                selectedSecretIdByProfileIdByEnvVarName: {},
                sessionOnlySecretValueByProfileIdByEnvVarName: {},
                selectedMachineCapabilities: null,
                targetServerId: null,
                allowedTargetServerIds: ['server-a'],
                authoringDraft: buildNewSessionAuthoringDraft({
                    directory: '/tmp',
                    checkoutCreationDraft: null,
                    prompt: 'Review the repo',
                    displayText: 'Review the repo',
                    agentId: 'codex',
                    backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                    transcriptStorage: null,
                    profileId: null,
                    environmentVariables: null,
                    resumeSessionId: null,
                    permissionMode: 'default',
                    permissionModeUpdatedAt: null,
                    modelId: null,
                    modelUpdatedAt: null,
                    mcpSelection: null,
                    connectedServices: null,
                    terminal: null,
                    windowsRemoteSessionLaunchMode: null,
                    windowsRemoteSessionConsole: null,
                    codexBackendMode: 'appServer',
                    acpSessionModeId: null,
                    sessionConfigOptionOverrides: null,
                    automation: {
                        enabled: true,
                        name: 'Nightly',
                        description: '',
                        scheduleKind: 'interval',
                        everyMinutes: 60,
                        cronExpr: '0 * * * *',
                        timezone: null,
                    },
                }),
                codexBackendModeOverride: 'appServer',
            } as any);

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        act(() => {
            renderer.create(React.createElement(Test));
        });

        expect(handleCreateSession).toBeTruthy();
        await handleCreateSession!();

        expect(createdAutomationTemplate.value).toEqual(expect.objectContaining({
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            codexBackendMode: 'appServer',
        }));
        expect(createdAutomationTemplate.value).not.toHaveProperty('experimentalCodexAcp');
    });
});
