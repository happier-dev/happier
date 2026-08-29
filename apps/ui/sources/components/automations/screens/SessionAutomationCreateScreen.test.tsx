import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { installAutomationScreensCommonModuleMocks } from './automationScreensTestHelpers';
import type { StorageState } from '@/sync/store/types';
import React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findTestInstanceByTypeContainingText, invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const syncSpies = vi.hoisted(() => ({
    saveAutomationEditorDraft: vi.fn(async (_input: any, _options?: any) => ({})),
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
const storageState = vi.hoisted(() => ({
    value: {} as Record<string, unknown>,
}));
const hydrateReadyState = vi.hoisted(() => ({
    ready: true,
}));

const routerBackSpy = vi.hoisted(() => vi.fn());
const routerReplaceSpy = vi.hoisted(() => vi.fn());
const modalAlertSpy = vi.hoisted(() => vi.fn(async () => {}));
const navigateWithBlurOnWebSpy = vi.hoisted(() => vi.fn((action: () => void) => action()));
const latestComposerProps = vi.hoisted(() => ({
    value: null as any,
}));
const latestContextSectionProps = vi.hoisted(() => ({
    value: null as any,
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/utils/platform/deferOnWeb', () => ({
    navigateWithBlurOnWeb: navigateWithBlurOnWebSpy,
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: any) => React.createElement('Switch', props),
}));

vi.mock('@/components/automations/shared/ExistingSessionAutomationComposer', () => ({
    ExistingSessionAutomationComposer: (props: any) => {
        latestComposerProps.value = props;
        return React.createElement('ExistingSessionAutomationComposer', props);
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

installAutomationScreensCommonModuleMocks({
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: { back: routerBackSpy, replace: routerReplaceSpy },
        }).module;
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: modalAlertSpy,
                confirm: vi.fn(),
                prompt: vi.fn(),
            },
        }).module;
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSession: () => sessionState.session,
            useSessions: () => Object.values(
                (storageState.value as { sessions?: Record<string, unknown> }).sessions ?? {},
            ),
            useActiveServerAccountScope: () => (
                (storageState.value as { profileScope?: unknown }).profileScope ?? null
            ),
            useSettings: () => ({}),
            storage: Object.assign(
                ((selector?: (value: StorageState) => unknown) => (
                    typeof selector === 'function'
                        ? selector(storageState.value as unknown as StorageState)
                        : (storageState.value as unknown as StorageState)
                )),
                {
                    getState: () => storageState.value as unknown as StorageState,
                    getInitialState: () => storageState.value as unknown as StorageState,
                    setState: () => undefined,
                    subscribe: () => () => undefined,
                    destroy: () => undefined,
                },
            ),
        });
    },
    text: {
        translate: (key: string) => {
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
        },
    },
});

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: (sessionId: string) => hydrateReadyState.ready
        ? { kind: 'available', sessionId }
        : { kind: 'loading', sessionId, reason: 'store-miss' },
}));

vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
    captureActiveServerAccountScopeLifetime: () => {
        const scope = (storageState.value as {
            profileScope?: { serverId: string; accountId: string };
        }).profileScope;
        if (!scope) return null;
        return {
            scope,
            isCurrent: () => {
                const current = (storageState.value as {
                    profileScope?: { serverId: string; accountId: string };
                }).profileScope;
                return current?.serverId === scope.serverId && current.accountId === scope.accountId;
            },
            onRetire: () => ({ dispose: () => undefined }),
        };
    },
}));

vi.mock('@/sync/domains/server/serverRuntime', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/domains/server/serverRuntime')>(),
    getActiveServerSnapshot: () => ({ serverId: 'server-1' }),
}));

vi.mock('@/hooks/server/useAutomationsSupport', () => ({
    useAutomationsSupport: () => ({ enabled: true }),
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
    await flushHookEffects({ cycles: 1, turns: 1 });
}

function setStorageForSession(input: {
    session: any;
    projectMachineId?: string | null;
    includeProject?: boolean;
}) {
    const session = input.session
        ? { ...input.session, serverId: input.session.serverId ?? 'server-1' }
        : input.session;
    sessionState.session = session;
    const sessionId = String(session?.id ?? '');
    const sessionMachineId = typeof session?.metadata?.machineId === 'string'
        ? session.metadata.machineId
        : null;
    const projectMachineId = input.projectMachineId ?? sessionMachineId;
    const sessionPath = typeof session?.metadata?.path === 'string'
        ? session.metadata.path
        : null;

    storageState.value = {
        profileScope: { serverId: session?.serverId ?? 'server-1', accountId: 'account-1' },
        sessions: sessionId ? { [sessionId]: session } : {},
        machines: projectMachineId
            ? {
                [projectMachineId]: {
                    id: projectMachineId,
                    active: true,
                    activeAt: 1,
                    metadata: { host: 'mbp-host' },
                },
            }
            : {},
        getProjectForSession: (candidateSessionId: string) => {
            if (!input.includeProject || candidateSessionId !== sessionId || !projectMachineId || !sessionPath) {
                return null;
            }
            return {
                key: {
                    machineId: projectMachineId,
                    rootPath: sessionPath,
                },
            };
        },
    };
}

function setStorageForSessionWithMachineReplacement(input: {
    session: any;
    staleMachineId: string;
    replacementMachineId: string;
}) {
    const session = input.session
        ? { ...input.session, serverId: input.session.serverId ?? 'server-1' }
        : input.session;
    sessionState.session = session;
    const sessionId = String(session?.id ?? '');
    const sessionPath = typeof session?.metadata?.path === 'string'
        ? session.metadata.path
        : null;

    storageState.value = {
        profileScope: { serverId: session?.serverId ?? 'server-1', accountId: 'account-1' },
        sessions: sessionId ? { [sessionId]: session } : {},
        machines: {
            [input.staleMachineId]: {
                id: input.staleMachineId,
                active: false,
                replacedByMachineId: input.replacementMachineId,
                activeAt: 1,
                metadata: { host: 'mbp-host' },
            },
            [input.replacementMachineId]: {
                id: input.replacementMachineId,
                active: true,
                activeAt: 2,
                metadata: { host: 'mbp-host' },
            },
        },
        getProjectForSession: (candidateSessionId: string) => {
            if (!sessionPath || candidateSessionId !== sessionId) {
                return null;
            }
            return {
                key: {
                    machineId: input.replacementMachineId,
                    rootPath: sessionPath,
                },
            };
        },
    };
}

function getComposerProps() {
    const composer = latestComposerProps.value;
    if (!composer) {
        throw new Error('Existing-session automation composer props were not captured');
    }
    return composer;
}

async function setComposerText(value: string): Promise<void> {
    const { updateSessionAuthoringDraftPrompt } = await import('@/components/sessions/authoring/draft/updateSessionAuthoringDraftFields');
    await act(async () => {
        getComposerProps().onChangeDraft((current: any) => current
            ? updateSessionAuthoringDraftPrompt(current, value)
            : current);
    });
}

async function submitComposer(): Promise<void> {
    await act(async () => {
        await getComposerProps().onSubmit();
    });
}

describe('SessionAutomationCreateScreen', () => {
    beforeEach(() => {
        invalidateAccountEncryptionModeCache();
        hydrateReadyState.ready = true;
        sessionState.session = {
            id: 's1',
            serverId: 'server-1',
            active: true,
            encryptionMode: 'e2ee',
            metadata: {
                machineId: 'm1',
                path: '/tmp/project',
                homeDir: '/tmp',
                flavor: 'claude',
                claudeSessionId: 'claude-session-1',
                claudeTranscriptPath: '/tmp/claude-session-1.jsonl',
            },
        };
        setStorageForSession({
            session: sessionState.session,
            projectMachineId: 'm1',
            includeProject: true,
        });
        syncSpies.saveAutomationEditorDraft.mockClear();
        syncSpies.refreshAutomations.mockClear();
        syncSpies.getSessionEncryptionKeyBase64ForResume.mockClear();
        syncSpies.getCredentials.mockClear();
        syncSpies.encryption.encryptAutomationTemplateRaw.mockClear();
        latestComposerProps.value = null;
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
                claudeTranscriptPath: '/tmp/claude-session-1.jsonl',
            },
        };
        setStorageForSessionWithMachineReplacement({
            session: sessionState.session,
            staleMachineId: 'm-stale',
            replacementMachineId: 'm-target',
        });

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

        expect(latestComposerProps.value?.submitAccessibilityLabel).toBe('Create automation');
        expect(findTestInstanceByTypeContainingText(screen.tree, 'Pressable', 'Create automation')).toBeUndefined();
    });

    it('mounts the canonical plural Automation editor directly above the shared composer', async () => {
        const { SessionAutomationCreateScreen } = await import('./SessionAutomationCreateScreen');

        const screen = await renderScreen(<SessionAutomationCreateScreen sessionId="s1" />);
        await flushRender();

        expect(screen.findByProps({ testID: 'automation-plural-editor' })).toBeTruthy();
        expect(screen.findAllByType('Switch')).toHaveLength(1);
        expect(latestComposerProps.value?.extraActionChips).toBeUndefined();
    });

    it('omits hidden and non-resumable Sessions from exact-turn source options', async () => {
        const ordinaryMetadata = {
            flavor: 'claude',
            claudeSessionId: 'claude-ordinary',
            claudeTranscriptPath: '/tmp/claude-ordinary.jsonl',
        };
        storageState.value.sessions = {
            ...(storageState.value.sessions as Record<string, unknown>),
            ordinary: {
                id: 'ordinary',
                serverId: 'server-1',
                latestTurnId: 'turn-ordinary',
                latestTurnStatus: 'in_progress',
                metadata: ordinaryMetadata,
            },
            hidden: {
                id: 'hidden',
                serverId: 'server-1',
                latestTurnId: 'turn-hidden',
                latestTurnStatus: 'in_progress',
                metadata: {
                    ...ordinaryMetadata,
                    systemSessionV1: { v: 1, key: 'voice_transcript_history', hidden: true },
                },
            },
            nonResumable: {
                id: 'nonResumable',
                serverId: 'server-1',
                latestTurnId: 'turn-non-resumable',
                latestTurnStatus: 'in_progress',
                metadata: { flavor: 'claude' },
            },
        };
        const { SessionAutomationCreateScreen } = await import('./SessionAutomationCreateScreen');
        const screen = await renderScreen(<SessionAutomationCreateScreen sessionId="s1" />);
        await flushRender();

        const editor = screen.find((node) => (
            node.props.variant === 'embedded'
            && typeof node.props.value?.pendingAutomationId === 'string'
        ));
        expect(editor.props.value).not.toHaveProperty('executionRecipe');
        expect(editor.props.value).not.toHaveProperty('assignments');
        expect(editor.props.sessionOptions.map((option: { sessionId: string }) => option.sessionId))
            .toEqual(['ordinary']);
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

        expect(syncSpies.saveAutomationEditorDraft).toHaveBeenCalledTimes(1);
        expect(syncSpies.saveAutomationEditorDraft.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
            enabled: false,
        }));
    });

    it('establishes the submit fence synchronously before recipe encryption', async () => {
        let resolveEncryption!: (value: string) => void;
        const encryption = new Promise<string>((resolve) => {
            resolveEncryption = resolve;
        });
        syncSpies.encryption.encryptAutomationTemplateRaw.mockReturnValueOnce(encryption);
        const { SessionAutomationCreateScreen } = await import('./SessionAutomationCreateScreen');

        await renderScreen(<SessionAutomationCreateScreen sessionId="s1" />);
        await flushRender();
        await setComposerText('Do the thing');

        await act(async () => {
            getComposerProps().onSubmit();
            getComposerProps().onSubmit();
            await Promise.resolve();
        });

        expect(syncSpies.encryption.encryptAutomationTemplateRaw).toHaveBeenCalledTimes(1);
        expect(syncSpies.saveAutomationEditorDraft).not.toHaveBeenCalled();

        await act(async () => {
            resolveEncryption('ciphertext-base64');
            await encryption;
            await Promise.resolve();
        });
        expect(syncSpies.saveAutomationEditorDraft).toHaveBeenCalledTimes(1);
    });

    it('seals existingSessionId in the existing-session automation template for the reachable machine target', async () => {
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
                claudeTranscriptPath: '/tmp/claude-session-1.jsonl',
            },
        };
        setStorageForSessionWithMachineReplacement({
            session: sessionState.session,
            staleMachineId: 'm-stale',
            replacementMachineId: 'm-target',
        });

        const { SessionAutomationCreateScreen } = await import('./SessionAutomationCreateScreen');

        const screen = await renderScreen(<SessionAutomationCreateScreen sessionId="s1" />);
        await flushRender();

        await setComposerText('Do the thing');

        const name = screen.findByProps({ testID: 'automation-name' });
        await act(async () => {
            name.props.onChangeText('My automation');
        });

        await submitComposer();

        expect(syncSpies.saveAutomationEditorDraft).toHaveBeenCalledTimes(1);
        const input = syncSpies.saveAutomationEditorDraft.mock.calls[0][0];
        expect(input.executionRecipe.target).toEqual({ kind: 'existingSession', sessionId: 's1' });
        expect(input.assignments).toEqual([{ machineId: 'm-target', enabled: true, priority: 100 }]);
        expect(input.executionRecipe.template).toEqual({ t: 'encrypted', c: 'ciphertext-base64' });
        expect(syncSpies.encryption.encryptAutomationTemplateRaw).toHaveBeenCalledWith({
            v: 1,
            prompt: 'Do the thing',
        });
    });

    it('creates an existing-session automation from persisted session metadata when machine inventory has not hydrated yet', async () => {
        sessionState.session = {
            id: 's1',
            active: false,
            encryptionMode: 'e2ee',
            metadata: {
                machineId: 'm-persisted',
                path: '/tmp/project',
                homeDir: '/tmp',
                flavor: 'claude',
                claudeSessionId: 'claude-session-1',
                claudeTranscriptPath: '/tmp/claude-session-1.jsonl',
            },
        };
        setStorageForSession({
            session: sessionState.session,
            projectMachineId: null,
            includeProject: false,
        });

        const { SessionAutomationCreateScreen } = await import('./SessionAutomationCreateScreen');

        await renderScreen(<SessionAutomationCreateScreen sessionId="s1" />);
        await flushRender();

        await setComposerText('Do the thing');
        await submitComposer();

        expect(syncSpies.saveAutomationEditorDraft).toHaveBeenCalledTimes(1);
        expect(syncSpies.saveAutomationEditorDraft.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
            assignments: [{ machineId: 'm-persisted', enabled: true, priority: 100 }],
        }));
    });

    it('keeps mutable Session runtime fields out of the frozen existing-session prompt program', async () => {
        sessionState.session = {
            id: 's1',
            active: true,
            encryptionMode: 'e2ee',
            permissionMode: 'safe-yolo',
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
        setStorageForSession({
            session: sessionState.session,
            projectMachineId: 'm1',
            includeProject: true,
        });

        const { SessionAutomationCreateScreen } = await import('./SessionAutomationCreateScreen');

        const screen = await renderScreen(<SessionAutomationCreateScreen sessionId="s1" />);
        await flushRender();

        await setComposerText('Send the latest automation QA summary into this session.');

        await submitComposer();

        expect(syncSpies.encryption.encryptAutomationTemplateRaw).toHaveBeenCalledTimes(1);
        expect(syncSpies.encryption.encryptAutomationTemplateRaw.mock.calls[0][0]).toEqual({
            v: 1,
            prompt: 'Send the latest automation QA summary into this session.',
        });
    });

    it('navigates to the created Automation detail using the committed identity', async () => {
        syncSpies.saveAutomationEditorDraft.mockResolvedValueOnce({ id: 'automation-created' });
        const { SessionAutomationCreateScreen } = await import('./SessionAutomationCreateScreen');

        const screen = await renderScreen(<SessionAutomationCreateScreen sessionId="s1" />);
        await flushRender();

        await setComposerText('Do the thing');

        await submitComposer();

        expect(navigateWithBlurOnWebSpy).toHaveBeenCalledTimes(1);
        expect(routerReplaceSpy).toHaveBeenCalledWith('/automations/automation-created');
        expect(routerBackSpy).not.toHaveBeenCalled();
    });

    it('consumes a committed create response even when the exact source turn completes in flight', async () => {
        const { SessionAutomationCreateScreen } = await import('./SessionAutomationCreateScreen');

        const screen = await renderScreen(<SessionAutomationCreateScreen sessionId="s1" />);
        await flushRender();

        await setComposerText('Do the thing when this turn finishes');

        const name = screen.findByProps({ testID: 'automation-name' });
        await act(async () => {
            name.props.onChangeText('Exact turn automation');
        });

        // One exact-turn row sourced from the other working session.
        const sourceSession = {
            id: 's2',
            serverId: 'server-1',
            active: true,
            latestTurnId: 'turn-9',
            latestTurnStatus: 'in_progress',
            encryptionMode: 'e2ee',
            metadata: {
                machineId: 'm1',
                path: '/tmp/project',
                homeDir: '/tmp',
                flavor: 'claude',
                claudeSessionId: 'claude-session-2',
                claudeTranscriptPath: '/tmp/claude-session-2.jsonl',
            },
        };
        storageState.value.sessions = {
            ...(storageState.value.sessions as Record<string, unknown>),
            s2: sourceSession,
        };
        const editorElement = screen.find((node) => (
            node.props.variant === 'embedded'
            && typeof node.props.value?.pendingAutomationId === 'string'
        ));
        const editorDraft = editorElement.props.value;
        await act(async () => {
            editorElement.props.onChange({
                ...editorDraft,
                triggers: [...editorDraft.triggers, {
                    clientId: '00000000-0000-4000-8000-000000000009',
                    persisted: null,
                    definition: {
                        kind: 'sessionLifecycle',
                        enabled: true,
                        event: 'parentTurnCompleted',
                        scope: { kind: 'exactTurn', sourceSessionId: 's2', sourceTurnId: 'turn-9' },
                        consumption: 'once',
                    },
                }],
            });
        });

        let releaseSave: (() => void) | null = null;
        syncSpies.saveAutomationEditorDraft.mockImplementationOnce(() => new Promise((resolve) => {
            releaseSave = () => resolve({ id: 'automation-exact-turn' });
        }));

        await submitComposer();
        expect(syncSpies.saveAutomationEditorDraft).toHaveBeenCalledTimes(1);
        const saveOptions = syncSpies.saveAutomationEditorDraft.mock.calls[0][1] as {
            isCurrent?: () => boolean;
        };
        expect(typeof saveOptions?.isCurrent).toBe('function');
        expect(saveOptions.isCurrent?.()).toBe(true);

        // The canonical Session settlement completes the source turn before the
        // HTTP response resumes. The response fence owns Account/server/editor
        // lifetime, not source-turn state, so the committed response stays
        // consumable and the admitted trigger is not reported stale.
        storageState.value.sessions = {
            ...(storageState.value.sessions as Record<string, unknown>),
            s2: { ...sourceSession, latestTurnStatus: 'completed' },
        };
        await act(async () => {});
        expect(saveOptions.isCurrent?.()).toBe(true);

        await act(async () => {
            releaseSave?.();
        });
        expect(routerReplaceSpy).toHaveBeenCalledWith('/automations/automation-exact-turn');
        expect(modalAlertSpy).not.toHaveBeenCalled();
    });

    it('refuses an exact-turn create when the drafted source turn is already complete before submission', async () => {
        const sourceSession = {
            id: 's2',
            serverId: 'server-1',
            active: true,
            latestTurnId: 'turn-9',
            latestTurnStatus: 'in_progress',
            encryptionMode: 'e2ee',
            metadata: { machineId: 'm1', path: '/tmp/project', homeDir: '/tmp' },
        };
        storageState.value.sessions = {
            ...(storageState.value.sessions as Record<string, unknown>),
            s2: sourceSession,
        };
        const { SessionAutomationCreateScreen } = await import('./SessionAutomationCreateScreen');
        const screen = await renderScreen(<SessionAutomationCreateScreen sessionId="s1" />);
        await flushRender();
        await setComposerText('Do the thing when this turn finishes');

        const editorElement = screen.find((node) => (
            node.props.variant === 'embedded'
            && typeof node.props.value?.pendingAutomationId === 'string'
        ));
        const editorDraft = editorElement.props.value;
        await act(async () => {
            editorElement.props.onChange({
                ...editorDraft,
                triggers: [...editorDraft.triggers, {
                    clientId: '00000000-0000-4000-8000-000000000010',
                    persisted: null,
                    definition: {
                        kind: 'sessionLifecycle',
                        enabled: true,
                        event: 'parentTurnCompleted',
                        scope: { kind: 'exactTurn', sourceSessionId: 's2', sourceTurnId: 'turn-9' },
                        consumption: 'once',
                    },
                }],
            });
        });
        storageState.value.sessions = {
            ...(storageState.value.sessions as Record<string, unknown>),
            s2: { ...sourceSession, latestTurnStatus: 'completed' },
        };

        await submitComposer();

        expect(syncSpies.saveAutomationEditorDraft).not.toHaveBeenCalled();
        expect(modalAlertSpy).toHaveBeenCalledWith(
            'automations.exactTurn.staleTitle',
            'automations.exactTurn.staleBody',
        );
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
                claudeTranscriptPath: '/tmp/claude-session-plain-1.jsonl',
            },
        };
        setStorageForSession({
            session: sessionState.session,
            projectMachineId: 'm1',
            includeProject: true,
        });
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

        expect(syncSpies.saveAutomationEditorDraft).toHaveBeenCalledTimes(1);
        const input = syncSpies.saveAutomationEditorDraft.mock.calls[0][0];
        expect(input.executionRecipe.target).toEqual({ kind: 'existingSession', sessionId: 's_plain' });
        expect(input.executionRecipe.template).toEqual({
            t: 'plain',
            v: { v: 1, prompt: 'Hello' },
        });
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
                flavor: 'claude',
            },
        };
        setStorageForSession({
            session: sessionState.session,
            projectMachineId: 'm1',
            includeProject: true,
        });
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
        expect(screen.findAllByType('ExistingSessionAutomationContextSection')).toHaveLength(0);
        expect(screen.findAllByType('ExistingSessionAutomationComposer')).toHaveLength(0);
        expect(syncSpies.saveAutomationEditorDraft).not.toHaveBeenCalled();
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
                claudeTranscriptPath: '/tmp/claude-session-1.jsonl',
            },
        };
        setStorageForSession({
            session: sessionState.session,
            projectMachineId: 'm1',
            includeProject: true,
        });
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

        expect(syncSpies.saveAutomationEditorDraft).toHaveBeenCalledTimes(1);
    });

    it('retires the mounted editor draft when the active account scope changes', async () => {
        const { SessionAutomationCreateScreen } = await import('./SessionAutomationCreateScreen');

        const screen = await renderScreen(<SessionAutomationCreateScreen sessionId="s1" />);
        await flushRender();

        // Author content into the draft mounted for account-1.
        const mountedNameInput = screen.findByProps({ testID: 'automation-name' });
        await act(async () => {
            mountedNameInput.props.onChangeText('Account-1 only draft');
        });
        await act(async () => {
            screen.findByProps({ testID: 'automation-trigger-add' }).props.onPress();
        });
        await act(async () => {
            screen.findByProps({ testID: 'automation-trigger-kind-schedule' }).props.onPress();
        });
        const editorValue = () => screen.find((node) => (
            node.props.variant === 'embedded'
            && typeof node.props.value?.pendingAutomationId === 'string'
        )).props.value;
        expect(editorValue().triggers).toHaveLength(1);

        storageState.value = {
            ...storageState.value,
            profileScope: { serverId: 'server-1', accountId: 'account-2' },
        };
        await screen.update(<SessionAutomationCreateScreen sessionId="s1" />);
        await flushRender();

        // The mounted draft belonged to the predecessor account identity: the
        // successor account starts from a fresh draft and can never inherit or
        // save the predecessor's name or triggers.
        expect(screen.findByProps({ testID: 'automation-name' }).props.value).toBe('Scheduled message');
        expect(editorValue().triggers).toHaveLength(0);
        expect(syncSpies.saveAutomationEditorDraft).not.toHaveBeenCalled();
    });
});
