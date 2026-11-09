import React from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen as renderPanelScreen } from '@/dev/testkit';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';
import { HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE } from '@happier-dev/plugin-ui/environment';

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>((result, entry) => ({ ...result, ...flattenStyle(entry) }), {});
    }
    return typeof style === 'object' ? style as Record<string, unknown> : {};
}

const modalAlertSpy = vi.fn();
const modalShowSpy = vi.fn((_config: unknown) => 'review-comments-modal');
const setDraftIncludedSpy = vi.fn();
const clearDraftsSpy = vi.fn();
const deleteDraftSpy = vi.fn();
const updateDraftSpy = vi.fn();

installAgentInputCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                show: modalShowSpy,
                alert: (...args: unknown[]) => modalAlertSpy(...args),
                confirm: vi.fn(),
                prompt: vi.fn(),
            },
        }).module;
    },
});
vi.mock('expo-image', () => ({
    Image: (props: Record<string, unknown>) => React.createElement('Image', props),
}));
vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
const runtime = installSessionPaneRuntimeTestHarness();
const { storage } = await import('@/sync/domains/state/storageStore');
beforeEach(() => {
    storage.setState({ settings: { ...storage.getState().settings,
        agentInputEnterToSend: true, agentInputActionBarLayout: 'wrap', agentInputChipDensity: 'labels',
        sessionPermissionModeApplyTiming: 'immediate' } });
});
async function renderScreen(element: React.ReactElement) {
    return renderPanelScreen(element, { wrapper: runtime.Wrapper });
}

describe('AgentInput review comment composer badge', () => {
    let AgentInput: typeof import('./AgentInput')['AgentInput'];
    let createReviewCommentsActionChip: typeof import('./definitions/createReviewCommentsActionChip')['createReviewCommentsActionChip'];
    // The composer's module graph loads once, after the module mocks above, in its own hook budget: a cold
    // load must not eat the first case's budget and leave that case rendering on into the next one.
    beforeAll(async () => {
        ({ AgentInput } = await import('./AgentInput'));
        ({ createReviewCommentsActionChip } = await import('./definitions/createReviewCommentsActionChip'));
    });

    it('renders review drafts as an attachment-style badge that opens the review action', async () => {

        const draft = {
            id: 'draft-1',
            filePath: 'src/demo.ts',
            source: 'file',
            anchor: { kind: 'fileLine', startLine: 12 },
            snapshot: { selectedLines: ['const x = 1;'], beforeContext: [], afterContext: [] },
            body: 'Consider extracting this.',
            createdAt: 1,
        } satisfies ReviewCommentDraft;
        const reviewCommentsPresentation = createReviewCommentsActionChip({
            reviewScope: {
                serverId: 'server-1',
                machineId: 'machine-1',
                rootPath: '/repo',
            } satisfies WorkspaceScopeBase,
            reviewCommentDrafts: [draft],
            onSetDraftIncluded: setDraftIncludedSpy,
            onClearDrafts: clearDraftsSpy,
            onDeleteDraft: deleteDraftSpy,
            onUpdateDraft: updateDraftSpy,
        });
        if (!reviewCommentsPresentation) {
            throw new Error('Expected review comments chip');
        }

        const { actionChip: reviewCommentsChip, attachmentRowItem: reviewCommentsRowItem } = reviewCommentsPresentation;

        expect('composerAttachmentBadge' in reviewCommentsChip).toBe(false);
        expect(reviewCommentsRowItem).toMatchObject({
            kind: 'badge',
            testID: 'agent-input-review-comments-attachment-badge',
        });

        modalAlertSpy.mockClear();
        modalShowSpy.mockClear();

        const screen = await renderScreen(
            <AgentInput
                value=""
                placeholder="placeholder"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompleteKinds={[]}
                autocompleteSuggestions={async () => []}
                extraActionChips={[reviewCommentsChip]}
                attachmentRowItems={reviewCommentsRowItem ? [reviewCommentsRowItem] : []}
            />,
        );

        expect(screen.findByTestId('agent-input-review-comments-attachment-badge')).toBeTruthy();

        await screen.pressByTestIdAsync('agent-input-review-comments-attachment-badge-preview');

        expect(modalShowSpy).toHaveBeenCalledTimes(1);
        const modalConfig = modalShowSpy.mock.calls[0]?.[0] as any;
        expect(modalConfig?.component?.name).toBe('ReviewCommentsDraftsModal');
        expect(modalConfig?.props?.reviewScope).toEqual({
            serverId: 'server-1',
            machineId: 'machine-1',
            rootPath: '/repo',
        });
        expect(modalConfig?.chrome?.kind).toBe('card');
    });

    it('names the file and its lines when one selection rides with the message, and counts several', async () => {

        const rangeDraft = {
            id: 'draft-range',
            filePath: 'apps/ui/settings/SettingsModal.tsx',
            source: 'diff',
            anchor: { kind: 'range', filePath: 'apps/ui/settings/SettingsModal.tsx', startLine: 19, endLine: 24, side: 'after' },
            snapshot: { selectedLines: ['export function SettingsModal() {'], beforeContext: [], afterContext: [] },
            body: '',
            createdAt: 1,
        } satisfies ReviewCommentDraft;
        const lineDraft = {
            id: 'draft-line',
            filePath: 'src/retry.ts',
            source: 'file',
            anchor: { kind: 'fileLine', startLine: 8 },
            snapshot: { selectedLines: ['function delayFor() {'], beforeContext: [], afterContext: [] },
            body: '',
            createdAt: 2,
        } satisfies ReviewCommentDraft;
        const render = async (drafts: readonly ReviewCommentDraft[]) => {
            const presentation = createReviewCommentsActionChip({
                reviewCommentDrafts: drafts,
                onSetDraftIncluded: setDraftIncludedSpy,
                onClearDrafts: clearDraftsSpy,
                onDeleteDraft: deleteDraftSpy,
                onUpdateDraft: updateDraftSpy,
            });
            if (!presentation) throw new Error('Expected review comments chip');
            return renderScreen(
                <AgentInput
                    value=""
                    placeholder="placeholder"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                    attachmentRowItems={presentation.attachmentRowItem ? [presentation.attachmentRowItem] : []}
                />,
            );
        };

        const one = await render([rangeDraft]);
        const oneBadge = one.findByTestId('agent-input-review-comments-attachment-badge-preview');
        expect(oneBadge?.props.accessibilityLabel).toBe('SettingsModal.tsx 19–24');
        expect(one.getTextContent()).toContain('SettingsModal.tsx');
        expect(one.getTextContent()).toContain('19–24');
        expect(one.getTextContent()).not.toContain('files.reviewComments.draftsChipLabel');

        const single = await render([lineDraft]);
        expect(single.findByTestId('agent-input-review-comments-attachment-badge-preview')?.props.accessibilityLabel).toBe('retry.ts 8');

        // A detached selection does not ride with the message, so the chip names the one that does.
        const detachedAndOne = await render([{ ...lineDraft, includeInPrompt: false }, rangeDraft]);
        expect(detachedAndOne.findByTestId('agent-input-review-comments-attachment-badge-preview')?.props.accessibilityLabel).toBe('SettingsModal.tsx 19–24');

        const several = await render([rangeDraft, lineDraft]);
        expect(several.findByTestId('agent-input-review-comments-attachment-badge-preview')?.props.accessibilityLabel).toBe('files.reviewComments.draftsChipLabel');
    });

    it('lets the user detach or discard review comments from the composer badge remove button', async () => {

        const draft = {
            id: 'draft-1',
            filePath: 'src/demo.ts',
            source: 'file',
            anchor: { kind: 'fileLine', startLine: 12 },
            snapshot: { selectedLines: ['const x = 1;'], beforeContext: [], afterContext: [] },
            body: 'Consider extracting this.',
            createdAt: 1,
        } satisfies ReviewCommentDraft;
        const reviewCommentsPresentation = createReviewCommentsActionChip({
            reviewCommentDrafts: [draft],
            onSetDraftIncluded: setDraftIncludedSpy,
            onClearDrafts: clearDraftsSpy,
            onDeleteDraft: deleteDraftSpy,
            onUpdateDraft: updateDraftSpy,
        });
        if (!reviewCommentsPresentation) {
            throw new Error('Expected review comments chip');
        }

        const { actionChip: reviewCommentsChip, attachmentRowItem: reviewCommentsRowItem } = reviewCommentsPresentation;

        expect('composerAttachmentBadge' in reviewCommentsChip).toBe(false);

        modalAlertSpy.mockClear();
        setDraftIncludedSpy.mockClear();
        clearDraftsSpy.mockClear();

        const screen = await renderScreen(
            <AgentInput
                value=""
                placeholder="placeholder"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompleteKinds={[]}
                autocompleteSuggestions={async () => []}
                extraActionChips={[reviewCommentsChip]}
                attachmentRowItems={reviewCommentsRowItem ? [reviewCommentsRowItem] : []}
            />,
        );

        const touchFloor = HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE;
        const { layoutHitArea } = await import('@/dev/testkit/harness/hitFrameReach');
        const removeButton = screen.findByTestId('agent-input-review-comments-attachment-badge-remove');
        expect(removeButton?.props.accessibilityRole).toBe('button');
        expect(removeButton?.props.accessibilityLabel).toBe('files.reviewComments.detachOrDiscardTitle');
        expect(removeButton?.props.hitSlop).toBeUndefined();
        // The badge's remove control keeps its drawn square and reaches the pointer floor by hit area.
        const drawn = flattenStyle(removeButton?.props.style);
        const area = await layoutHitArea(() => screen.findByTestId('agent-input-review-comments-attachment-badge-remove'), { width: Number(drawn.width ?? drawn.minWidth), height: Number(drawn.height ?? drawn.minHeight) });
        expect(Math.min(area.width, area.height)).toBeGreaterThanOrEqual(touchFloor);

        await screen.pressByTestIdAsync('agent-input-review-comments-attachment-badge-remove');

        expect(modalAlertSpy).toHaveBeenCalledTimes(1);
        const buttons = modalAlertSpy.mock.calls[0]?.[2] as any[];
        const detachButton = buttons.find((button) => button.text === 'files.reviewComments.detachFromPrompt');
        const discardButton = buttons.find((button) => button.style === 'destructive');

        detachButton.onPress();
        expect(setDraftIncludedSpy).toHaveBeenCalledWith('draft-1', false);

        discardButton.onPress();
        expect(clearDraftsSpy).toHaveBeenCalled();
    });

    it('keeps the review comment badge inert while the composer is disabled', async () => {
        const draft = {
            id: 'draft-1',
            filePath: 'src/demo.ts',
            source: 'file',
            anchor: { kind: 'fileLine', startLine: 12 },
            snapshot: { selectedLines: ['const x = 1;'], beforeContext: [], afterContext: [] },
            body: 'Consider extracting this.',
            createdAt: 1,
        } satisfies ReviewCommentDraft;
        const reviewCommentsPresentation = createReviewCommentsActionChip({
            reviewCommentDrafts: [draft],
            onSetDraftIncluded: setDraftIncludedSpy,
            onClearDrafts: clearDraftsSpy,
            onDeleteDraft: deleteDraftSpy,
            onUpdateDraft: updateDraftSpy,
        });
        if (!reviewCommentsPresentation?.attachmentRowItem) {
            throw new Error('Expected a review comments row item');
        }

        modalAlertSpy.mockClear();
        modalShowSpy.mockClear();

        const screen = await renderScreen(
            <AgentInput
                value="locked prompt"
                placeholder="placeholder"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompleteKinds={[]}
                autocompleteSuggestions={async () => []}
                extraActionChips={[reviewCommentsPresentation.actionChip]}
                attachmentRowItems={[reviewCommentsPresentation.attachmentRowItem]}
                disabled
            />,
        );

        expect(screen.findByTestId('agent-input-review-comments-attachment-badge')).toBeTruthy();
        expect(screen.findByTestId('agent-input-review-comments-attachment-badge-remove')).toBeNull();
        await act(async () => {
            screen.findByTestId('agent-input-review-comments-attachment-badge')?.props.onPress?.();
        });
        expect(modalShowSpy).not.toHaveBeenCalled();
        expect(modalAlertSpy).not.toHaveBeenCalled();
    });
});
