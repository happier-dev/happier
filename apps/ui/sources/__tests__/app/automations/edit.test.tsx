import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStackOptionsCapture } from '@/dev/testkit/mocks/router';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerBackSpy = vi.hoisted(() => vi.fn());
const routerReplaceSpy = vi.hoisted(() => vi.fn());
const updateAutomationSpy = vi.hoisted(() => vi.fn(async () => {}));
const refreshAutomationsSpy = vi.hoisted(() => vi.fn(async () => {}));
const getSessionEncryptionKeyBase64ForResumeSpy = vi.hoisted(() => vi.fn((_sessionId: string) => null));
const navigateWithBlurOnWebSpy = vi.hoisted(() => vi.fn((action: () => void) => action()));
const storeTempDataSpy = vi.hoisted(() => vi.fn(() => 'temp-edit-seed'));
const updateExistingSessionAutomationTemplateMessageSpy = vi.hoisted(() => vi.fn(async () => 'updated-template'));
const latestAgentInputProps = vi.hoisted(() => ({
    value: null as any,
}));
const latestContextSectionProps = vi.hoisted(() => ({
    value: null as any,
}));
const latestAutomationSettingsFormProps = vi.hoisted(() => ({
    value: null as any,
}));
const latestUnavailableNoticeProps = vi.hoisted(() => ({
    value: null as any,
}));
const automationState = vi.hoisted(() => ({
    value: {
        id: 'a1',
        enabled: true,
        name: 'Nightly',
        description: null as string | null,
        targetType: 'new_session' as 'new_session' | 'existing_session',
        templateCiphertext: 'template',
        assignments: [{ machineId: 'machine-1', enabled: true, priority: 100 }],
        schedule: {
            kind: 'interval' as const,
            everyMs: 60_000,
            scheduleExpr: null as string | null,
            timezone: null as string | null,
        },
    },
}));
const sessionState = vi.hoisted(() => ({
    value: null as any,
}));
const getStateSpy = vi.hoisted(() => vi.fn());
const hydrateReadyState = vi.hoisted(() => ({
    ready: true,
}));
const stackOptionsCapture = createStackOptionsCapture();

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const expoRouterMock = createExpoRouterMock({
        router: { back: routerBackSpy, replace: routerReplaceSpy },
        params: { id: 'a1' },
        stackOptionsCapture,
    });
    return expoRouterMock.module;
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: (props: any) => React.createElement('ItemList', props, props.children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
    TextInput: (props: any) => React.createElement('TextInput', props),
}));

vi.mock('@/components/sessions/agentInput', () => ({
    AgentInput: (props: any) => {
        latestAgentInputProps.value = props;
        return React.createElement('AgentInput', props);
    },
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 1000 },
}));

vi.mock('@/components/automations/gating/AutomationsGate', () => ({
    AutomationsGate: (props: any) => React.createElement(React.Fragment, null, props.children),
}));

vi.mock('@/components/automations/editor/AutomationSettingsForm', () => ({
    AutomationSettingsForm: (props: any) => {
        latestAutomationSettingsFormProps.value = props;
        return React.createElement('AutomationSettingsForm', props);
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
        latestUnavailableNoticeProps.value = props;
        return React.createElement('ExistingSessionAutomationUnavailableNotice', props);
    },
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    useAutomation: () => automationState.value,
    useSession: () => sessionState.value,
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
    sync: {
        updateAutomation: updateAutomationSpy,
        refreshAutomations: refreshAutomationsSpy,
        getSessionEncryptionKeyBase64ForResume: getSessionEncryptionKeyBase64ForResumeSpy,
    },
}));

vi.mock('@/sync/domains/automations/automationExistingSessionTemplateUpdate', () => ({
    updateExistingSessionAutomationTemplateMessage: updateExistingSessionAutomationTemplateMessageSpy,
}));

vi.mock('@/sync/domains/automations/automationTemplateTransport', () => ({
    tryDecodeAutomationTemplateEnvelope: vi.fn(() => null),
    tryReadAutomationTemplateEnvelopeExistingSessionId: vi.fn(() => null),
}));

vi.mock('@/sync/domains/automations/automationTemplateCodec', () => ({
    decodeAutomationTemplate: vi.fn(() => null),
}));

vi.mock('@/utils/sessions/tempDataStore', () => ({
    storeTempData: storeTempDataSpy,
}));

vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (promise: Promise<unknown>) => promise,
}));

vi.mock('@/utils/platform/deferOnWeb', () => ({
    navigateWithBlurOnWeb: navigateWithBlurOnWebSpy,
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => {
        const labels: Record<string, string> = {
            'automations.edit.title': 'Edit automation',
            'automations.edit.saveAutomationLabel': 'Save automation',
            'common.back': 'Back',
        };
        return labels[key] ?? key;
    } });
});

describe('AutomationEditScreen route', () => {
    beforeEach(() => {
        hydrateReadyState.ready = true;
        stackOptionsCapture.reset();
        routerBackSpy.mockReset();
        routerReplaceSpy.mockReset();
        updateAutomationSpy.mockClear();
        refreshAutomationsSpy.mockClear();
        getSessionEncryptionKeyBase64ForResumeSpy.mockClear();
        navigateWithBlurOnWebSpy.mockClear();
        storeTempDataSpy.mockClear();
        updateExistingSessionAutomationTemplateMessageSpy.mockClear();
        latestAgentInputProps.value = null;
        latestContextSectionProps.value = null;
        latestAutomationSettingsFormProps.value = null;
        latestUnavailableNoticeProps.value = null;
        automationState.value = {
            id: 'a1',
            enabled: true,
            name: 'Nightly',
            description: null,
            targetType: 'new_session',
            templateCiphertext: 'template',
            assignments: [{ machineId: 'machine-1', enabled: true, priority: 100 }],
            schedule: {
                kind: 'interval',
                everyMs: 60_000,
                scheduleExpr: null,
                timezone: null,
            },
        };
        sessionState.value = null;
        getStateSpy.mockImplementation(() => ({
            sessions: sessionState.value ? {
                s1: sessionState.value,
                'session-1': sessionState.value,
            } : {},
            getProjectForSession: () => null,
        }));
    });

    const settle = async () => {
        await act(async () => {
            await flushHookEffects({ cycles: 1, turns: 1 });
        });
    };

    it('redirects new-session automations into the shared new-session composer with hydrated temp data', async () => {
        const transport = await import('@/sync/domains/automations/automationTemplateTransport');
        const codec = await import('@/sync/domains/automations/automationTemplateCodec');
        vi.mocked(transport.tryDecodeAutomationTemplateEnvelope).mockReturnValue({
            kind: 'happier_automation_template_plain_v1',
            payload: { prompt: 'Run nightly checks' },
        } as any);
        vi.mocked(codec.decodeAutomationTemplate).mockReturnValue({
            directory: '/repo/project',
            prompt: 'Run nightly checks',
            displayText: 'Run nightly checks',
            agent: 'codex',
            profileId: 'profile-1',
            transcriptStorage: 'direct',
            permissionMode: 'acceptEdits',
            modelId: 'gpt-5',
        } as any);

        const EditRoute = (await import('@/app/(app)/automations/edit')).default;

        await renderScreen(React.createElement(EditRoute));
        await settle();

        expect(storeTempDataSpy).toHaveBeenCalledWith(expect.objectContaining({
            prompt: 'Run nightly checks',
            machineId: 'machine-1',
            directory: '/repo/project',
            selectedProfileId: 'profile-1',
            transcriptStorage: 'direct',
            permissionMode: 'acceptEdits',
            modelMode: 'gpt-5',
            automationDraft: expect.objectContaining({
                enabled: true,
                name: 'Nightly',
                scheduleKind: 'interval',
                everyMinutes: 1,
            }),
        }));
        expect(navigateWithBlurOnWebSpy).toHaveBeenCalledTimes(1);
        expect(routerReplaceSpy).toHaveBeenCalledWith('/new?automation=1&automationEditId=a1&dataId=temp-edit-seed');
    });

    it('renders the shared unavailable notice for blocked existing-session automations', async () => {
        const transport = await import('@/sync/domains/automations/automationTemplateTransport');
        const codec = await import('@/sync/domains/automations/automationTemplateCodec');
        automationState.value = {
            id: 'a1',
            enabled: true,
            name: 'Nightly',
            description: null,
            targetType: 'existing_session',
            templateCiphertext: 'template',
            assignments: [{ machineId: 'machine-1', enabled: true, priority: 100 }],
            schedule: {
                kind: 'interval',
                everyMs: 60_000,
                scheduleExpr: null,
                timezone: null,
            },
        } as any;
        sessionState.value = {
            id: 's1',
            active: true,
            encryptionMode: 'e2ee',
            metadata: {
                machineId: 'm1',
                path: '/tmp/project',
                flavor: 'claude',
                claudeSessionId: 'claude-session-1',
            },
        };
        getSessionEncryptionKeyBase64ForResumeSpy.mockReturnValueOnce(null);
        vi.mocked(transport.tryReadAutomationTemplateEnvelopeExistingSessionId).mockReturnValue('s1');
        vi.mocked(transport.tryDecodeAutomationTemplateEnvelope).mockReturnValue({
            kind: 'happier_automation_template_plain_v1',
            existingSessionId: 's1',
            payload: { existingSessionId: 's1', directory: '/tmp/project', prompt: 'Send summary', displayText: 'Send summary' },
        } as any);
        vi.mocked(codec.decodeAutomationTemplate).mockReturnValue({
            existingSessionId: 's1',
            directory: '/tmp/project',
            prompt: 'Send summary',
            displayText: 'Send summary',
        } as any);

        const EditRoute = (await import('@/app/(app)/automations/edit')).default;

        await renderScreen(React.createElement(EditRoute));
        await settle();

        expect(latestUnavailableNoticeProps.value).toEqual(expect.objectContaining({
            reason: 'automations.create.missingResumeKey',
        }));
        expect(latestAutomationSettingsFormProps.value).toBeNull();
        expect(latestContextSectionProps.value).toBeNull();
        expect(latestAgentInputProps.value).toBeNull();
    });

    it('renders the inherited existing-session context section when editing an existing-session automation', async () => {
        const transport = await import('@/sync/domains/automations/automationTemplateTransport');
        const codec = await import('@/sync/domains/automations/automationTemplateCodec');
        automationState.value = {
            ...automationState.value,
            targetType: 'existing_session',
            templateCiphertext: 'template',
        };
        sessionState.value = {
            id: 'session-1',
            encryptionMode: 'plain',
            permissionMode: 'default',
            permissionModeUpdatedAt: 999,
            modelMode: 'default',
            modelModeUpdatedAt: 111,
            metadata: {
                machineId: 'm-stale',
                path: '/repo/project',
                homeDir: '/repo',
                flavor: 'acp:review-bot',
            },
        };
        getStateSpy.mockImplementation(() => ({
            sessions: {
                'session-1': sessionState.value,
            },
            machines: {
                'm-target': {
                    id: 'm-target',
                    active: true,
                    activeAt: 10,
                    metadata: { host: 'mbp-host' },
                },
            },
            getProjectForSession: (sessionId: string) => sessionId === 'session-1'
                ? {
                    key: {
                        machineId: 'm-target',
                        path: '/repo/project',
                    },
                }
                : null,
        }));
        vi.mocked(transport.tryReadAutomationTemplateEnvelopeExistingSessionId).mockReturnValue('session-1');
        vi.mocked(transport.tryDecodeAutomationTemplateEnvelope).mockReturnValue({
            kind: 'happier_automation_template_plain_v1',
            existingSessionId: 'session-1',
            payload: { prompt: 'Resume the review' },
        } as any);
        vi.mocked(codec.decodeAutomationTemplate).mockReturnValue({
            existingSessionId: 'session-1',
            directory: '/repo/project',
            prompt: 'Resume the review',
            displayText: 'Resume the review',
            permissionMode: 'readOnly',
            permissionModeUpdatedAt: 12,
            modelId: 'claude-sonnet-4-6',
            modelUpdatedAt: 34,
        } as any);

        const EditRoute = (await import('@/app/(app)/automations/edit')).default;
        await renderScreen(React.createElement(EditRoute));
        await settle();

        expect(latestContextSectionProps.value).toEqual(expect.objectContaining({
            context: expect.objectContaining({
                draft: expect.objectContaining({
                    existingSessionId: 'session-1',
                    directory: '/repo/project',
                    permissionMode: 'readOnly',
                    permissionModeUpdatedAt: 12,
                    modelId: 'claude-sonnet-4-6',
                    modelUpdatedAt: 34,
                }),
                availability: expect.objectContaining({
                    kind: 'ready',
                    machineId: 'm-target',
                }),
            }),
        }));
        expect(latestAgentInputProps.value).toEqual(expect.objectContaining({
            permissionMode: 'readOnly',
            modelMode: 'claude-sonnet-4-6',
        }));
    });

    it('preserves configured ACP backend targets when redirecting new-session automations into the shared composer', async () => {
        const transport = await import('@/sync/domains/automations/automationTemplateTransport');
        const codec = await import('@/sync/domains/automations/automationTemplateCodec');
        vi.mocked(transport.tryDecodeAutomationTemplateEnvelope).mockReturnValue({
            kind: 'happier_automation_template_plain_v1',
            payload: { prompt: 'Run nightly checks' },
        } as any);
        vi.mocked(codec.decodeAutomationTemplate).mockReturnValue({
            directory: '/repo/project',
            prompt: 'Run nightly checks',
            displayText: 'Run nightly checks',
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            transcriptStorage: 'direct',
            permissionMode: 'acceptEdits',
            modelId: 'gpt-5',
        } as any);

        const EditRoute = (await import('@/app/(app)/automations/edit')).default;

        await renderScreen(React.createElement(EditRoute));
        await settle();

        expect(storeTempDataSpy).toHaveBeenCalledWith(expect.objectContaining({
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
        }));
    });

    it('waits for existing-session deep-link hydration before showing the session-not-found state', async () => {
        const transport = await import('@/sync/domains/automations/automationTemplateTransport');
        const codec = await import('@/sync/domains/automations/automationTemplateCodec');
        hydrateReadyState.ready = false;
        vi.mocked(transport.tryReadAutomationTemplateEnvelopeExistingSessionId).mockReturnValue('s1');
        vi.mocked(transport.tryDecodeAutomationTemplateEnvelope).mockReturnValue({
            kind: 'happier_automation_template_plain_v1',
            payload: { prompt: 'Follow up', displayText: 'Follow up', existingSessionId: 's1' },
            existingSessionId: 's1',
        } as any);
        vi.mocked(codec.decodeAutomationTemplate).mockReturnValue({
            directory: '/tmp/project',
            prompt: 'Follow up',
            displayText: 'Follow up',
            existingSessionId: 's1',
        } as any);
        automationState.value = {
            id: 'a1',
            enabled: true,
            name: 'Nightly',
            description: null,
            targetType: 'existing_session',
            templateCiphertext: 'template',
            assignments: [{ machineId: 'machine-1', enabled: true, priority: 100 }],
            schedule: {
                kind: 'interval',
                everyMs: 60_000,
                scheduleExpr: null,
                timezone: null,
            },
        };
        sessionState.value = null;

        const EditRoute = (await import('@/app/(app)/automations/edit')).default;

        await renderScreen(React.createElement(EditRoute));
        await settle();

        expect(latestAutomationSettingsFormProps.value).toBeNull();
        expect(latestContextSectionProps.value).toBeNull();
        expect(latestAgentInputProps.value).toBeNull();
        expect(latestUnavailableNoticeProps.value).toBeNull();
    });

    it('replaces to the automation detail route after save', async () => {
        const transport = await import('@/sync/domains/automations/automationTemplateTransport');
        const codec = await import('@/sync/domains/automations/automationTemplateCodec');
        vi.mocked(transport.tryReadAutomationTemplateEnvelopeExistingSessionId).mockReturnValue('s1');
        vi.mocked(transport.tryDecodeAutomationTemplateEnvelope).mockReturnValue({
            kind: 'happier_automation_template_plain_v1',
            payload: { prompt: 'Follow up', displayText: 'Follow up', existingSessionId: 's1' },
            existingSessionId: 's1',
        } as any);
        vi.mocked(codec.decodeAutomationTemplate).mockReturnValue({
            directory: '/tmp/project',
            prompt: 'Follow up',
            displayText: 'Follow up',
            existingSessionId: 's1',
        } as any);
        automationState.value = {
            id: 'a1',
            enabled: true,
            name: 'Nightly',
            description: null,
            targetType: 'existing_session',
            templateCiphertext: 'template',
            assignments: [{ machineId: 'machine-1', enabled: true, priority: 100 }],
            schedule: {
                kind: 'interval',
                everyMs: 60_000,
                scheduleExpr: null,
                timezone: null,
            },
        };
        sessionState.value = {
            id: 's1',
            encryptionMode: 'plain',
            permissionMode: 'acceptEdits',
            permissionModeUpdatedAt: 123,
            modelMode: 'gpt-5',
            modelModeUpdatedAt: 456,
            metadata: {
                machineId: 'machine-1',
                path: '/tmp/project',
                homeDir: '/tmp',
                profileId: 'profile-1',
                flavor: 'codex',
                codexSessionId: 'codex-session-1',
                codexBackendMode: 'acp',
                acpConfiguredBackendV1: {
                    v: 1,
                    updatedAt: 20,
                    backendId: 'review-bot',
                    title: 'Review Bot',
                },
            },
        } as any;

        const EditRoute = (await import('@/app/(app)/automations/edit')).default;

        await renderScreen(React.createElement(EditRoute));
        await settle();

        const composer = latestAgentInputProps.value;
        await act(async () => {
            composer.onChangeText('Follow up with the latest review summary');
            composer.onPermissionModeChange?.('acceptEdits');
            composer.onModelModeChange?.('gpt-5');
            await composer.onSend();
        });

        expect(updateAutomationSpy).toHaveBeenCalledWith('a1', expect.objectContaining({
            enabled: true,
            name: 'Nightly',
        }));
        expect(updateExistingSessionAutomationTemplateMessageSpy).toHaveBeenCalledWith(expect.objectContaining({
            draft: expect.objectContaining({
                prompt: 'Follow up with the latest review summary',
                displayText: 'Follow up with the latest review summary',
                permissionMode: 'acceptEdits',
                modelId: 'gpt-5',
                existingSessionId: 's1',
            }),
            fallbackDraft: expect.objectContaining({
                backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
                profileId: 'profile-1',
                permissionMode: 'safe-yolo',
                permissionModeUpdatedAt: 123,
                modelId: 'gpt-5',
                modelUpdatedAt: 456,
                codexBackendMode: 'acp',
                automation: null,
                existingSessionId: 's1',
            }),
        }));
        expect(navigateWithBlurOnWebSpy).toHaveBeenCalledTimes(1);
        expect(routerReplaceSpy).toHaveBeenCalledWith('/automations/a1');
        expect(routerBackSpy).not.toHaveBeenCalled();
    });

    it('routes the existing-session save action through the shared composer only', async () => {
        const transport = await import('@/sync/domains/automations/automationTemplateTransport');
        const codec = await import('@/sync/domains/automations/automationTemplateCodec');
        vi.mocked(transport.tryReadAutomationTemplateEnvelopeExistingSessionId).mockReturnValue('s1');
        vi.mocked(transport.tryDecodeAutomationTemplateEnvelope).mockReturnValue({
            kind: 'happier_automation_template_plain_v1',
            payload: { prompt: 'Follow up', displayText: 'Follow up', existingSessionId: 's1' },
            existingSessionId: 's1',
        } as any);
        vi.mocked(codec.decodeAutomationTemplate).mockReturnValue({
            directory: '/tmp/project',
            prompt: 'Follow up',
            displayText: 'Follow up',
            existingSessionId: 's1',
        } as any);
        automationState.value = {
            id: 'a1',
            enabled: true,
            name: 'Nightly',
            description: null,
            targetType: 'existing_session',
            templateCiphertext: 'template',
            assignments: [{ machineId: 'machine-1', enabled: true, priority: 100 }],
            schedule: {
                kind: 'interval',
                everyMs: 60_000,
                scheduleExpr: null,
                timezone: null,
            },
        };
        sessionState.value = {
            id: 's1',
            encryptionMode: 'plain',
            permissionMode: 'acceptEdits',
            permissionModeUpdatedAt: 123,
            modelMode: 'gpt-5',
            modelModeUpdatedAt: 456,
            metadata: {
                machineId: 'machine-1',
                path: '/tmp/project',
                homeDir: '/tmp',
                profileId: 'profile-1',
                flavor: 'codex',
                codexSessionId: 'codex-session-1',
                codexBackendMode: 'acp',
                acpConfiguredBackendV1: {
                    v: 1,
                    updatedAt: 20,
                    backendId: 'review-bot',
                    title: 'Review Bot',
                },
            },
        } as any;

        const EditRoute = (await import('@/app/(app)/automations/edit')).default;

        await renderScreen(React.createElement(EditRoute));
        await settle();

        expect(latestAutomationSettingsFormProps.value).toEqual(expect.objectContaining({
            variant: 'edit',
        }));
        expect(latestAgentInputProps.value).toEqual(expect.objectContaining({
            submitAccessibilityLabel: 'Save automation',
        }));
    });

    it('replaces to the automation detail route from the header back action', async () => {
        const EditRoute = (await import('@/app/(app)/automations/edit')).default;

        await renderScreen(React.createElement(EditRoute));

        navigateWithBlurOnWebSpy.mockClear();
        routerReplaceSpy.mockClear();
        routerBackSpy.mockClear();

        const options = stackOptionsCapture.getResolved();
        expect(typeof options?.headerLeft).toBe('function');

        const headerLeft = options?.headerLeft as (() => React.ReactElement<{
            accessibilityLabel?: string;
            onPress?: () => void;
        }> | null) | undefined;
        const backButton = headerLeft?.();
        expect(backButton?.props.accessibilityLabel).toBe('Back');
        await act(async () => {
            backButton?.props.onPress?.();
        });

        expect(navigateWithBlurOnWebSpy).toHaveBeenCalledTimes(1);
        expect(routerReplaceSpy).toHaveBeenCalledWith('/automations/a1');
        expect(routerBackSpy).not.toHaveBeenCalled();
    });

    it('does not save an existing-session automation when the target session is not resumable', async () => {
        const transport = await import('@/sync/domains/automations/automationTemplateTransport');
        const codec = await import('@/sync/domains/automations/automationTemplateCodec');
        vi.mocked(transport.tryReadAutomationTemplateEnvelopeExistingSessionId).mockReturnValue('s1');
        vi.mocked(transport.tryDecodeAutomationTemplateEnvelope).mockReturnValue({
            kind: 'happier_automation_template_plain_v1',
            payload: { prompt: 'Follow up', displayText: 'Follow up', existingSessionId: 's1' },
            existingSessionId: 's1',
        } as any);
        vi.mocked(codec.decodeAutomationTemplate).mockReturnValue({
            directory: '/tmp/project',
            prompt: 'Follow up',
            displayText: 'Follow up',
            existingSessionId: 's1',
        } as any);
        automationState.value = {
            id: 'a1',
            enabled: true,
            name: 'Nightly',
            description: null,
            targetType: 'existing_session',
            templateCiphertext: 'template',
            assignments: [{ machineId: 'machine-1', enabled: true, priority: 100 }],
            schedule: {
                kind: 'interval',
                everyMs: 60_000,
                scheduleExpr: null,
                timezone: null,
            },
        };
        sessionState.value = {
            id: 's1',
            active: true,
            metadata: {
                machineId: 'm1',
                flavor: 'pi',
                piSessionId: 'pi-session-1',
            },
        };

        const EditRoute = (await import('@/app/(app)/automations/edit')).default;

        await renderScreen(React.createElement(EditRoute));
        await settle();

        expect(latestAgentInputProps.value).toBeNull();
        expect(updateAutomationSpy).not.toHaveBeenCalled();
        expect(routerReplaceSpy).not.toHaveBeenCalled();
    });
});
