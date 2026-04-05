import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import * as React from 'react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { Platform } from 'react-native';

import type { PickedAttachment } from '@/components/sessions/attachments/AttachmentFilePicker.types';
import { installNewSessionScreenModelCommonModuleMocks } from '@/components/sessions/new/hooks/newSessionScreenModelTestHelpers';
import { clearAllNewSessionAttachmentDrafts } from './newSessionAttachmentDraftStore';
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
        createdAt: number;
    }>>(),
}));
const clearWorkspaceReviewCommentDraftsSpy = vi.hoisted(() => vi.fn());
const reviewDraftHandlerScopeSpy = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureEnabledSpy(featureId),
}));

vi.mock('@/components/workspaces/files/details/workspaceFileDetails/useWorkspaceReviewCommentDraftHandlers', () => ({
    useWorkspaceReviewCommentDraftHandlers: (scope: WorkspaceScopeBase | null) => {
        reviewDraftHandlerScopeSpy(scope);
        return {
            onUpsertReviewCommentDraft: vi.fn(),
            onDeleteReviewCommentDraft: vi.fn(),
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

vi.mock('@/utils/platform/deferOnWeb', () => ({
    blurActiveElementOnWeb: vi.fn(),
    deferOnWeb: (callback: () => void) => callback(),
}));

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
        featureEnabledSpy.mockClear();
        workspaceReviewDraftsState.draftsByRootPath.clear();
        clearWorkspaceReviewCommentDraftsSpy.mockReset();
        reviewDraftHandlerScopeSpy.mockReset();
    });

    it('restores attachment drafts when the new-session flow remounts with the same flow id', async () => {
        const { useNewSessionAttachmentsController } = await import('./useNewSessionAttachmentsController');
        const handleCreateSession = vi.fn();

        const first = await renderHook(() => useNewSessionAttachmentsController({
            flowId: 'flow-1',
            isCreating: false,
            sessionPrompt: '',
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
            sessionPrompt: '',
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

    it('triggers the web file picker exactly once when the attachment chip is pressed', async () => {
        const { useNewSessionAttachmentsController } = await import('./useNewSessionAttachmentsController');
        const originalOs = Platform.OS;
        (Platform as any).OS = 'web';

        try {
            const handleCreateSession = vi.fn();
            const hook = await renderHook(() => useNewSessionAttachmentsController({
                flowId: 'flow-pick-once',
                isCreating: false,
                sessionPrompt: '',
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
            sessionPrompt: 'Investigate this bug',
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
            sessionPrompt: 'Investigate this bug',
            handleCreateSession,
            selectedProfileId: 'profile-work',
            targetServerId: 'server-b',
            baseActionChips: [],
        }));

        expect(remounted.getCurrent().drafts).toHaveLength(0);
    });

    it('automatically includes matching workspace review comments in the new-session follow-up flow and clears workspace drafts after success', async () => {
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
            flowId: 'flow-review-comments',
            isCreating: false,
            sessionPrompt: 'Focus on correctness',
            handleCreateSession,
            selectedProfileId: 'profile-work',
            selectedMachineId: 'machine-1',
            selectedPath: '/repo/worktree-a',
            targetServerId: 'server-b',
            baseActionChips: [],
        }));

        const reviewCommentsChip = hook.getCurrent().extraActionChips.find((chip) => chip.key === 'review-comments');
        expect(reviewCommentsChip).toBeTruthy();
        const collapsedActionResult = reviewCommentsChip?.collapsedAction?.({
            tint: '#000',
            dismiss: vi.fn(),
            blurInput: vi.fn(),
        });
        const collapsedAction = Array.isArray(collapsedActionResult)
            ? collapsedActionResult[0]
            : collapsedActionResult;
        expect(collapsedAction?.selected).toBe(true);
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
        expect(followUpPayload?.initialMessageText).toContain('Review comments:');
        expect(followUpPayload?.initialMessageText).toContain('src/a.ts');
        expect(clearWorkspaceReviewCommentDraftsSpy).toHaveBeenCalledTimes(1);
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
            sessionPrompt: 'Focus on correctness',
            handleCreateSession,
            selectedProfileId: 'profile-work',
            selectedMachineId: 'machine-1',
            selectedPath,
            targetServerId: 'server-b',
            baseActionChips: [],
        }));

        expect(hook.getCurrent().extraActionChips.some((chip) => chip.key === 'review-comments')).toBe(true);

        selectedPath = '/repo/other';
        await hook.rerender();

        expect(hook.getCurrent().extraActionChips.some((chip) => chip.key === 'review-comments')).toBe(false);

        await act(async () => {
            hook.getCurrent().handleSend();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(handleCreateSession).toHaveBeenCalledWith(undefined);
        expect(clearWorkspaceReviewCommentDraftsSpy).not.toHaveBeenCalled();
    });

    it('shows a toggle chip for matching workspace review comments on a generic new-session screen and lets the user disable and re-enable it', async () => {
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
            sessionPrompt: 'Focus on correctness',
            handleCreateSession,
            selectedProfileId: 'profile-work',
            selectedMachineId: 'machine-1',
            selectedPath: '/repo/worktree-a',
            targetServerId: 'server-b',
            baseActionChips: [],
        }));

        const reviewCommentsChip = hook.getCurrent().extraActionChips.find((chip) => chip.key === 'review-comments');
        expect(reviewCommentsChip).toBeTruthy();

        await act(async () => {
            const collapsedActionResult = reviewCommentsChip?.collapsedAction?.({
                tint: '#000',
                dismiss: vi.fn(),
                blurInput: vi.fn(),
            });
            const collapsedAction = Array.isArray(collapsedActionResult)
                ? collapsedActionResult[0]
                : collapsedActionResult;
            collapsedAction?.onPress?.();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        const disabledChip = hook.getCurrent().extraActionChips.find((chip) => chip.key === 'review-comments');
        const disabledActionResult = disabledChip?.collapsedAction?.({
            tint: '#000',
            dismiss: vi.fn(),
            blurInput: vi.fn(),
        });
        const disabledAction = Array.isArray(disabledActionResult)
            ? disabledActionResult[0]
            : disabledActionResult;
        expect(disabledAction?.selected).toBe(false);

        await act(async () => {
            disabledAction?.onPress?.();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        const reenabledChip = hook.getCurrent().extraActionChips.find((chip) => chip.key === 'review-comments');
        const reenabledActionResult = reenabledChip?.collapsedAction?.({
            tint: '#000',
            dismiss: vi.fn(),
            blurInput: vi.fn(),
        });
        const reenabledAction = Array.isArray(reenabledActionResult)
            ? reenabledActionResult[0]
            : reenabledActionResult;
        expect(reenabledAction?.selected).toBe(true);
    });
});
