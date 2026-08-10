import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import * as React from 'react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { Platform } from 'react-native';

import type { PickedAttachment } from '@/components/sessions/attachments/AttachmentFilePicker.types';
import { installNewSessionScreenModelCommonModuleMocks } from '@/components/sessions/new/hooks/newSessionScreenModelTestHelpers';
import { clearAllNewSessionAttachmentDrafts, readNewSessionAttachmentDrafts } from './newSessionAttachmentDraftStore';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import type { followUpSpawnedSessionWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/followUpSpawnedSession';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import type { NewSessionLaunchAttempt } from '@/components/sessions/new/modules/newSessionLaunchAttempt';
import { createNewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** The canonical `mentions[]` envelope shape a composer hands to its host (EU-5). */
const STRUCTURED_INPUT_ENVELOPE = {
    v: 1,
    mentions: [{
        kind: 'happier.session',
        ref: 'session:peer',
        token: '@session:peer-abc123',
        start: 4,
        end: 24,
    }],
} as const;

const uploadAttachmentDraftsToSessionSpy = vi.hoisted(() => vi.fn());
const formatAttachmentsBlockSpy = vi.hoisted(() => vi.fn(() => '[attachments block]'));
const followUpSpawnedSessionWithServerScopeSpy = vi.hoisted(() =>
    vi.fn(async (_params: Parameters<typeof followUpSpawnedSessionWithServerScope>[0]) => undefined)
);
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
const readCachedSnapshotForMachinePathSpy = vi.hoisted(() => vi.fn());
const resolveReviewCommentDraftAnchorsForPromptSpy = vi.hoisted(() => vi.fn(async (params: { drafts: unknown[] }) => params.drafts));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureEnabledSpy(featureId),
}));

vi.mock('@/components/sessions/reviews/comments/useWorkspaceReviewCommentDraftHandlers', () => ({
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
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/followUpSpawnedSession', () => ({
    followUpSpawnedSessionWithServerScope: followUpSpawnedSessionWithServerScopeSpy,
}));

vi.mock('@/scm/scmRepositoryService', () => ({
    scmRepositoryService: {
        readCachedSnapshotForMachinePath: (...args: unknown[]) => readCachedSnapshotForMachinePathSpy(...args),
    },
}));

vi.mock('@/components/sessions/reviews/comments/resolveReviewCommentDraftAnchorsForPrompt', () => ({
    resolveReviewCommentDraftAnchorsForPrompt: (params: { drafts: unknown[] }) => resolveReviewCommentDraftAnchorsForPromptSpy(params),
}));

vi.mock('@/utils/platform/deferOnWeb', () => ({
    blurActiveElementOnWeb: vi.fn(),
    deferOnWeb: (callback: () => void) => callback(),
}));

function isReviewCommentDraft(value: unknown): value is ReviewCommentDraft {
    return !!value
        && typeof value === 'object'
        && typeof (value as { id?: unknown }).id === 'string'
        && typeof (value as { filePath?: unknown }).filePath === 'string'
        && !!(value as { anchor?: unknown }).anchor
        && !!(value as { snapshot?: unknown }).snapshot;
}

installNewSessionScreenModelCommonModuleMocks({
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

function createTestLaunchAttempt(
    attachmentMessageLocalId = 'launch-attempt-attachment-message',
): NewSessionLaunchAttempt {
    return {
        attemptId: 'attempt-test',
        spawnNonce: 'spawn-test',
        scopeKey: 'machine:m1|server:server-a|path:/tmp|profiles:off|profile:',
        spawnTargetFingerprint: 'new-session.launch:test',
        createdSessionId: 'session-1',
        firstTurnLocalId: 'first-turn-test',
        attachmentMessageLocalId,
        status: 'created',
        prompt: {
            prompt: '',
            displayText: '',
            meta: null,
        },
        phaseErrors: {},
    };
}

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

describe('useNewSessionAttachmentsController (attachments.uploads)', () => {
    beforeEach(() => {
        clearAllNewSessionAttachmentDrafts();
        uploadAttachmentDraftsToSessionSpy.mockReset();
        formatAttachmentsBlockSpy.mockClear();
        followUpSpawnedSessionWithServerScopeSpy.mockReset();
        featureEnabledSpy.mockReset();
        featureEnabledSpy.mockImplementation((featureId: string) => featureId === 'attachments.uploads');
        workspaceReviewDraftsState.draftsByRootPath.clear();
        clearWorkspaceReviewCommentDraftsSpy.mockClear();
        readCachedSnapshotForMachinePathSpy.mockReset();
        readCachedSnapshotForMachinePathSpy.mockImplementation(({ path }: { path: string }) => ({
            repo: {
                isRepo: true,
                rootPath: path,
            },
        }));
        upsertWorkspaceReviewCommentDraftSpy.mockClear();
        deleteWorkspaceReviewCommentDraftSpy.mockClear();
        reviewDraftHandlerScopeSpy.mockClear();
        resolveReviewCommentDraftAnchorsForPromptSpy.mockReset();
        resolveReviewCommentDraftAnchorsForPromptSpy.mockImplementation(async ({ drafts }: { drafts: unknown[] }) => drafts);
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

    // This controller is the ONLY thing between the composer and the first turn, so it is where
    // the composer's `mentions[]` envelope is dropped or carried. It was dropped once already:
    // an `@session` reference composed on the new-session screen reached the agent as bare text.
    // The downstream test in `useCreateNewSession` cannot see that — it is handed the envelope
    // directly, so it stays green while this hop loses it.
    it('carries the composer structured-input envelope into a plain send', async () => {
        const { useNewSessionAttachmentsController } = await import('./useNewSessionAttachmentsController');
        const handleCreateSession = vi.fn();
        const hook = await renderHook(() => useNewSessionAttachmentsController({
            flowId: 'flow-envelope-plain',
            isCreating: false,
            promptStore: createNewSessionPromptStore('see @session:peer-abc123'),
            handleCreateSession,
            selectedProfileId: null,
            targetServerId: 'server-a',
            baseActionChips: [],
        }));

        await act(async () => {
            hook.getCurrent().handleSend({ structuredInputMetaOverrides: { happierStructuredInputV1: STRUCTURED_INPUT_ENVELOPE } });
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(handleCreateSession).toHaveBeenCalledWith({
            structuredInputMetaOverrides: { happierStructuredInputV1: STRUCTURED_INPUT_ENVELOPE },
        });
        await hook.unmount();
    });

    it('merges the composer structured-input envelope with the attachments envelope', async () => {
        const { useNewSessionAttachmentsController } = await import('./useNewSessionAttachmentsController');
        uploadAttachmentDraftsToSessionSpy.mockResolvedValue({
            uploaded: [{
                name: 'note.txt',
                path: '.happier/uploads/note.txt',
                mimeType: 'text/plain',
                sizeBytes: 12,
                sha256: 'sha-note',
            }],
        });
        const handleCreateSession = vi.fn();
        const hook = await renderHook(() => useNewSessionAttachmentsController({
            flowId: 'flow-envelope-attachments',
            isCreating: false,
            promptStore: createNewSessionPromptStore('see @session:peer-abc123'),
            handleCreateSession,
            selectedProfileId: null,
            targetServerId: 'server-a',
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
            hook.getCurrent().handleSend({ structuredInputMetaOverrides: { happierStructuredInputV1: STRUCTURED_INPUT_ENVELOPE } });
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        const afterCreated = handleCreateSession.mock.calls[0]?.[0]?.afterCreated;
        expect(typeof afterCreated).toBe('function');

        await act(async () => {
            await afterCreated({
                sessionId: 'session-envelope',
                effectiveSpawnServerId: 'server-a',
                launchAttempt: createTestLaunchAttempt('launch-envelope-message-id'),
            });
        });

        // One envelope per message: the attachments payload and the composer's mentions coexist,
        // neither replacing the other.
        expect(followUpSpawnedSessionWithServerScopeSpy).toHaveBeenCalledWith(expect.objectContaining({
            metaOverrides: expect.objectContaining({
                happier: expect.objectContaining({ kind: 'attachments.v1' }),
                happierStructuredInputV1: STRUCTURED_INPUT_ENVELOPE,
            }),
        }));
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

            const attachmentChip = hook.getCurrent().extraActionChips.find((chip) => chip.key === 'attachments-add');
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
                launchAttempt: createTestLaunchAttempt('launch-success-message-id'),
            });
        });

        expect(uploadAttachmentDraftsToSessionSpy).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
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
            messageLocalId: expect.any(String),
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

    it('keeps the upload message local id stable when the follow-up is retried', async () => {
        const { useNewSessionAttachmentsController } = await import('./useNewSessionAttachmentsController');
        const handleCreateSession = vi.fn();
        uploadAttachmentDraftsToSessionSpy.mockImplementation(async (params: { messageLocalId?: string }) => ({
            messageLocalId: params.messageLocalId ?? 'missing-message-local-id',
            uploaded: [{
                name: 'note.txt',
                path: '.happier/uploads/note.txt',
                mimeType: 'text/plain',
                sizeBytes: 12,
                sha256: 'sha-note',
            }],
        }));
        followUpSpawnedSessionWithServerScopeSpy
            .mockRejectedValueOnce(new Error('temporary follow-up failure'))
            .mockResolvedValueOnce(undefined);

        const hook = await renderHook(() => useNewSessionAttachmentsController({
            flowId: 'flow-retry-message-id',
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

        const afterCreated = handleCreateSession.mock.calls[0]?.[0]?.afterCreated;
        expect(typeof afterCreated).toBe('function');

        let retryError: unknown;
        await act(async () => {
            try {
                await afterCreated({
                    sessionId: 'session-1',
                    effectiveSpawnServerId: 'server-b',
                    launchAttempt: createTestLaunchAttempt(),
                });
            } catch (error) {
                retryError = error;
            }
            await flushHookEffects({ cycles: 1, turns: 1 });
        });
        expect(retryError).toBeInstanceOf(Error);

        await act(async () => {
            await afterCreated({
                sessionId: 'session-1',
                effectiveSpawnServerId: 'server-b',
                launchAttempt: createTestLaunchAttempt(),
            });
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        const firstMessageLocalId = uploadAttachmentDraftsToSessionSpy.mock.calls[0]?.[0]?.messageLocalId;
        const secondMessageLocalId = uploadAttachmentDraftsToSessionSpy.mock.calls[1]?.[0]?.messageLocalId;
        expect(firstMessageLocalId).toBe('launch-attempt-attachment-message');
        expect(secondMessageLocalId).toBe(firstMessageLocalId);
        expect(followUpSpawnedSessionWithServerScopeSpy).toHaveBeenLastCalledWith(expect.objectContaining({
            messageLocalId: 'launch-attempt-attachment-message',
        }));
    });

    it('reuses uploaded draft metadata when the follow-up is retried', async () => {
        const { useNewSessionAttachmentsController } = await import('./useNewSessionAttachmentsController');
        const handleCreateSession = vi.fn();
        uploadAttachmentDraftsToSessionSpy.mockImplementation(async (params: {
            drafts: ReadonlyArray<{ id: string; uploadedPath?: string }>;
            applyDraftPatch: (id: string, patch: Record<string, unknown>) => void;
            messageLocalId?: string;
        }) => {
            const firstDraft = params.drafts[0];
            if (firstDraft && !firstDraft.uploadedPath) {
                params.applyDraftPatch(firstDraft.id, {
                    status: 'uploaded',
                    uploadedPath: '.happier/uploads/note.txt',
                    uploadedSizeBytes: 12,
                    uploadedMimeType: 'text/plain',
                    sha256: 'sha-note',
                });
            }
            return {
                messageLocalId: params.messageLocalId ?? 'missing-message-local-id',
                uploaded: [{
                    name: 'note.txt',
                    path: '.happier/uploads/note.txt',
                    mimeType: 'text/plain',
                    sizeBytes: 12,
                    sha256: 'sha-note',
                }],
            };
        });
        followUpSpawnedSessionWithServerScopeSpy.mockRejectedValue(new Error('temporary follow-up failure'));

        const hook = await renderHook(() => useNewSessionAttachmentsController({
            flowId: 'flow-retry-uploaded-draft',
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

        const afterCreated = handleCreateSession.mock.calls[0]?.[0]?.afterCreated;
        expect(typeof afterCreated).toBe('function');

        let firstRetryError: unknown;
        await act(async () => {
            try {
                await afterCreated({
                    sessionId: 'session-1',
                    effectiveSpawnServerId: 'server-b',
                    launchAttempt: createTestLaunchAttempt('launch-reuse-message-id'),
                });
            } catch (error) {
                firstRetryError = error;
            }
            await flushHookEffects({ cycles: 1, turns: 1 });
        });
        expect(firstRetryError).toBeInstanceOf(Error);

        let secondRetryError: unknown;
        await act(async () => {
            try {
                await afterCreated({
                    sessionId: 'session-1',
                    effectiveSpawnServerId: 'server-b',
                    launchAttempt: createTestLaunchAttempt('launch-reuse-message-id'),
                });
            } catch (error) {
                secondRetryError = error;
            }
            await flushHookEffects({ cycles: 1, turns: 1 });
        });
        expect(secondRetryError).toBeInstanceOf(Error);

        const secondDrafts = uploadAttachmentDraftsToSessionSpy.mock.calls[1]?.[0]?.drafts;
        expect(secondDrafts).toEqual([
            expect.objectContaining({
                uploadedPath: '.happier/uploads/note.txt',
                uploadedSizeBytes: 12,
                uploadedMimeType: 'text/plain',
                sha256: 'sha-note',
            }),
        ]);
    });

    it('adds recoverable attachment payload when upload fails', async () => {
        const { useNewSessionAttachmentsController } = await import('./useNewSessionAttachmentsController');
        const handleCreateSession = vi.fn();
        uploadAttachmentDraftsToSessionSpy.mockRejectedValue(new Error('temporary upload failure'));

        const hook = await renderHook(() => useNewSessionAttachmentsController({
            flowId: 'flow-retry-upload-failure',
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

        const afterCreated = handleCreateSession.mock.calls[0]?.[0]?.afterCreated;
        expect(typeof afterCreated).toBe('function');

        let uploadError: unknown;
        await act(async () => {
            try {
                await afterCreated({
                    sessionId: 'session-1',
                    effectiveSpawnServerId: 'server-b',
                    launchAttempt: createTestLaunchAttempt('launch-upload-failure-message-id'),
                });
            } catch (error) {
                uploadError = error;
            }
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(uploadError).toMatchObject({
            recoverableFollowUpPayload: {
                profileId: 'profile-work',
                attachmentDrafts: [
                    expect.objectContaining({
                        source: expect.objectContaining({ kind: 'native', name: 'note.txt' }),
                    }),
                ],
            },
        });
        expect(hook.getCurrent().drafts).toHaveLength(1);
    });

    it('sends selected workspace review comments from a new session and keeps detached drafts', async () => {
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

        const reviewCommentsChip = hook.getCurrent().extraActionChips.find((chip) => chip.key === 'review-comments');
        expect(reviewCommentsChip).toBeTruthy();
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
                launchAttempt: createTestLaunchAttempt('launch-review-message-id'),
            });
        });

        expect(followUpSpawnedSessionWithServerScopeSpy).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            targetServerId: 'server-b',
            displayText: 'Review comments (1)',
            messageLocalId: 'launch-review-message-id',
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
        const followUpPayload = followUpCall?.[0] as { initialMessageText: string } | undefined;
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

        const reviewCommentsChip = hook.getCurrent().extraActionChips.find((chip) => chip.key === 'review-comments');
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
        resolveReviewCommentDraftAnchorsForPromptSpy.mockImplementation(async (params: { drafts: unknown[] }) => params.drafts.map((draft) => {
            if (!isReviewCommentDraft(draft)) return draft;
            return {
            ...draft,
            anchorResolution: {
                id: draft.id,
                filePath: draft.filePath,
                originalAnchor: draft.anchor,
                resolvedAnchor: {
                    kind: 'line',
                    filePath: draft.filePath,
                    line: 3,
                    lineHash: 'lh1:fedcba0987654321' as const,
                },
                status: 'hash',
                confidence: 0.85,
            },
            };
        }));

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
                launchAttempt: createTestLaunchAttempt('launch-review-attachments-message-id'),
            });
        });

        expect(resolveReviewCommentDraftAnchorsForPromptSpy).toHaveBeenCalledWith(expect.objectContaining({
            reviewScope: {
                serverId: 'server-b',
                machineId: 'machine-1',
                rootPath: '/repo/worktree-a',
            },
        }));
        expect(followUpSpawnedSessionWithServerScopeSpy).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            targetServerId: 'server-b',
            initialMessageText: expect.stringContaining('resolved: hash L3'),
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
                                anchorResolution: expect.objectContaining({
                                    status: 'hash',
                                }),
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
});
