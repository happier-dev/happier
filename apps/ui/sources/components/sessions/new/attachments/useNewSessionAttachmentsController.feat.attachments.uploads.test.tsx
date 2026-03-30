import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import * as React from 'react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { Platform } from 'react-native';

import type { PickedAttachment } from '@/components/sessions/attachments/AttachmentFilePicker.types';
import { installNewSessionScreenModelCommonModuleMocks } from '@/components/sessions/new/hooks/newSessionScreenModelTestHelpers';
import { clearAllNewSessionAttachmentDrafts } from './newSessionAttachmentDraftStore';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const uploadAttachmentDraftsToSessionSpy = vi.hoisted(() => vi.fn());
const formatAttachmentsBlockSpy = vi.hoisted(() => vi.fn(() => '[attachments block]'));
const followUpSpawnedSessionWithServerScopeSpy = vi.hoisted(() => vi.fn(async () => undefined));
const featureEnabledSpy = vi.hoisted(() => vi.fn((featureId: string) => featureId === 'attachments.uploads'));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureEnabledSpy(featureId),
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

installNewSessionScreenModelCommonModuleMocks();

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
});
