import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findTestInstanceByTypeContainingText, invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const syncSpies = vi.hoisted(() => ({
    createAutomation: vi.fn(async (_input: any) => ({})),
    refreshAutomations: vi.fn(async () => {}),
    getSessionEncryptionKeyBase64ForResume: vi.fn((_sessionId: string) => 'dek-base64'),
    getCredentials: vi.fn(() => ({ token: 't' })),
    encryption: {
        encryptAutomationTemplateRaw: vi.fn(async (_value: unknown) => 'ciphertext-base64'),
    },
}));

const sessionState = vi.hoisted(() => ({
    session: null as any,
}));
const getStateSpy = vi.hoisted(() => vi.fn());
const hydrateReadyState = vi.hoisted(() => ({
    ready: true,
}));

const routerBackSpy = vi.hoisted(() => vi.fn());
const routerReplaceSpy = vi.hoisted(() => vi.fn());
const modalAlertSpy = vi.hoisted(() => vi.fn(async () => {}));
const navigateWithBlurOnWebSpy = vi.hoisted(() => vi.fn((action: () => void) => action()));
const latestAgentInputProps = vi.hoisted(() => ({
    value: null as any,
}));
const latestContextSectionProps = vi.hoisted(() => ({
    value: null as any,
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            dark: false,
            colors: {
                groupped: { background: '#fff', chevron: '#777', sectionTitle: '#666' },
                surface: '#fff',
                surfaceHigh: '#f7f7f7',
                surfaceHighest: '#eee',
                surfacePressed: '#f0f0f0',
                surfacePressedOverlay: '#ececec',
                surfaceSelected: '#e6f0ff',
                surfaceRipple: '#ddd',
                text: '#111',
                textSecondary: '#777',
                textDestructive: '#c00',
                input: { background: '#eee', placeholder: '#999' },
                divider: '#ddd',
                accent: { blue: '#0a84ff' },
                modal: { border: '#ddd' },
                shadow: { color: '#000', opacity: 0.2 },
            },
        },
    });
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const expoRouterMock = createExpoRouterMock({
        router: { back: routerBackSpy, replace: routerReplaceSpy },
    });
    return expoRouterMock.module;
});

vi.mock('@/utils/platform/deferOnWeb', () => ({
    navigateWithBlurOnWeb: navigateWithBlurOnWebSpy,
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            alert: modalAlertSpy,
            confirm: vi.fn(),
            prompt: vi.fn(),
        },
    }).module;
});

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: any) => React.createElement('Switch', props),
}));

vi.mock('@/components/sessions/agentInput', () => ({
    AgentInput: (props: any) => {
        latestAgentInputProps.value = props;
        return React.createElement('AgentInput', props);
    },
}));

vi.mock('@/components/automations/shared/ExistingSessionAutomationContextSection', () => ({
    ExistingSessionAutomationContextSection: (props: any) => {
        latestContextSectionProps.value = props;
        return React.createElement('ExistingSessionAutomationContextSection', props);
    },
}));

vi.mock('@/components/automations/shared/ExistingSessionAutomationUnavailableNotice', () => ({
    ExistingSessionAutomationUnavailableNotice: (props: any) => {
        return React.createElement('ExistingSessionAutomationUnavailableNotice', props);
    },
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => {
        const labels: Record<string, string> = {
            'automations.create.defaultName': 'Scheduled message',
            'automations.create.createButtonTitle': 'Create automation',
            'automations.create.unavailableGroupTitle': 'Unavailable',
            'automations.create.cannotCreateForSession': 'Cannot create automation for this session',
            'automations.create.missingResumeKey': 'This session does not have a resume encryption key loaded yet.',
            'session.inactiveNotResumableNoticeTitle': 'This session can’t be resumed',
            'automations.form.toggleEnabledTitle': 'Enabled',
            'automations.form.toggleEnabledHelp': 'When disabled, no scheduled runs will be executed.',
        };
        return labels[key] ?? key;
    } });
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    useSession: () => sessionState.session,
    useSettings: () => ({}),
    storage: {
        getState: () => getStateSpy(),
    },
});
});

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: () => hydrateReadyState.ready,
}));

vi.mock('@/sync/sync', () => ({
    sync: syncSpies,
}));

const serverFetchSpy = vi.fn(async (..._args: unknown[]) => ({
    ok: true,
    status: 200,
    json: async () => ({ mode: 'e2ee', updatedAt: 1 }),
}));
vi.mock('@/sync/http/client', () => ({
    serverFetch: (...args: unknown[]) => serverFetchSpy(...args),
}));

async function flushRender(): Promise<void> {
    await act(async () => {
        await flushHookEffects({ cycles: 1, turns: 1 });
    });
}

function getComposerProps() {
    const composer = latestAgentInputProps.value;
    if (!composer) {
        throw new Error('AgentInput props were not captured');
    }
    return composer;
}

async function setComposerText(value: string): Promise<void> {
    await act(async () => {
        getComposerProps().onChangeText(value);
    });
}

async function submitComposer(): Promise<void> {
    await act(async () => {
        await getComposerProps().onSend();
    });
}

describe('SessionAutomationCreateScreen', () => {
    beforeEach(() => {
        hydrateReadyState.ready = true;
        sessionState.session = {
            id: 's1',
            active: true,
            encryptionMode: 'e2ee',
            metadata: {
                machineId: 'm1',
                path: '/tmp/project',
                homeDir: '/tmp',
                flavor: 'claude',
                claudeSessionId: 'claude-session-1',
            },
        };
        getStateSpy.mockImplementation(() => ({
            sessions: sessionState.session ? { s1: sessionState.session } : {},
            getProjectForSession: () => null,
        }));
        syncSpies.createAutomation.mockClear();
        syncSpies.refreshAutomations.mockClear();
        syncSpies.getSessionEncryptionKeyBase64ForResume.mockClear();
        syncSpies.getCredentials.mockClear();
        syncSpies.encryption.encryptAutomationTemplateRaw.mockClear();
        latestAgentInputProps.value = null;
        latestContextSectionProps.value = null;
        routerBackSpy.mockReset();
        routerReplaceSpy.mockReset();
        navigateWithBlurOnWebSpy.mockClear();
        modalAlertSpy.mockReset();
        serverFetchSpy.mockClear();
    });

    it('waits for deep-link hydration before showing the session-not-found state', async () => {
        hydrateReadyState.ready = false;
        sessionState.session = null;

        const { SessionAutomationCreateScreen } = await import('./SessionAutomationCreateScreen');

        const screen = await renderScreen(<SessionAutomationCreateScreen sessionId="s1" />);
        await flushRender();

        expect(findTestInstanceByTypeContainingText(screen.tree, 'Text', 'Cannot create automation for this session')).toBeUndefined();
        expect(findTestInstanceByTypeContainingText(screen.tree, 'Pressable', 'Create automation')).toBeUndefined();
    });

    it('renders the inherited existing-session context section before the shared composer', async () => {
        sessionState.session = {
            id: 's1',
            active: false,
            encryptionMode: 'e2ee',
            metadata: {
                machineId: 'm-stale',
                path: '/tmp/project',
                homeDir: '/tmp',
                flavor: 'claude',
                claudeSessionId: 'claude-session-1',
            },
        };
        getStateSpy.mockImplementation(() => ({
            sessions: {
                s1: sessionState.session,
            },
            machines: {
                'm-target': {
                    id: 'm-target',
                    active: true,
                    activeAt: 10,
                    metadata: { host: 'mbp-host' },
                },
            },
            getProjectForSession: (sessionId: string) => sessionId === 's1'
                ? {
                    key: {
                        machineId: 'm-target',
                        path: '/tmp/project',
                    },
                }
                : null,
        }));

        const { SessionAutomationCreateScreen } = await import('./SessionAutomationCreateScreen');

        const screen = await renderScreen(<SessionAutomationCreateScreen sessionId="s1" />);
        await flushRender();

        expect(screen.findAllByType('ExistingSessionAutomationContextSection')).toHaveLength(1);
        expect(latestContextSectionProps.value).toEqual(expect.objectContaining({
            context: expect.objectContaining({
                draft: expect.objectContaining({
                    directory: '/tmp/project',
                    existingSessionId: 's1',
                }),
                availability: expect.objectContaining({
                    kind: 'ready',
                    machineId: 'm-target',
                }),
            }),
        }));
    });

    it('relies on the shared composer submit action instead of rendering a duplicate create row', async () => {
        const { SessionAutomationCreateScreen } = await import('./SessionAutomationCreateScreen');

        const screen = await renderScreen(<SessionAutomationCreateScreen sessionId="s1" />);
        await flushRender();

        expect(latestAgentInputProps.value?.submitAccessibilityLabel).toBe('Create automation');
        expect(findTestInstanceByTypeContainingText(screen.tree, 'Pressable', 'Create automation')).toBeUndefined();
    });

    it('uses the automation enabled toggle semantics on the automation-only create screen', async () => {
        const { SessionAutomationCreateScreen } = await import('./SessionAutomationCreateScreen');

        const screen = await renderScreen(<SessionAutomationCreateScreen sessionId="s1" />);
        await flushRender();

        expect(findTestInstanceByTypeContainingText(screen.tree, 'Text', 'Enable automation')).toBeUndefined();
        expect(findTestInstanceByTypeContainingText(screen.tree, 'Text', 'Enabled')).toBeTruthy();
        expect(screen.findAllByType('Switch')).toHaveLength(1);
    });

    it('can create an existing-session automation in a paused state', async () => {
        const { SessionAutomationCreateScreen } = await import('./SessionAutomationCreateScreen');

        const screen = await renderScreen(<SessionAutomationCreateScreen sessionId="s1" />);
        await flushRender();

        const toggle = screen.findByType('Switch');
        await act(async () => {
            invokeTestInstanceHandler(toggle, 'onValueChange', false);
        });

        await setComposerText('Do the thing');
        await submitComposer();

        expect(syncSpies.createAutomation).toHaveBeenCalledTimes(1);
        expect(syncSpies.createAutomation.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
            enabled: false,
        }));
    });

    it('creates an existing-session automation with an envelope that includes existingSessionId and the reachable machine target', async () => {
        sessionState.session = {
            id: 's1',
            active: false,
            encryptionMode: 'e2ee',
            metadata: {
                machineId: 'm-stale',
                path: '/tmp/project',
                homeDir: '/tmp',
                flavor: 'claude',
                claudeSessionId: 'claude-session-1',
            },
        };
        getStateSpy.mockImplementation(() => ({
            sessions: {
                s1: sessionState.session,
            },
            machines: {
                'm-target': {
                    id: 'm-target',
                    active: true,
                    activeAt: 10,
                    metadata: { host: 'mbp-host' },
                },
            },
            getProjectForSession: (sessionId: string) => sessionId === 's1'
                ? {
                    key: {
                        machineId: 'm-target',
                        path: '/tmp/project',
                    },
                }
                : null,
        }));

        const { SessionAutomationCreateScreen } = await import('./SessionAutomationCreateScreen');

        const screen = await renderScreen(<SessionAutomationCreateScreen sessionId="s1" />);
        await flushRender();

        await setComposerText('Do the thing');

        const name = screen.findByProps({ autoCapitalize: 'words' });
        await act(async () => {
            name.props.onChangeText('My automation');
        });

        await submitComposer();

        expect(syncSpies.createAutomation).toHaveBeenCalledTimes(1);
        const input = syncSpies.createAutomation.mock.calls[0][0];
        expect(input.targetType).toBe('existing_session');
        expect(input.assignments).toEqual([{ machineId: 'm-target', enabled: true, priority: 100 }]);

        const envelope = JSON.parse(String(input.templateCiphertext));
        expect(envelope.kind).toBe('happier_automation_template_encrypted_v1');
        expect(envelope.existingSessionId).toBe('s1');
    });

    it('inherits the session runtime fields into the existing-session automation template', async () => {
        sessionState.session = {
            id: 's1',
            active: true,
            encryptionMode: 'e2ee',
            permissionMode: 'acceptEdits',
            permissionModeUpdatedAt: 123,
            modelMode: 'gpt-5',
            modelModeUpdatedAt: 456,
            metadata: {
                machineId: 'm1',
                path: '/tmp/project',
                homeDir: '/tmp',
                profileId: 'profile-1',
                flavor: 'codex',
                codexSessionId: 'codex-session-1',
                codexBackendMode: 'acp',
                permissionMode: 'readOnly',
                permissionModeUpdatedAt: 10,
                acpConfiguredBackendV1: {
                    v: 1,
                    updatedAt: 20,
                    backendId: 'review-bot',
                    title: 'Review Bot',
                },
                terminal: {
                    mode: 'tmux',
                    tmux: { target: 'happy-dev' },
                },
            },
        };

        const { SessionAutomationCreateScreen } = await import('./SessionAutomationCreateScreen');

        const screen = await renderScreen(<SessionAutomationCreateScreen sessionId="s1" />);
        await flushRender();

        await setComposerText('Send the latest automation QA summary into this session.');

        await submitComposer();

        expect(syncSpies.encryption.encryptAutomationTemplateRaw).toHaveBeenCalledTimes(1);
        expect(syncSpies.encryption.encryptAutomationTemplateRaw.mock.calls[0][0]).toEqual(expect.objectContaining({
            directory: '/tmp/project',
            prompt: 'Send the latest automation QA summary into this session.',
            displayText: 'Send the latest automation QA summary into this session.',
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            profileId: 'profile-1',
            permissionMode: 'safe-yolo',
            permissionModeUpdatedAt: 123,
            modelId: 'gpt-5',
            modelUpdatedAt: 456,
            terminal: { mode: 'tmux', tmux: { sessionName: 'happy-dev' } },
            codexBackendMode: 'acp',
            existingSessionId: 's1',
            sessionEncryptionMode: 'e2ee',
            sessionEncryptionKeyBase64: 'dek-base64',
            sessionEncryptionVariant: 'dataKey',
        }));
    });

    it('navigates to the session automations list after creation instead of relying on history back', async () => {
        const { SessionAutomationCreateScreen } = await import('./SessionAutomationCreateScreen');

        const screen = await renderScreen(<SessionAutomationCreateScreen sessionId="s1" />);
        await flushRender();

        await setComposerText('Do the thing');

        await submitComposer();

        expect(navigateWithBlurOnWebSpy).toHaveBeenCalledTimes(1);
        expect(routerReplaceSpy).toHaveBeenCalledWith('/session/s1/automations');
        expect(routerBackSpy).not.toHaveBeenCalled();
    });

    it('creates a plaintext existing-session automation without requiring a resume key', async () => {
        sessionState.session = {
            id: 's_plain',
            active: true,
            encryptionMode: 'plain',
            metadata: {
                machineId: 'm1',
                path: '/tmp/project',
                homeDir: '/tmp',
                flavor: 'claude',
                claudeSessionId: 'claude-session-plain-1',
            },
        };
        syncSpies.getSessionEncryptionKeyBase64ForResume.mockImplementationOnce(() => null as any);
        serverFetchSpy.mockImplementationOnce(async () => ({
            ok: true,
            status: 200,
            json: async () => ({ mode: 'plain', updatedAt: 1 }),
        }));

        const { SessionAutomationCreateScreen } = await import('./SessionAutomationCreateScreen');

        const screen = await renderScreen(<SessionAutomationCreateScreen sessionId="s_plain" />);
        await flushRender();

        await setComposerText('Hello');

        await submitComposer();

        expect(syncSpies.createAutomation).toHaveBeenCalledTimes(1);
        const input = syncSpies.createAutomation.mock.calls[0][0];
        const envelope = JSON.parse(String(input.templateCiphertext));
        expect(envelope.kind).toBe('happier_automation_template_plain_v1');
        expect(envelope.existingSessionId).toBe('s_plain');
        expect(envelope.payload.sessionEncryptionMode).toBe('plain');
        expect(syncSpies.encryption.encryptAutomationTemplateRaw).not.toHaveBeenCalled();
    });

    it('shows only the unavailable notice and does not create an automation when the target session is not resumable', async () => {
        sessionState.session = {
            id: 's_non_resumable',
            active: true,
            encryptionMode: 'plain',
            metadata: {
                machineId: 'm1',
                path: '/tmp/project',
                homeDir: '/tmp',
                flavor: 'pi',
                piSessionId: 'pi-session-1',
            },
        };
        syncSpies.getSessionEncryptionKeyBase64ForResume.mockImplementationOnce(() => null as any);
        serverFetchSpy.mockImplementationOnce(async () => ({
            ok: true,
            status: 200,
            json: async () => ({ mode: 'plain', updatedAt: 1 }),
        }));

        const { SessionAutomationCreateScreen } = await import('./SessionAutomationCreateScreen');

        const screen = await renderScreen(<SessionAutomationCreateScreen sessionId="s_non_resumable" />);
        await flushRender();

        const unavailableNotices = screen.findAllByType('ExistingSessionAutomationUnavailableNotice');
        expect(unavailableNotices).toHaveLength(1);
        expect(unavailableNotices[0]?.props).toEqual({
            reason: 'This session can’t be resumed',
        });
        expect(screen.findAllByType('AutomationSettingsForm')).toHaveLength(0);
        expect(screen.findAllByType('ExistingSessionAutomationContextSection')).toHaveLength(0);
        expect(screen.findAllByType('AgentInput')).toHaveLength(0);
        expect(syncSpies.createAutomation).not.toHaveBeenCalled();
    });

    it('allows creating an automation for an inactive but resumable session', async () => {
        sessionState.session = {
            id: 's_inactive_resumable',
            active: false,
            encryptionMode: 'plain',
            metadata: {
                machineId: 'm1',
                path: '/tmp/project',
                homeDir: '/tmp',
                flavor: 'claude',
                claudeSessionId: 'claude-session-1',
            },
        };
        syncSpies.getSessionEncryptionKeyBase64ForResume.mockImplementationOnce(() => null as any);
        serverFetchSpy.mockImplementationOnce(async () => ({
            ok: true,
            status: 200,
            json: async () => ({ mode: 'plain', updatedAt: 1 }),
        }));

        const { SessionAutomationCreateScreen } = await import('./SessionAutomationCreateScreen');

        const screen = await renderScreen(<SessionAutomationCreateScreen sessionId="s_inactive_resumable" />);
        await flushRender();

        await setComposerText('Hello');

        await submitComposer();

        expect(syncSpies.createAutomation).toHaveBeenCalledTimes(1);
    });

    it('uses the shared agent input controls to override permission and model for existing-session automations', async () => {
        sessionState.session = {
            id: 's1',
            active: true,
            encryptionMode: 'e2ee',
            permissionMode: 'readOnly',
            permissionModeUpdatedAt: 10,
            modelMode: 'claude-sonnet-4',
            modelModeUpdatedAt: 20,
            metadata: {
                machineId: 'm1',
                path: '/tmp/project',
                homeDir: '/tmp',
                flavor: 'claude',
                claudeSessionId: 'claude-session-1',
            },
        };

        const { SessionAutomationCreateScreen } = await import('./SessionAutomationCreateScreen');

        const screen = await renderScreen(<SessionAutomationCreateScreen sessionId="s1" />);
        await flushRender();

        await act(async () => {
            getComposerProps().onChangeText('Send the automation heartbeat');
            getComposerProps().onPermissionModeChange?.('acceptEdits');
            getComposerProps().onModelModeChange?.('gpt-5');
            await getComposerProps().onSend();
        });

        expect(syncSpies.encryption.encryptAutomationTemplateRaw).toHaveBeenCalledTimes(1);
        expect(syncSpies.encryption.encryptAutomationTemplateRaw.mock.calls[0]?.[0]).toEqual(
            expect.objectContaining({
                prompt: 'Send the automation heartbeat',
                displayText: 'Send the automation heartbeat',
                permissionMode: 'acceptEdits',
                modelId: 'gpt-5',
            }),
        );
    });
});
