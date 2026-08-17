import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { createNewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';
import * as React from 'react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { Platform } from 'react-native';
import type { ComposerAttachmentDraftV1, ComposerSnapshotV1 } from '@happier-dev/protocol';

import type { PickedAttachment } from '@/components/sessions/attachments/AttachmentFilePicker.types';
import type { NewSessionComposerDocument } from '@/components/sessions/new/hooks/screenModel/useNewSessionComposerDocument';
import { useNewSessionComposerDocument } from '@/components/sessions/new/hooks/screenModel/useNewSessionComposerDocument';
import type { HandleCreateSessionOptions } from '@/components/sessions/new/hooks/useCreateNewSession';
import type { NewSessionLaunchAttempt } from '@/components/sessions/new/modules/newSessionLaunchAttempt';
import type { ComposerSubmissionSnapshot } from '@/components/sessions/composer/composerSubmissionCoordinator';
import { installNewSessionScreenModelCommonModuleMocks } from '@/components/sessions/new/hooks/newSessionScreenModelTestHelpers';
import {
    clearAllNewSessionAttachmentDrafts,
    readNewSessionAttachmentDrafts,
} from './newSessionAttachmentDraftStore';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const uploadAttachmentDraftsToSessionSpy = vi.hoisted(() => vi.fn());
const formatAttachmentsBlockSpy = vi.hoisted(() => vi.fn(() => '[attachments block]'));
const followUpSpawnedSessionWithServerScopeSpy = vi.hoisted(() => vi.fn(async (_params: unknown) => undefined));
const featureEnabledSpy = vi.hoisted(() => vi.fn((featureId: string) => featureId === 'attachments.uploads'));
const workspaceReviewDraftsState = vi.hoisted(() => ({
    draftsByRootPath: new Map<string, Array<{
        id: string;
        filePath: string;
        source: 'file' | 'diff';
        anchor: Record<string, unknown>;
        snapshot: {
            selectedLines: string[];
            beforeContext: string[];
            afterContext: string[];
        };
        body: string;
        includeInPrompt?: boolean;
        createdAt: number;
    }>>(),
}));
const clearWorkspaceReviewCommentDraftsSpy = vi.hoisted(() => vi.fn());
const upsertWorkspaceReviewCommentDraftSpy = vi.hoisted(() => vi.fn());
const deleteWorkspaceReviewCommentDraftSpy = vi.hoisted(() => vi.fn());
const reviewDraftHandlerScopeSpy = vi.hoisted(() => vi.fn());
const modalAlertSpy = vi.hoisted(() => vi.fn());
const modalShowSpy = vi.hoisted(() => vi.fn());
const resolveReviewCommentDraftAnchorsForPromptSpy = vi.hoisted(() => vi.fn(async (input: {
    drafts: Array<Record<string, unknown>>;
}) => input.drafts));
const readCachedSnapshotForMachinePathMock = vi.hoisted(() => vi.fn((_input: Readonly<{
    machineId: string;
    path: string;
}>) => null));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureEnabledSpy(featureId),
}));

vi.mock('@/components/workspaces/files/details/workspaceFileDetails/useWorkspaceReviewCommentDraftHandlers', () => ({
    useWorkspaceReviewCommentDraftHandlers: (scope: WorkspaceScopeBase | null) => {
        reviewDraftHandlerScopeSpy(scope);
        return {
            onUpsertReviewCommentDraft: upsertWorkspaceReviewCommentDraftSpy,
            onDeleteReviewCommentDraft: deleteWorkspaceReviewCommentDraftSpy,
            onReviewCommentError: vi.fn(),
            clearReviewCommentDrafts: clearWorkspaceReviewCommentDraftsSpy,
        };
    },
}));

vi.mock('@/components/sessions/attachments/useAttachmentsUploadConfig', () => ({
    useAttachmentsUploadConfig: () => ({
        uploadLocation: 'workspace',
        workspaceRelativeDir: '.happier/uploads',
        vcsIgnoreStrategy: 'git_info_exclude',
        vcsIgnoreWritesEnabled: true,
        maxFileBytes: 25 * 1024 * 1024,
    }),
}));

vi.mock('@/components/sessions/attachments/uploadAttachmentDraftsToSession', () => ({
    uploadAttachmentDraftsToSession: uploadAttachmentDraftsToSessionSpy,
    formatAttachmentsBlock: formatAttachmentsBlockSpy,
    buildAttachmentMessageMeta: (uploaded: unknown) => ({
        happier: {
            kind: 'attachments.v1',
            payload: {
                attachments: uploaded,
            },
        },
    }),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/followUpSpawnedSession', () => ({
    followUpSpawnedSessionWithServerScope: followUpSpawnedSessionWithServerScopeSpy,
}));

vi.mock('@/components/sessions/reviews/comments/resolveReviewCommentDraftAnchorsForPrompt', () => ({
    resolveReviewCommentDraftAnchorsForPrompt: resolveReviewCommentDraftAnchorsForPromptSpy,
}));

vi.mock('@/scm/scmRepositoryService', () => ({
    scmRepositoryService: {
        readCachedSnapshotForMachinePath: (input: Readonly<{
            machineId: string;
            path: string;
        }>) => readCachedSnapshotForMachinePathMock(input),
    },
}));

vi.mock('@/utils/platform/deferOnWeb', () => ({
    blurActiveElementOnWeb: vi.fn(),
    deferOnWeb: (callback: () => void) => callback(),
}));

installNewSessionScreenModelCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                show: (...args: unknown[]) => modalShowSpy(...args),
                alert: (...args: unknown[]) => modalAlertSpy(...args),
                confirm: vi.fn(),
                prompt: vi.fn(),
            },
        }).module;
    },
    storage: async (importOriginal) => {
        const original = await importOriginal<any>();
        return {
            ...original,
            useWorkspaceReviewCommentsDrafts: (scope: WorkspaceScopeBase | null | undefined) => (
                scope ? (workspaceReviewDraftsState.draftsByRootPath.get(scope.rootPath) ?? []) : []
            ),
        };
    },
});

type HookValue = ReturnType<typeof import('./useNewSessionAttachmentsController').useNewSessionAttachmentsController>;

async function renderHook(
    useValue: () => HookValue,
): Promise<{ getCurrent: () => HookValue; rerender: () => Promise<void>; unmount: () => void }> {
    let current: HookValue | null = null;

    function Probe() {
        current = useValue();
        return null;
    }

    let tree: renderer.ReactTestRenderer | null = null;
    await act(async () => {
        tree = renderer.create(<Probe />);
        await flushHookEffects({ cycles: 1, turns: 1 });
    });

    return {
        getCurrent: () => {
            if (!current) throw new Error('hook not rendered');
            return current;
        },
        rerender: async () => {
            await act(async () => {
                tree!.update(<Probe />);
                await flushHookEffects({ cycles: 1, turns: 1 });
            });
        },
        unmount: async () => {
            await act(async () => {
                tree?.unmount();
                await flushHookEffects({ cycles: 1, turns: 1 });
            });
        },
    };
}

function createComposerSnapshot(input: Readonly<{
    text: string;
    attachments: readonly ComposerAttachmentDraftV1[];
    references?: ComposerSnapshotV1['references'];
    availability?: ComposerSnapshotV1['attachments'][number]['availability'];
}>): ComposerSnapshotV1 {
    return {
        revision: 7,
        ref: { kind: 'newSession', instanceId: 'new-session-composer-scope' },
        text: input.text,
        references: input.references ?? [],
        attachments: input.attachments.map((attachment) => ({
            ...attachment,
            availability: input.availability ?? { status: 'ready' },
        })),
        layout: 'wrap',
        capabilities: {
            text: true,
            references: true,
            attachments: true,
            submit: true,
        },
        state: {
            focused: false,
            editable: true,
            submittable: true,
            submitting: false,
            running: false,
        },
    };
}

function createComposerDocument(input: Readonly<{
    attachments: readonly ComposerAttachmentDraftV1[];
    snapshot: ComposerSnapshotV1 | null;
}>): Readonly<{
    composerDocument: NewSessionComposerDocument;
    captureSubmissionSnapshot: ReturnType<typeof vi.fn>;
    clearAcceptedSnapshot: ReturnType<typeof vi.fn>;
}> {
    const captureSubmissionSnapshot = vi.fn((_inputTextOverride?: string) => input.snapshot);
    const clearAcceptedSnapshot = vi.fn((_snapshot: ComposerSubmissionSnapshot) => true);
    return {
        composerDocument: {
            ref: { kind: 'newSession', instanceId: 'new-session-composer-scope' },
            isCurrent: () => true,
            isReferenceSearchCurrent: () => true,
            revision: 7,
            attachments: input.attachments,
            structuredInputMentions: [],
            onStructuredInputMentionsChange: () => {},
            onComposerFocusChange: () => {},
            onComposerFocusRequestChange: () => {},
            onComposerActionBarLayoutChange: () => {},
            composerDecorations: [],
            composerInputLock: null,
            attachmentRowItems: [],
            hasSendableAttachments: input.attachments.length > 0,
            extraActionChips: [],
            beforeComposer: null,
            afterComposer: null,
            captureSubmissionSnapshot,
            clearAcceptedSnapshot,
        },
        captureSubmissionSnapshot,
        clearAcceptedSnapshot,
    };
}

function createLaunchAttempt(): NewSessionLaunchAttempt {
    return {
        attemptId: 'new-session-attempt-1',
        spawnNonce: 'new-session-spawn-1',
        scopeKey: 'server-a:account-a',
        createdSessionId: null,
        firstTurnLocalId: 'new-session-first-turn-1',
        attachmentMessageLocalId: 'new-session-attachment-local-1',
        status: 'created',
        prompt: {
            prompt: '',
            displayText: '',
            meta: null,
        },
        phaseErrors: {},
    };
}

describe('useNewSessionAttachmentsController (attachments.uploads)', () => {
    beforeEach(() => {
        clearAllNewSessionAttachmentDrafts();
        uploadAttachmentDraftsToSessionSpy.mockReset();
        formatAttachmentsBlockSpy.mockClear();
        followUpSpawnedSessionWithServerScopeSpy.mockReset();
        featureEnabledSpy.mockClear();
        workspaceReviewDraftsState.draftsByRootPath.clear();
        clearWorkspaceReviewCommentDraftsSpy.mockReset();
        upsertWorkspaceReviewCommentDraftSpy.mockReset();
        deleteWorkspaceReviewCommentDraftSpy.mockReset();
        reviewDraftHandlerScopeSpy.mockReset();
        modalAlertSpy.mockReset();
        modalShowSpy.mockReset();
        resolveReviewCommentDraftAnchorsForPromptSpy.mockReset();
        resolveReviewCommentDraftAnchorsForPromptSpy.mockImplementation(async (input: {
            drafts: Array<Record<string, unknown>>;
        }) => input.drafts);
        readCachedSnapshotForMachinePathMock.mockReset();
        readCachedSnapshotForMachinePathMock.mockImplementation(() => null);
    });

    it('passes a live input text override through simple sends before prompt state catches up', async () => {
        const { useNewSessionAttachmentsController } = await import('./useNewSessionAttachmentsController');
        const handleCreateSession = vi.fn();
        const hook = await renderHook(() => useNewSessionAttachmentsController({
            flowId: 'flow-live-text',
            isCreating: false,
            promptStore: createNewSessionPromptStore(''),
            handleCreateSession,
            selectedProfileId: null,
            targetServerId: 'server-a',
            baseActionChips: [],
        }));

        await act(async () => {
            hook.getCurrent().handleSend({ inputTextOverride: 'large live prompt' });
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(handleCreateSession).toHaveBeenCalledWith({ inputTextOverride: 'large live prompt' });
        await hook.unmount();
    });

    it('routes a text-only mounted Composer through one coordinator admission and preserves text edited before acceptance', async () => {
        const { useNewSessionAttachmentsController } = await import('./useNewSessionAttachmentsController');
        const promptStore = createNewSessionPromptStore('Original text-only first turn');
        const handleCreateSession = vi.fn();
        const canSubmitRef = { current: true };
        const mountedComposerDocument = { current: null as NewSessionComposerDocument | null };
        const hook = await renderHook(() => {
            mountedComposerDocument.current = useNewSessionComposerDocument({
                promptStore,
                persistedAttachments: [],
                composerAttachmentEntriesById: {},
                scopeKey: 'server-a/account-a',
                canSubmitRef,
                isSubmitting: false,
            });
            return useNewSessionAttachmentsController({
                flowId: 'flow-text-only-composer',
                isCreating: false,
                promptStore,
                handleCreateSession,
                selectedProfileId: null,
                targetServerId: 'server-a',
                baseActionChips: [],
                composerDocument: mountedComposerDocument.current,
            });
        });

        await act(async () => {
            hook.getCurrent().handleSend();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(handleCreateSession).toHaveBeenCalledTimes(1);
        expect(handleCreateSession).toHaveBeenCalledWith(expect.objectContaining({
            initialMessage: 'skip',
            afterCreated: expect.any(Function),
            onAfterCreatedSettled: expect.any(Function),
            deferAcceptedDraftClearToDocument: true,
        }));

        const createOptions = handleCreateSession.mock.calls[0]?.[0] as HandleCreateSessionOptions | undefined;
        const afterCreated = createOptions?.afterCreated;
        const onAfterCreatedSettled = createOptions?.onAfterCreatedSettled;
        const composerDocument = mountedComposerDocument.current;
        if (!afterCreated || !onAfterCreatedSettled || !composerDocument) {
            throw new Error('expected coordinator-owned New Session admission callbacks');
        }

        await act(async () => {
            await afterCreated({
                sessionId: 'session-text-only',
                effectiveSpawnServerId: 'server-a',
                launchAttempt: createLaunchAttempt(),
            });
            promptStore.setPrompt('Newer text typed before acceptance');
            await flushHookEffects({ cycles: 1, turns: 1 });
            onAfterCreatedSettled({ status: 'accepted', sessionId: 'session-text-only' });
            await Promise.resolve();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(followUpSpawnedSessionWithServerScopeSpy).toHaveBeenCalledTimes(1);
        expect(followUpSpawnedSessionWithServerScopeSpy).toHaveBeenCalledWith({
            sessionId: 'session-text-only',
            targetServerId: 'server-a',
            initialMessageText: 'Original text-only first turn',
            displayText: 'Original text-only first turn',
            messageLocalId: 'new-session-first-turn-1',
            profileId: null,
            metaOverrides: undefined,
        });
        expect(promptStore.getPrompt()).toBe('Newer text typed before acceptance');
        expect(composerDocument.captureSubmissionSnapshot()?.text).toBe('Newer text typed before acceptance');
        await hook.unmount();
    });

    it('admits one detached New Session Composer snapshot before exact document clearing', async () => {
        const { useNewSessionAttachmentsController } = await import('./useNewSessionAttachmentsController');
        const handleCreateSession = vi.fn();
        const composerAttachment = {
            v: 1,
            instanceId: 'issue-42',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42',
            value: { issueId: 42 },
            presentation: {
                label: 'Issue #42',
                typeLabel: 'Issue',
            },
        } satisfies ComposerAttachmentDraftV1;
        const snapshot = createComposerSnapshot({
            text: 'Check @issue',
            attachments: [composerAttachment],
            references: [{
                kind: 'partner.reference',
                ref: 'partner:issue-42',
                token: '@issue',
                start: 6,
                end: 12,
                label: 'Issue #42',
            }],
        });
        const {
            composerDocument,
            captureSubmissionSnapshot,
            clearAcceptedSnapshot,
        } = createComposerDocument({
            attachments: [composerAttachment],
            snapshot,
        });
        const hook = await renderHook(() => useNewSessionAttachmentsController({
            flowId: 'flow-composer-attachment',
            isCreating: false,
            promptStore: createNewSessionPromptStore('Check @issue'),
            handleCreateSession,
            selectedProfileId: 'profile-work',
            targetServerId: 'server-a',
            baseActionChips: [],
            composerDocument,
        }));

        await act(async () => {
            hook.getCurrent().handleSend({
                structuredInputMetaOverrides: {
                    legacyOptionContext: { preserve: true },
                    happierStructuredInputV1: {
                        v: 1,
                        mentions: [{
                            kind: 'partner.reference',
                            ref: 'partner:issue-42',
                            token: '@issue',
                            start: 6,
                            end: 12,
                            label: 'Issue #42',
                        }],
                    },
                },
            });
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(captureSubmissionSnapshot).toHaveBeenCalledWith(undefined);
        expect(handleCreateSession).toHaveBeenCalledWith(expect.objectContaining({
            initialMessage: 'skip',
            afterCreated: expect.any(Function),
            onAfterCreatedSettled: expect.any(Function),
            deferAcceptedDraftClearToDocument: true,
            hasComposerAttachments: true,
        }));

        const createOptions = handleCreateSession.mock.calls[0]?.[0] as HandleCreateSessionOptions | undefined;
        const afterCreated = createOptions?.afterCreated;
        const onAfterCreatedSettled = createOptions?.onAfterCreatedSettled;
        if (!afterCreated || !onAfterCreatedSettled) {
            throw new Error('expected canonical New Session admission callbacks');
        }
        await act(async () => {
            await afterCreated({
                sessionId: 'session-1',
                effectiveSpawnServerId: 'server-a',
                launchAttempt: createLaunchAttempt(),
            });
            expect(clearAcceptedSnapshot).not.toHaveBeenCalled();
            onAfterCreatedSettled({ status: 'accepted', sessionId: 'session-1' });
            await Promise.resolve();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(followUpSpawnedSessionWithServerScopeSpy).toHaveBeenCalledWith({
            sessionId: 'session-1',
            targetServerId: 'server-a',
            initialMessageText: 'Check @issue',
            displayText: 'Check @issue',
            messageLocalId: 'new-session-first-turn-1',
            profileId: 'profile-work',
            metaOverrides: {
                legacyOptionContext: { preserve: true },
                happierStructuredInputV1: {
                    v: 1,
                    mentions: [{
                        kind: 'partner.reference',
                        ref: 'partner:issue-42',
                        token: '@issue',
                        label: 'Issue #42',
                    }],
                    composerAttachments: [composerAttachment],
                },
            },
        });
        expect(clearAcceptedSnapshot).toHaveBeenCalledWith(expect.objectContaining({
            ref: { kind: 'newSession', instanceId: 'new-session-composer-scope' },
            revision: 7,
            text: 'Check @issue',
            attachments: [{
                ...composerAttachment,
                availability: { status: 'ready' },
            }],
        }));
        await hook.unmount();
    });

    it('reuses the incumbent first-turn local id when a generic Composer attachment follow-up retries on the created session', async () => {
        const { useNewSessionAttachmentsController } = await import('./useNewSessionAttachmentsController');
        const handleCreateSession = vi.fn();
        const composerAttachment = {
            v: 1,
            instanceId: 'issue-42',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42',
            value: { issueId: 42 },
            presentation: { label: 'Issue #42', typeLabel: 'Issue' },
        } satisfies ComposerAttachmentDraftV1;
        const { composerDocument, clearAcceptedSnapshot } = createComposerDocument({
            attachments: [composerAttachment],
            snapshot: createComposerSnapshot({ text: '', attachments: [composerAttachment] }),
        });
        followUpSpawnedSessionWithServerScopeSpy
            .mockRejectedValueOnce(new Error('first generic follow-up failed'))
            .mockResolvedValueOnce(undefined);
        const hook = await renderHook(() => useNewSessionAttachmentsController({
            flowId: 'flow-composer-attachment-retry',
            isCreating: false,
            promptStore: createNewSessionPromptStore(''),
            handleCreateSession,
            selectedProfileId: null,
            targetServerId: 'server-a',
            baseActionChips: [],
            composerDocument,
        }));

        await act(async () => {
            hook.getCurrent().handleSend();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });
        const createOptions = handleCreateSession.mock.calls[0]?.[0] as HandleCreateSessionOptions | undefined;
        const afterCreated = createOptions?.afterCreated;
        const onAfterCreatedSettled = createOptions?.onAfterCreatedSettled;
        if (!afterCreated || !onAfterCreatedSettled) {
            throw new Error('expected canonical New Session admission callbacks');
        }
        const launchAttempt = createLaunchAttempt();
        await expect(afterCreated({
            sessionId: 'session-created',
            effectiveSpawnServerId: 'server-a',
            launchAttempt,
        })).rejects.toThrow('first generic follow-up failed');
        await afterCreated({
            sessionId: 'session-created',
            effectiveSpawnServerId: 'server-a',
            launchAttempt,
        });
        await act(async () => {
            onAfterCreatedSettled({ status: 'accepted', sessionId: 'session-created' });
            await Promise.resolve();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(followUpSpawnedSessionWithServerScopeSpy).toHaveBeenCalledTimes(2);
        for (const [input] of followUpSpawnedSessionWithServerScopeSpy.mock.calls) {
            expect(input).toEqual(expect.objectContaining({
                sessionId: 'session-created',
                messageLocalId: launchAttempt.firstTurnLocalId,
            }));
        }
        expect(clearAcceptedSnapshot).toHaveBeenCalledTimes(1);
        await hook.unmount();
    });

    it('retains a Composer attachment after automation rejects it, then clears that exact snapshot for a later ordinary New Session admission', async () => {
        const { useNewSessionAttachmentsController } = await import('./useNewSessionAttachmentsController');
        const handleCreateSession = vi.fn();
        const composerAttachment = {
            v: 1,
            instanceId: 'issue-42',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42',
            value: { issueId: 42 },
            presentation: {
                label: 'Issue #42',
                typeLabel: 'Issue',
            },
        } satisfies ComposerAttachmentDraftV1;
        const snapshot = createComposerSnapshot({ text: 'Check @issue', attachments: [composerAttachment] });
        const {
            composerDocument,
            clearAcceptedSnapshot,
        } = createComposerDocument({
            attachments: [composerAttachment],
            snapshot,
        });
        const hook = await renderHook(() => useNewSessionAttachmentsController({
            flowId: 'flow-composer-attachment-automation-rejected',
            isCreating: false,
            promptStore: createNewSessionPromptStore('Check @issue'),
            handleCreateSession,
            selectedProfileId: null,
            targetServerId: 'server-a',
            baseActionChips: [],
            composerDocument,
        }));

        await act(async () => {
            hook.getCurrent().handleSend();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        const rejectedAutomationOptions = handleCreateSession.mock.calls[0]?.[0] as HandleCreateSessionOptions | undefined;
        expect(rejectedAutomationOptions).toEqual(expect.objectContaining({
            initialMessage: 'skip',
            hasComposerAttachments: true,
            onAfterCreatedSettled: expect.any(Function),
        }));
        rejectedAutomationOptions?.onAfterCreatedSettled?.({ status: 'rejected' });
        await act(async () => {
            await Promise.resolve();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });
        expect(clearAcceptedSnapshot).not.toHaveBeenCalled();

        handleCreateSession.mockClear();
        await act(async () => {
            hook.getCurrent().handleSend();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        const ordinarySessionOptions = handleCreateSession.mock.calls[0]?.[0] as HandleCreateSessionOptions | undefined;
        const afterCreated = ordinarySessionOptions?.afterCreated;
        const onAfterCreatedSettled = ordinarySessionOptions?.onAfterCreatedSettled;
        if (!afterCreated || !onAfterCreatedSettled) {
            throw new Error('expected ordinary New Session admission callbacks');
        }
        await act(async () => {
            await afterCreated({
                sessionId: 'session-ordinary',
                effectiveSpawnServerId: 'server-a',
                launchAttempt: createLaunchAttempt(),
            });
            onAfterCreatedSettled({ status: 'accepted', sessionId: 'session-ordinary' });
            await Promise.resolve();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(clearAcceptedSnapshot).toHaveBeenCalledWith(expect.objectContaining({
            text: 'Check @issue',
            attachments: [{
                ...composerAttachment,
                availability: { status: 'ready' },
            }],
        }));
        await hook.unmount();
    });

    it('retains a contentless Composer snapshot when New Session admission is rejected', async () => {
        const { useNewSessionAttachmentsController } = await import('./useNewSessionAttachmentsController');
        const handleCreateSession = vi.fn();
        const composerAttachment = {
            v: 1,
            instanceId: 'issue-42',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42',
            value: { issueId: 42 },
            presentation: {
                label: 'Issue #42',
                typeLabel: 'Issue',
            },
        } satisfies ComposerAttachmentDraftV1;
        const {
            composerDocument,
            clearAcceptedSnapshot,
        } = createComposerDocument({
            attachments: [composerAttachment],
            snapshot: createComposerSnapshot({ text: '', attachments: [composerAttachment] }),
        });
        followUpSpawnedSessionWithServerScopeSpy.mockRejectedValueOnce(new Error('follow-up failed'));
        const hook = await renderHook(() => useNewSessionAttachmentsController({
            flowId: 'flow-composer-attachment-failure',
            isCreating: false,
            promptStore: createNewSessionPromptStore(''),
            handleCreateSession,
            selectedProfileId: null,
            targetServerId: 'server-a',
            baseActionChips: [],
            composerDocument,
        }));

        await act(async () => {
            hook.getCurrent().handleSend();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        const createOptions = handleCreateSession.mock.calls[0]?.[0] as HandleCreateSessionOptions | undefined;
        const afterCreated = createOptions?.afterCreated;
        const onAfterCreatedSettled = createOptions?.onAfterCreatedSettled;
        if (!afterCreated || !onAfterCreatedSettled) {
            throw new Error('expected canonical New Session admission callbacks');
        }
        await expect(afterCreated({
            sessionId: 'session-1',
            effectiveSpawnServerId: 'server-a',
            launchAttempt: createLaunchAttempt(),
        })).rejects.toThrow('follow-up failed');
        onAfterCreatedSettled({ status: 'rejected' });
        await act(async () => {
            await Promise.resolve();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(followUpSpawnedSessionWithServerScopeSpy).toHaveBeenCalledWith({
            sessionId: 'session-1',
            targetServerId: 'server-a',
            initialMessageText: '',
            displayText: undefined,
            messageLocalId: 'new-session-first-turn-1',
            profileId: null,
            metaOverrides: {
                happierStructuredInputV1: {
                    v: 1,
                    composerAttachments: [composerAttachment],
                },
            },
        });
        expect(clearAcceptedSnapshot).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it.each([
        ['unavailable', { status: 'unavailable' }],
        ['invalid', { status: 'invalid' }],
    ] as const)('refuses a %s Composer attachment before New Session admission while retaining the draft', async (
        _availabilityStatus,
        availability,
    ) => {
        const { useNewSessionAttachmentsController } = await import('./useNewSessionAttachmentsController');
        const handleCreateSession = vi.fn();
        const composerAttachment = {
            v: 1,
            instanceId: 'issue-42',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42',
            value: { issueId: 42 },
            presentation: {
                label: 'Issue #42',
                typeLabel: 'Issue',
            },
        } satisfies ComposerAttachmentDraftV1;
        const snapshot = createComposerSnapshot({
            text: 'Keep this New Session draft',
            attachments: [composerAttachment],
            availability,
        });
        const {
            composerDocument,
            captureSubmissionSnapshot,
            clearAcceptedSnapshot,
        } = createComposerDocument({
            attachments: [composerAttachment],
            snapshot,
        });
        const hook = await renderHook(() => useNewSessionAttachmentsController({
            flowId: `flow-composer-${_availabilityStatus}-blocked`,
            isCreating: false,
            promptStore: createNewSessionPromptStore(''),
            handleCreateSession,
            selectedProfileId: null,
            targetServerId: 'server-a',
            baseActionChips: [],
            composerDocument,
        }));

        await act(async () => {
            hook.getCurrent().handleSend();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(captureSubmissionSnapshot).toHaveBeenCalledWith(undefined);
        expect(handleCreateSession).not.toHaveBeenCalled();
        expect(clearAcceptedSnapshot).not.toHaveBeenCalled();
        expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'common.unavailable');
        expect(captureSubmissionSnapshot.mock.results[0]?.value).toMatchObject({
            text: 'Keep this New Session draft',
            attachments: [expect.objectContaining({ availability })],
        });
        await hook.unmount();
    });

    it('fails closed when a semantic Composer document cannot capture its snapshot', async () => {
        const { useNewSessionAttachmentsController } = await import('./useNewSessionAttachmentsController');
        const handleCreateSession = vi.fn();
        const composerAttachment = {
            v: 1,
            instanceId: 'issue-42',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42',
            value: { issueId: 42 },
            presentation: {
                label: 'Issue #42',
                typeLabel: 'Issue',
            },
        } satisfies ComposerAttachmentDraftV1;
        const { composerDocument, captureSubmissionSnapshot } = createComposerDocument({
            attachments: [composerAttachment],
            snapshot: null,
        });
        const hook = await renderHook(() => useNewSessionAttachmentsController({
            flowId: 'flow-composer-snapshot-unavailable',
            isCreating: false,
            promptStore: createNewSessionPromptStore(''),
            handleCreateSession,
            selectedProfileId: null,
            targetServerId: 'server-a',
            baseActionChips: [],
            composerDocument,
        }));

        await act(async () => {
            hook.getCurrent().handleSend();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(captureSubmissionSnapshot).toHaveBeenCalledWith(undefined);
        expect(handleCreateSession).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('restores attachment drafts when the new-session flow remounts with the same flow id', async () => {
        const { useNewSessionAttachmentsController } = await import('./useNewSessionAttachmentsController');
        const handleCreateSession = vi.fn();

        const first = await renderHook(() => useNewSessionAttachmentsController({
            flowId: 'flow-1',
            isCreating: false,
            promptStore: createNewSessionPromptStore(''),
            handleCreateSession,
            selectedProfileId: null,
            targetServerId: 'server-a',
            baseActionChips: [],
        }));

        const picked: readonly PickedAttachment[] = [{
            kind: 'native',
            uri: 'file:///tmp/note.txt',
            name: 'note.txt',
            sizeBytes: 12,
            mimeType: 'text/plain',
        }];

        await act(async () => {
            first.getCurrent().addPickedAttachments(picked);
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(first.getCurrent().drafts).toHaveLength(1);
        expect(first.getCurrent().agentInputAttachments).toEqual([
            expect.objectContaining({ label: 'note.txt', status: 'pending' }),
        ]);

        await first.unmount();

        const second = await renderHook(() => useNewSessionAttachmentsController({
            flowId: 'flow-1',
            isCreating: false,
            promptStore: createNewSessionPromptStore(''),
            handleCreateSession,
            selectedProfileId: null,
            targetServerId: 'server-a',
            baseActionChips: [],
        }));

        expect(second.getCurrent().drafts).toHaveLength(1);
        expect(second.getCurrent().agentInputAttachments).toEqual([
            expect.objectContaining({ label: 'note.txt', status: 'pending' }),
        ]);
    });

    it('does not clear stored attachment drafts during a transient disabled feature decision', async () => {
        const { useNewSessionAttachmentsController } = await import('./useNewSessionAttachmentsController');
        const handleCreateSession = vi.fn();

        const first = await renderHook(() => useNewSessionAttachmentsController({
            flowId: 'flow-feature-loading',
            isCreating: false,
            promptStore: createNewSessionPromptStore(''),
            handleCreateSession,
            selectedProfileId: null,
            targetServerId: 'server-a',
            baseActionChips: [],
        }));

        await act(async () => {
            first.getCurrent().addPickedAttachments([{
                kind: 'native',
                uri: 'file:///tmp/note.txt',
                name: 'note.txt',
                sizeBytes: 12,
                mimeType: 'text/plain',
            }]);
            await flushHookEffects({ cycles: 1, turns: 1 });
        });
        await first.unmount();

        featureEnabledSpy.mockImplementation((featureId: string) => (
            featureId === 'attachments.uploads' ? false : featureId === 'files.reviewComments'
        ));

        try {
            const disabled = await renderHook(() => useNewSessionAttachmentsController({
                flowId: 'flow-feature-loading',
                isCreating: false,
                promptStore: createNewSessionPromptStore(''),
                handleCreateSession,
                selectedProfileId: null,
                targetServerId: 'server-a',
                baseActionChips: [],
            }));
            await disabled.unmount();

            expect(readNewSessionAttachmentDrafts('flow-feature-loading')).toEqual([
                expect.objectContaining({ status: 'pending' }),
            ]);
        } finally {
            featureEnabledSpy.mockImplementation((featureId: string) => featureId === 'attachments.uploads');
        }
    });

    it('triggers the web file picker exactly once when the attachment chip is pressed', async () => {
        const { useNewSessionAttachmentsController } = await import('./useNewSessionAttachmentsController');
        const originalOs = Platform.OS;
        (Platform as any).OS = 'web';

        try {
            const handleCreateSession = vi.fn();
            const hook = await renderHook(() => useNewSessionAttachmentsController({
                flowId: 'flow-pick-once',
                isCreating: false,
                promptStore: createNewSessionPromptStore(''),
                handleCreateSession,
                selectedProfileId: null,
                targetServerId: 'server-a',
                baseActionChips: [],
            }));

            const openFiles = vi.fn(() => undefined);
            const open = vi.fn(() => undefined);
            const openImages = vi.fn(() => undefined);
            hook.getCurrent().filePickerRef.current = {
                openFiles,
                open,
                openImages,
            } as any;

            const attachmentChip = hook.getCurrent().actionChips.find((chip) => chip.key === 'attachments-add');
            expect(attachmentChip).toBeTruthy();

            const rendered = attachmentChip!.render({
                chipStyle: () => ({}),
                showLabel: true,
                iconColor: '#000',
                textStyle: {},
                countTextStyle: {},
                chipAnchorRef: { current: null },
                popoverAnchorRef: { current: null },
                toggleCollapsedPopover: vi.fn(),
            }) as React.ReactElement<{ onPress?: () => void }>;

            rendered.props.onPress?.();

            expect(openFiles).toHaveBeenCalledTimes(1);
            expect(open).not.toHaveBeenCalled();
        } finally {
            (Platform as any).OS = originalOs;
        }
    });

    it('runs the shared upload and follow-up flow and clears drafts after success', async () => {
        const { useNewSessionAttachmentsController } = await import('./useNewSessionAttachmentsController');
        const handleCreateSession = vi.fn();
        uploadAttachmentDraftsToSessionSpy.mockResolvedValue({
            messageLocalId: 'm1',
            uploaded: [{
                name: 'note.txt',
                path: '.happier/uploads/note.txt',
                mimeType: 'text/plain',
                sizeBytes: 12,
                sha256: 'sha-note',
            }],
        });

        const hook = await renderHook(() => useNewSessionAttachmentsController({
            flowId: 'flow-success',
            isCreating: false,
            promptStore: createNewSessionPromptStore('Investigate this bug'),
            handleCreateSession,
            selectedProfileId: 'profile-work',
            targetServerId: 'server-b',
            baseActionChips: [],
        }));

        await act(async () => {
            hook.getCurrent().addPickedAttachments([{
                kind: 'native',
                uri: 'file:///tmp/note.txt',
                name: 'note.txt',
                sizeBytes: 12,
                mimeType: 'text/plain',
            }]);
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        await act(async () => {
            hook.getCurrent().handleSend();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(handleCreateSession).toHaveBeenCalledWith(expect.objectContaining({
            initialMessage: 'skip',
            afterCreated: expect.any(Function),
        }));

        const afterCreated = handleCreateSession.mock.calls[0]?.[0]?.afterCreated;
        expect(typeof afterCreated).toBe('function');

        await act(async () => {
            await afterCreated({
                sessionId: 'session-1',
                effectiveSpawnServerId: 'server-a',
                launchAttempt: {
                    attachmentMessageLocalId: 'new-session-attachment-local-1',
                },
            });
        });

        expect(uploadAttachmentDraftsToSessionSpy).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            messageLocalId: 'new-session-attachment-local-1',
            drafts: expect.arrayContaining([
                expect.objectContaining({
                    source: expect.objectContaining({ kind: 'native', name: 'note.txt' }),
                }),
            ]),
        }));
        expect(followUpSpawnedSessionWithServerScopeSpy).toHaveBeenCalledWith({
            sessionId: 'session-1',
            targetServerId: 'server-a',
            initialMessageText: 'Investigate this bug\n\n[attachments block]',
            displayText: 'Investigate this bug',
            messageLocalId: 'new-session-attachment-local-1',
            profileId: 'profile-work',
            metaOverrides: {
                happier: {
                    kind: 'attachments.v1',
                    payload: {
                        attachments: [{
                            name: 'note.txt',
                            path: '.happier/uploads/note.txt',
                            mimeType: 'text/plain',
                            sizeBytes: 12,
                            sha256: 'sha-note',
                        }],
                    },
                },
            },
        });

        await hook.unmount();

        const remounted = await renderHook(() => useNewSessionAttachmentsController({
            flowId: 'flow-success',
            isCreating: false,
            promptStore: createNewSessionPromptStore('Investigate this bug'),
            handleCreateSession,
            selectedProfileId: 'profile-work',
            targetServerId: 'server-b',
            baseActionChips: [],
        }));

        expect(remounted.getCurrent().drafts).toHaveLength(0);
    });

    it('automatically includes matching workspace review comments in the new-session follow-up flow and removes only sent workspace drafts after success', async () => {
        const { useNewSessionAttachmentsController } = await import('./useNewSessionAttachmentsController');
        const handleCreateSession = vi.fn();
        featureEnabledSpy.mockImplementation((featureId: string) => featureId === 'files.reviewComments');
        workspaceReviewDraftsState.draftsByRootPath.set('/repo/worktree-a', [{
            id: 'draft-1',
            filePath: 'src/a.ts',
            source: 'diff',
            anchor: {
                kind: 'diffLine',
                startLine: 1,
                side: 'after',
                oldLine: 1,
                newLine: 1,
            },
            snapshot: {
                selectedLines: ['+export const a = 2;'],
                beforeContext: ['-export const a = 1;'],
                afterContext: [],
            },
            body: 'Please verify this project change.',
            createdAt: 1,
        }, {
            id: 'draft-2',
            filePath: 'src/b.ts',
            source: 'diff',
            anchor: {
                kind: 'diffLine',
                startLine: 2,
                side: 'after',
                oldLine: 2,
                newLine: 2,
            },
            snapshot: {
                selectedLines: ['+export const b = 2;'],
                beforeContext: [],
                afterContext: [],
            },
            body: 'Keep this draft but do not send it yet.',
            includeInPrompt: false,
            createdAt: 2,
        }]);

        const hook = await renderHook(() => useNewSessionAttachmentsController({
            flowId: 'flow-review-comments',
            isCreating: false,
            promptStore: createNewSessionPromptStore('Focus on correctness'),
            handleCreateSession,
            selectedProfileId: 'profile-work',
            selectedMachineId: 'machine-1',
            selectedPath: '/repo/worktree-a',
            targetServerId: 'server-b',
            baseActionChips: [],
        }));

        const reviewCommentsChip = hook.getCurrent().actionChips.find((chip) => chip.key === 'review-comments');
        expect(reviewCommentsChip).toBeTruthy();
        const collapsedActionResult = reviewCommentsChip?.collapsedAction?.({
            tint: '#000',
            dismiss: vi.fn(),
            blurInput: vi.fn(),
            openCollapsedPopover: vi.fn(),
        });
        const collapsedAction = Array.isArray(collapsedActionResult)
            ? collapsedActionResult[0]
            : collapsedActionResult;
        expect(collapsedAction?.selected).toBeUndefined();
        expect(reviewDraftHandlerScopeSpy).toHaveBeenCalledWith({
            serverId: 'server-b',
            machineId: 'machine-1',
            rootPath: '/repo/worktree-a',
        });

        await act(async () => {
            hook.getCurrent().handleSend();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(handleCreateSession).toHaveBeenCalledWith(expect.objectContaining({
            initialMessage: 'skip',
            afterCreated: expect.any(Function),
        }));

        const afterCreated = handleCreateSession.mock.calls[0]?.[0]?.afterCreated;
        expect(typeof afterCreated).toBe('function');

        await act(async () => {
            await afterCreated({
                sessionId: 'session-1',
                effectiveSpawnServerId: 'server-b',
                launchAttempt: {
                    attachmentMessageLocalId: 'new-session-attachment-local-1',
                },
            });
        });

        expect(followUpSpawnedSessionWithServerScopeSpy).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            targetServerId: 'server-b',
            displayText: 'Review comments (1)',
            profileId: 'profile-work',
            metaOverrides: {
                happier: {
                    kind: 'review_comments.v1',
                    payload: {
                        sessionId: 'session-1',
                        comments: [
                            expect.objectContaining({
                                id: 'draft-1',
                                filePath: 'src/a.ts',
                                body: 'Please verify this project change.',
                            }),
                        ],
                    },
                },
            },
        }));
        const followUpCall = followUpSpawnedSessionWithServerScopeSpy.mock.calls.at(0);
        expect(followUpCall).toBeDefined();
        const followUpPayload = followUpCall?.[0] as { initialMessageText: string } | undefined;
        expect(resolveReviewCommentDraftAnchorsForPromptSpy).toHaveBeenCalledWith(expect.objectContaining({
            reviewScope: {
                serverId: 'server-b',
                machineId: 'machine-1',
                rootPath: '/repo/worktree-a',
            },
        }));
        expect(followUpPayload?.initialMessageText).toContain('Review comments:');
        expect(followUpPayload?.initialMessageText).toContain('src/a.ts');
        expect(followUpPayload?.initialMessageText).not.toContain('src/b.ts');
        expect(deleteWorkspaceReviewCommentDraftSpy).toHaveBeenCalledWith('draft-1');
        expect(deleteWorkspaceReviewCommentDraftSpy).not.toHaveBeenCalledWith('draft-2');
        expect(clearWorkspaceReviewCommentDraftsSpy).not.toHaveBeenCalled();
    });

    it('discovers workspace review comments when the selected path is home-relative', async () => {
        const { useNewSessionAttachmentsController } = await import('./useNewSessionAttachmentsController');
        const handleCreateSession = vi.fn();
        featureEnabledSpy.mockImplementation((featureId: string) => featureId === 'files.reviewComments');
        workspaceReviewDraftsState.draftsByRootPath.set('/Users/leeroy/Documents/Development/happier-demo-projects/atlas', [{
            id: 'draft-home',
            filePath: 'src/middleware/requestId.test.ts',
            source: 'diff',
            anchor: {
                kind: 'diffLine',
                startLine: 8,
                side: 'after',
                oldLine: 8,
                newLine: 8,
            },
            snapshot: {
                selectedLines: ['+process.env.JWT_SECRET = "test-secret";'],
                beforeContext: [],
                afterContext: [],
            },
            body: 'Please verify this line.',
            createdAt: 1,
        }]);

        const params = {
            flowId: 'flow-review-comments-home-relative',
            isCreating: false,
            promptStore: createNewSessionPromptStore(''),
            handleCreateSession,
            selectedProfileId: 'profile-work',
            selectedMachineId: 'machine-1',
            selectedMachineHomeDir: '/Users/leeroy',
            selectedPath: '~/Documents/Development/happier-demo-projects/atlas',
            targetServerId: 'server-b',
            baseActionChips: [],
        } satisfies Parameters<typeof useNewSessionAttachmentsController>[0] & { selectedMachineHomeDir: string };

        const hook = await renderHook(() => useNewSessionAttachmentsController(params));

        const reviewCommentsChip = hook.getCurrent().actionChips.find((chip) => chip.key === 'review-comments');
        expect(reviewCommentsChip).toBeTruthy();
        expect(reviewDraftHandlerScopeSpy).toHaveBeenCalledWith({
            serverId: 'server-b',
            machineId: 'machine-1',
            rootPath: '/Users/leeroy/Documents/Development/happier-demo-projects/atlas',
        });
    });

    it('keeps attachment metadata when selected review comments are sent with uploads', async () => {
        const { useNewSessionAttachmentsController } = await import('./useNewSessionAttachmentsController');
        const handleCreateSession = vi.fn();
        featureEnabledSpy.mockImplementation((featureId: string) =>
            featureId === 'files.reviewComments' || featureId === 'attachments.uploads'
        );
        uploadAttachmentDraftsToSessionSpy.mockResolvedValue({
            messageLocalId: 'm1',
            uploaded: [{
                name: 'note.txt',
                path: '.happier/uploads/note.txt',
                mimeType: 'text/plain',
                sizeBytes: 12,
                sha256: 'sha-note',
            }],
        });
        workspaceReviewDraftsState.draftsByRootPath.set('/repo/worktree-a', [{
            id: 'draft-1',
            filePath: 'src/a.ts',
            source: 'diff',
            anchor: {
                kind: 'diffLine',
                startLine: 1,
                side: 'after',
                oldLine: 1,
                newLine: 1,
            },
            snapshot: {
                selectedLines: ['+export const a = 2;'],
                beforeContext: ['-export const a = 1;'],
                afterContext: [],
            },
            body: 'Please verify this project change.',
            createdAt: 1,
        }]);

        const hook = await renderHook(() => useNewSessionAttachmentsController({
            flowId: 'flow-review-comments-attachments',
            isCreating: false,
            promptStore: createNewSessionPromptStore('Focus on correctness'),
            handleCreateSession,
            selectedProfileId: 'profile-work',
            selectedMachineId: 'machine-1',
            selectedPath: '/repo/worktree-a',
            targetServerId: 'server-b',
            baseActionChips: [],
        }));

        await act(async () => {
            hook.getCurrent().addPickedAttachments([{
                kind: 'native',
                uri: 'file:///tmp/note.txt',
                name: 'note.txt',
                sizeBytes: 12,
                mimeType: 'text/plain',
            }]);
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        await act(async () => {
            hook.getCurrent().handleSend();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        const afterCreated = handleCreateSession.mock.calls[0]?.[0]?.afterCreated;
        expect(typeof afterCreated).toBe('function');

        await act(async () => {
            await afterCreated({
                sessionId: 'session-1',
                effectiveSpawnServerId: 'server-b',
                launchAttempt: {
                    attachmentMessageLocalId: 'new-session-attachment-local-1',
                },
            });
        });

        expect(followUpSpawnedSessionWithServerScopeSpy).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            targetServerId: 'server-b',
            displayText: expect.stringContaining('[attachments block]'),
            metaOverrides: {
                happier: {
                    kind: 'review_comments.v1',
                    payload: {
                        sessionId: 'session-1',
                        comments: [
                            expect.objectContaining({
                                id: 'draft-1',
                                filePath: 'src/a.ts',
                            }),
                        ],
                    },
                },
                happierAttachments: {
                    kind: 'attachments.v1',
                    payload: {
                        attachments: [{
                            name: 'note.txt',
                            path: '.happier/uploads/note.txt',
                            mimeType: 'text/plain',
                            sizeBytes: 12,
                            sha256: 'sha-note',
                        }],
                    },
                },
            },
        }));
        expect(deleteWorkspaceReviewCommentDraftSpy).toHaveBeenCalledWith('draft-1');
    });

    it('hides the review comments chip when the selected path changes away from the matching workspace', async () => {
        const { useNewSessionAttachmentsController } = await import('./useNewSessionAttachmentsController');
        const handleCreateSession = vi.fn();
        featureEnabledSpy.mockImplementation((featureId: string) => featureId === 'files.reviewComments');
        workspaceReviewDraftsState.draftsByRootPath.set('/repo/worktree-a', [{
            id: 'draft-1',
            filePath: 'src/a.ts',
            source: 'diff',
            anchor: {
                kind: 'diffLine',
                startLine: 1,
                side: 'after',
                oldLine: 1,
                newLine: 1,
            },
            snapshot: {
                selectedLines: ['+export const a = 2;'],
                beforeContext: ['-export const a = 1;'],
                afterContext: [],
            },
            body: 'Please verify this project change.',
            createdAt: 1,
        }]);

        let selectedPath = '/repo/worktree-a';
        const hook = await renderHook(() => useNewSessionAttachmentsController({
            flowId: 'flow-review-comments-unlink',
            isCreating: false,
            promptStore: createNewSessionPromptStore('Focus on correctness'),
            handleCreateSession,
            selectedProfileId: 'profile-work',
            selectedMachineId: 'machine-1',
            selectedPath,
            targetServerId: 'server-b',
            baseActionChips: [],
        }));

        expect(hook.getCurrent().actionChips.some((chip) => chip.key === 'review-comments')).toBe(true);

        selectedPath = '/repo/other';
        await hook.rerender();

        expect(hook.getCurrent().actionChips.some((chip) => chip.key === 'review-comments')).toBe(false);

        await act(async () => {
            hook.getCurrent().handleSend();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(handleCreateSession).toHaveBeenCalledWith(undefined);
        expect(clearWorkspaceReviewCommentDraftsSpy).not.toHaveBeenCalled();
    });

    it('opens the shared review-comments modal and lets users detach or discard matching workspace review comments', async () => {
        const { useNewSessionAttachmentsController } = await import('./useNewSessionAttachmentsController');
        const handleCreateSession = vi.fn();
        featureEnabledSpy.mockImplementation((featureId: string) => featureId === 'files.reviewComments');
        workspaceReviewDraftsState.draftsByRootPath.set('/repo/worktree-a', [{
            id: 'draft-1',
            filePath: 'src/a.ts',
            source: 'diff',
            anchor: {
                kind: 'diffLine',
                startLine: 1,
                side: 'after',
                oldLine: 1,
                newLine: 1,
            },
            snapshot: {
                selectedLines: ['+export const a = 2;'],
                beforeContext: ['-export const a = 1;'],
                afterContext: [],
            },
            body: 'Please verify this project change.',
            createdAt: 1,
        }]);

        const hook = await renderHook(() => useNewSessionAttachmentsController({
            flowId: 'flow-review-comments-discover',
            isCreating: false,
            promptStore: createNewSessionPromptStore('Focus on correctness'),
            handleCreateSession,
            selectedProfileId: 'profile-work',
            selectedMachineId: 'machine-1',
            selectedPath: '/repo/worktree-a',
            targetServerId: 'server-b',
            baseActionChips: [],
        }));

        const reviewCommentsChip = hook.getCurrent().actionChips.find((chip) => chip.key === 'review-comments');
        expect(reviewCommentsChip).toBeTruthy();
        expect('composerAttachmentBadge' in (reviewCommentsChip ?? {})).toBe(false);
        const reviewCommentsBadge = hook.getCurrent().attachmentRowItems.find((item) => item.key === 'review-comments');
        expect(reviewCommentsBadge).toMatchObject({
            kind: 'badge',
            testID: 'agent-input-review-comments-attachment-badge',
        });
        if (!reviewCommentsBadge || !('kind' in reviewCommentsBadge) || reviewCommentsBadge.kind !== 'badge') {
            throw new Error('Expected review comments attachment-row badge');
        }
        expect(reviewCommentsBadge?.testID).toBe('agent-input-review-comments-attachment-badge');

        await act(async () => {
            reviewCommentsBadge?.onPress?.();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(modalShowSpy).toHaveBeenCalledTimes(1);
        const modalConfig = modalShowSpy.mock.calls[0]?.[0] as any;
        expect(modalConfig?.component?.name).toBe('ReviewCommentsDraftsModal');

        await act(async () => {
            reviewCommentsBadge?.onRemove?.();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(modalAlertSpy).toHaveBeenCalledTimes(1);
        const buttons = modalAlertSpy.mock.calls[0]?.[2] as any[];
        const detachButton = buttons.find((button) => button.text === 'files.reviewComments.detachFromPrompt');
        const discardButton = buttons.find((button) => button.style === 'destructive');
        expect(detachButton).toBeTruthy();
        expect(discardButton).toBeTruthy();

        detachButton.onPress();
        expect(upsertWorkspaceReviewCommentDraftSpy).toHaveBeenCalledWith(expect.objectContaining({
            id: 'draft-1',
            includeInPrompt: false,
        }));

        discardButton.onPress();
        expect(clearWorkspaceReviewCommentDraftsSpy).toHaveBeenCalledTimes(1);
    });
});
