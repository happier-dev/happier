import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentBackend, AgentMessage, AgentMessageHandler, SessionId } from '@/agent/core/AgentBackend';
import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';

const createConfiguredAcpBackendMock = vi.fn();
const materializeConfiguredAcpEnvironmentMock = vi.fn();
const resolveConfiguredAcpBackendFromAccountSettingsMock = vi.fn();
const resolveConfiguredAcpBackendFromAccountSettingsOrPluginsMock = vi.fn();
const readCredentialsMock = vi.fn();
const readSettingsMock = vi.fn();
const bootstrapAccountSettingsContextMock = vi.fn();
const resolveCustomHappierToolsContextMock = vi.fn();

vi.mock('@/agent/acp/catalog/configured/createConfiguredAcpBackend', () => ({
    createConfiguredAcpBackend: createConfiguredAcpBackendMock,
}));

vi.mock('@/agent/acp/catalog/configured/materializeEnvironment', () => ({
    materializeConfiguredAcpEnvironment: materializeConfiguredAcpEnvironmentMock,
}));

vi.mock('@/agent/acp/catalog/configured/resolveBackend', () => ({
    resolveConfiguredAcpBackendFromAccountSettings: resolveConfiguredAcpBackendFromAccountSettingsMock,
    resolveConfiguredAcpBackendFromAccountSettingsOrPlugins: resolveConfiguredAcpBackendFromAccountSettingsOrPluginsMock,
}));

vi.mock('@/persistence', () => ({
    readCredentials: readCredentialsMock,
    readSettings: readSettingsMock,
}));

vi.mock('@/settings/accountSettings/bootstrapAccountSettingsContext', () => ({
    bootstrapAccountSettingsContext: bootstrapAccountSettingsContextMock,
}));

vi.mock('@/agent/tools/happierTools/customMcp/resolveCustomHappierToolsContext', () => ({
    resolveCustomHappierToolsContext: resolveCustomHappierToolsContextMock,
}));

type ConfiguredAcpNativeLeaf = AgentBackend & ExecutionRunHostRuntime & {
    readResumeSupport: (opts?: Readonly<{ captureReplay?: boolean }>) => Promise<boolean>;
    provisionSession: (opts?: Readonly<{ initialPrompt?: string; resumeSessionId?: string }>) => Promise<{ sessionId: SessionId }>;
    subscribeMessages: (handler: AgentMessageHandler) => () => void;
    setSessionModel: (sessionId: SessionId, modelId: string) => Promise<void>;
    waitForTurnCompletion: (timeoutMs?: number | null) => Promise<void>;
    setSessionModelSpy: ReturnType<typeof vi.fn>;
};

function createStubBackend(): ConfiguredAcpNativeLeaf {
    let handler: AgentMessageHandler | null = null;
    const setSessionModelSpy = vi.fn(async (_sessionId: SessionId, _modelId: string) => {});

    return {
        setSessionModelSpy,
        async readResumeSupport() {
            return false;
        },
        async provisionSession(opts?: Readonly<{ initialPrompt?: string; resumeSessionId?: string }>) {
            if (opts?.resumeSessionId) {
                return { sessionId: opts.resumeSessionId as SessionId };
            }
            return { sessionId: 'configured-session-1' as SessionId };
        },
        subscribeMessages(next: AgentMessageHandler) {
            handler = next;
            return () => {
                if (handler === next) {
                    handler = null;
                }
            };
        },
        async startSession() {
            return { sessionId: 'configured-session-1' as SessionId };
        },
        async sendPrompt() {
            handler?.({ type: 'model-output', fullText: 'configured ok' });
        },
        async cancel() {},
        onMessage(next: AgentMessageHandler) {
            handler = next;
        },
        offMessage(next: AgentMessageHandler) {
            if (handler === next) {
                handler = null;
            }
        },
        async setSessionModel(sessionId: SessionId, modelId: string) {
            await setSessionModelSpy(sessionId, modelId);
        },
        async dispose() {},
        async waitForResponseComplete() {},
        async waitForTurnCompletion() {},
    };
}

describe('createExecutionRunBackend configured ACP regressions', () => {
    beforeEach(() => {
        createConfiguredAcpBackendMock.mockReset();
        materializeConfiguredAcpEnvironmentMock.mockReset();
        resolveConfiguredAcpBackendFromAccountSettingsMock.mockReset();
        resolveConfiguredAcpBackendFromAccountSettingsOrPluginsMock.mockReset();
        readCredentialsMock.mockReset();
        readSettingsMock.mockReset();
        bootstrapAccountSettingsContextMock.mockReset();
        resolveCustomHappierToolsContextMock.mockReset();
    });

    it('routes createExecutionRunRuntime through the configured ACP caller path and materializes the configured backend', async () => {
        const backend = createStubBackend();
        createConfiguredAcpBackendMock.mockReturnValue(backend);
        materializeConfiguredAcpEnvironmentMock.mockReturnValue({ ACP_TOKEN: 'token-1' });
        resolveConfiguredAcpBackendFromAccountSettingsMock.mockReturnValue({
            backendId: 'review-bot',
            name: 'review-bot',
            title: 'Review Bot',
            command: 'review-bot',
            args: ['--stdio'],
            env: {},
            transportProfile: { kind: 'stdio' },
            capabilities: {},
            defaultModel: 'review-model',
        });
        resolveConfiguredAcpBackendFromAccountSettingsOrPluginsMock.mockResolvedValue({
            backendId: 'review-bot',
            name: 'review-bot',
            title: 'Review Bot',
            command: 'review-bot',
            args: ['--stdio'],
            env: {},
            transportProfile: { kind: 'stdio' },
            capabilities: {},
            defaultModel: 'review-model',
        });
        readCredentialsMock.mockResolvedValue({ token: 'cred-1' });
        readSettingsMock.mockResolvedValue({ machineId: 'machine-1' });
        bootstrapAccountSettingsContextMock.mockResolvedValue({ settings: {} });
        resolveCustomHappierToolsContextMock.mockResolvedValue({ mcpServers: {} });

        const { createExecutionRunRuntime } = await import('./createExecutionRunBackend');

        const configuredRuntime = createExecutionRunRuntime({
            cwd: '/tmp/workspace',
            backendId: 'customAcp',
            backendTarget: {
                kind: 'backend',
                backendId: 'review-bot',
                configuredBackendId: 'review-bot',
                sourceKind: 'configured',
            },
            permissionMode: 'read_only',
        });

        await expect(configuredRuntime.provisionSession()).resolves.toEqual({ sessionId: 'configured-session-1' });
        expect(readCredentialsMock).toHaveBeenCalledTimes(1);
        expect(bootstrapAccountSettingsContextMock).toHaveBeenCalledWith({
            credentials: { token: 'cred-1' },
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
        });
        expect(resolveConfiguredAcpBackendFromAccountSettingsOrPluginsMock).toHaveBeenCalledWith({
            settings: {},
            backendId: 'review-bot',
            happyHomeDir: expect.any(String),
        });
        expect(materializeConfiguredAcpEnvironmentMock).toHaveBeenCalledWith({
            backend: expect.objectContaining({ backendId: 'review-bot' }),
            accountSettings: {},
            credentials: { token: 'cred-1' },
        });
        expect(resolveCustomHappierToolsContextMock).toHaveBeenCalledWith({
            credentials: { token: 'cred-1' },
            accountSettings: {},
            machineId: 'machine-1',
            directory: '/tmp/workspace',
        });
        expect(createConfiguredAcpBackendMock).toHaveBeenCalledWith(expect.objectContaining({
            cwd: '/tmp/workspace',
            backend: expect.objectContaining({ backendId: 'review-bot' }),
            env: undefined,
            launchEnv: { ACP_TOKEN: 'token-1' },
            mcpServers: {},
            permissionHandler: expect.any(Object),
            permissionMode: 'read-only',
        }));
    });

    it('materializes plugin-contributed configured ACP backends through the shared resolver', async () => {
        const backend = createStubBackend();
        createConfiguredAcpBackendMock.mockReturnValue(backend);
        materializeConfiguredAcpEnvironmentMock.mockReturnValue({ ACP_TOKEN: 'token-plugin' });
        resolveConfiguredAcpBackendFromAccountSettingsMock.mockReturnValue(null);
        resolveConfiguredAcpBackendFromAccountSettingsOrPluginsMock.mockResolvedValue({
            backendId: 'plugin-review-bot',
            name: 'plugin-review-bot',
            title: 'Plugin Review Bot',
            command: 'plugin-review-bot',
            args: ['--stdio'],
            env: {},
            transportProfile: { kind: 'stdio' },
            capabilities: {},
            defaultModel: 'plugin-review-model',
        });
        readCredentialsMock.mockResolvedValue({ token: 'cred-1' });
        readSettingsMock.mockResolvedValue({ machineId: 'machine-1' });
        bootstrapAccountSettingsContextMock.mockResolvedValue({ settings: {} });
        resolveCustomHappierToolsContextMock.mockResolvedValue({ mcpServers: {} });

        const { createExecutionRunBackend } = await import('./backend.testkit');

        const configuredBackend = createExecutionRunBackend({
            cwd: '/tmp/workspace',
            backendId: 'plugin-review-bot',
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'plugin-review-bot' },
            permissionMode: 'read_only',
        });

        await expect(configuredBackend.startSession()).resolves.toEqual({ sessionId: 'configured-session-1' });
        expect(resolveConfiguredAcpBackendFromAccountSettingsOrPluginsMock).toHaveBeenCalledWith({
            settings: {},
            backendId: 'plugin-review-bot',
            happyHomeDir: expect.any(String),
        });
        expect(createConfiguredAcpBackendMock).toHaveBeenCalledWith(expect.objectContaining({
            cwd: '/tmp/workspace',
            backend: expect.objectContaining({ backendId: 'plugin-review-bot', title: 'Plugin Review Bot' }),
            launchEnv: { ACP_TOKEN: 'token-plugin' },
        }));
    });

    it('emits runtime identity and capability events for configured ACP execution runs through the lazy shell', async () => {
        const backend = createStubBackend();
        createConfiguredAcpBackendMock.mockReturnValue(backend);
        materializeConfiguredAcpEnvironmentMock.mockReturnValue({ ACP_TOKEN: 'token-1' });
        resolveConfiguredAcpBackendFromAccountSettingsOrPluginsMock.mockResolvedValue({
            backendId: 'review-bot',
            name: 'review-bot',
            title: 'Review Bot',
            command: 'review-bot',
            args: ['--stdio'],
            env: {},
            transportProfile: { kind: 'stdio' },
            capabilities: {},
            defaultModel: 'review-model',
        });
        readCredentialsMock.mockResolvedValue({ token: 'cred-1' });
        readSettingsMock.mockResolvedValue({ machineId: 'machine-1' });
        bootstrapAccountSettingsContextMock.mockResolvedValue({ settings: { acpCatalog: { backends: [] } } });
        resolveCustomHappierToolsContextMock.mockResolvedValue({ mcpServers: {} });

        const { createExecutionRunBackend } = await import('./backend.testkit');
        const configuredBackend = createExecutionRunBackend({
            cwd: '/tmp/workspace',
            backendId: 'review-bot',
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            permissionMode: 'read_only',
            modelId: 'override-model',
        });

        const messages: AgentMessage[] = [];
        configuredBackend.onMessage((message) => {
            messages.push(message);
        });

        await expect(configuredBackend.startSession()).resolves.toEqual({ sessionId: 'configured-session-1' });

        expect(messages).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'event',
                name: 'runtime.descriptor',
                payload: expect.objectContaining({
                    backendId: 'review-bot',
                    runtimeKind: 'acp',
                }),
            }),
            expect.objectContaining({
                type: 'event',
                name: 'runtime.capabilities',
                payload: expect.objectContaining({
                    executionRun: { supported: true },
                }),
            }),
        ]));
    });

    it('applies the configured backend default model after provisioning when no explicit model override is supplied', async () => {
        const backend = createStubBackend();
        createConfiguredAcpBackendMock.mockReturnValue(backend);
        materializeConfiguredAcpEnvironmentMock.mockReturnValue({ ACP_TOKEN: 'token-1' });
        resolveConfiguredAcpBackendFromAccountSettingsOrPluginsMock.mockResolvedValue({
            backendId: 'review-bot',
            name: 'review-bot',
            title: 'Review Bot',
            command: 'review-bot',
            args: ['--stdio'],
            env: {},
            transportProfile: { kind: 'stdio' },
            capabilities: {},
            defaultModel: 'review-model',
        });
        readCredentialsMock.mockResolvedValue({ token: 'cred-1' });
        readSettingsMock.mockResolvedValue({ machineId: 'machine-1' });
        bootstrapAccountSettingsContextMock.mockResolvedValue({ settings: { acpCatalog: { backends: [] } } });
        resolveCustomHappierToolsContextMock.mockResolvedValue({ mcpServers: {} });

        const { createExecutionRunRuntime } = await import('./createExecutionRunBackend');
        const configuredRuntime = createExecutionRunRuntime({
            cwd: '/tmp/workspace',
            backendId: 'customAcp',
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            permissionMode: 'read_only',
        });

        await expect(configuredRuntime.provisionSession()).resolves.toEqual({ sessionId: 'configured-session-1' });
        expect(backend.setSessionModelSpy).toHaveBeenCalledWith('configured-session-1', 'review-model');
    });

    it('does not advertise resumability before the configured ACP backend proves it', async () => {
        const backend = createStubBackend();
        createConfiguredAcpBackendMock.mockReturnValue(backend);
        materializeConfiguredAcpEnvironmentMock.mockReturnValue({ ACP_TOKEN: 'token-1' });
        resolveConfiguredAcpBackendFromAccountSettingsMock.mockReturnValue({
            backendId: 'review-bot',
            name: 'review-bot',
            title: 'Review Bot',
            command: 'review-bot',
            args: ['--stdio'],
            env: {},
            transportProfile: { kind: 'stdio' },
            capabilities: {},
        });
        resolveConfiguredAcpBackendFromAccountSettingsOrPluginsMock.mockResolvedValue({
            backendId: 'review-bot',
            name: 'review-bot',
            title: 'Review Bot',
            command: 'review-bot',
            args: ['--stdio'],
            env: {},
            transportProfile: { kind: 'stdio' },
            capabilities: {},
        });
        readCredentialsMock.mockResolvedValue({ token: 'cred-1' });
        readSettingsMock.mockResolvedValue({ machineId: 'machine-1' });
        bootstrapAccountSettingsContextMock.mockResolvedValue({ settings: { acpCatalog: { backends: [] } } });
        resolveCustomHappierToolsContextMock.mockResolvedValue({ mcpServers: {} });

        const { createExecutionRunRuntime } = await import('./createExecutionRunBackend');
        const configuredRuntime = createExecutionRunRuntime({
            cwd: '/tmp/workspace',
            backendId: 'customAcp',
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            permissionMode: 'read_only',
        });

        await expect(configuredRuntime.readResumeSupport()).resolves.toBe(false);
        await expect(configuredRuntime.readResumeSupport({ captureReplay: true })).resolves.toBe(false);
    });

    it('rejects disabled configured ACP backends when account settings are passed directly', async () => {
        const { createExecutionRunBackend } = await import('./backend.testkit');
        expect(() => createExecutionRunBackend({
            cwd: '/tmp/workspace',
            backendId: 'customAcp',
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            permissionMode: 'read_only',
            accountSettings: {
                backendEnabledByTargetKey: {
                    'acpBackend:review-bot': false,
                },
            },
        })).toThrow(/review-bot/i);
    });

    it('rejects disabled configured ACP backends after bootstrapping account settings for the lazy path', async () => {
        bootstrapAccountSettingsContextMock.mockResolvedValue({
            settings: {
                backendEnabledByTargetKey: {
                    'acpBackend:review-bot': false,
                },
            },
        });
        readCredentialsMock.mockResolvedValue({ token: 'cred-1' });

        const { createExecutionRunBackend } = await import('./backend.testkit');
        const backend = createExecutionRunBackend({
            cwd: '/tmp/workspace',
            backendId: 'customAcp',
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            permissionMode: 'read_only',
        });

        await expect(backend.startSession()).rejects.toThrow(/review-bot/i);
        expect(createConfiguredAcpBackendMock).not.toHaveBeenCalled();
    });

    it('registers queued onMessage handlers only once when the lazy backend resolves', async () => {
        const backend = createStubBackend();
        const subscribeMessagesImpl = backend.subscribeMessages.bind(backend);
        const subscribeMessages = vi.fn((handler: AgentMessageHandler) => subscribeMessagesImpl(handler));
        backend.subscribeMessages = subscribeMessages;
        createConfiguredAcpBackendMock.mockReturnValue(backend);
        materializeConfiguredAcpEnvironmentMock.mockReturnValue({ ACP_TOKEN: 'token-1' });
        resolveConfiguredAcpBackendFromAccountSettingsMock.mockReturnValue({
            backendId: 'review-bot',
            name: 'review-bot',
            title: 'Review Bot',
            command: 'review-bot',
            args: ['--stdio'],
            env: {},
            transportProfile: { kind: 'stdio' },
            capabilities: {},
        });
        resolveConfiguredAcpBackendFromAccountSettingsOrPluginsMock.mockResolvedValue({
            backendId: 'review-bot',
            name: 'review-bot',
            title: 'Review Bot',
            command: 'review-bot',
            args: ['--stdio'],
            env: {},
            transportProfile: { kind: 'stdio' },
            capabilities: {},
        });
        readCredentialsMock.mockResolvedValue({ token: 'cred-1' });
        readSettingsMock.mockResolvedValue({ machineId: 'machine-1' });
        bootstrapAccountSettingsContextMock.mockResolvedValue({ settings: { acpCatalog: { backends: [] } } });
        resolveCustomHappierToolsContextMock.mockResolvedValue({ mcpServers: {} });

        const { createExecutionRunRuntime } = await import('./createExecutionRunBackend');
        const configuredRuntime = createExecutionRunRuntime({
            cwd: '/tmp/workspace',
            backendId: 'customAcp',
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            permissionMode: 'read_only',
        });
        const handler = vi.fn();
        configuredRuntime.subscribeMessages(handler);

        await configuredRuntime.provisionSession();

        expect(subscribeMessages).toHaveBeenCalledTimes(1);
        expect(subscribeMessages).toHaveBeenCalledWith(expect.any(Function));
    });
});
