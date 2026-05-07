import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';

import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const modalAlertSpy = vi.fn();
const modalShowSpy = vi.fn((_config: unknown) => 'review-comments-modal');
const setDraftIncludedSpy = vi.fn();
const updateDraftSpy = vi.fn();
const deleteDraftSpy = vi.fn();
const clearDraftsSpy = vi.fn();

installAgentInputCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            TurboModuleRegistry: {
                get: () => ({}),
                getEnforcing: () => ({}),
            },
            Platform: {
                OS: 'web',
                select: (x: any) => x?.web ?? x?.default ?? x?.ios ?? x?.android ?? null,
            },
            useWindowDimensions: () => ({ width: 800, height: 600 }),
            Dimensions: {
                get: () => ({ width: 800, height: 600, scale: 1, fontScale: 1 }),
            },
        });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                show: (config: unknown) => modalShowSpy(config) as any,
                alert: (...args: unknown[]) => modalAlertSpy(...args),
                confirm: vi.fn(),
                prompt: vi.fn(),
            },
        }).module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSetting: (key: string) => {
                if (key === 'profiles') return [];
                if (key === 'agentInputEnterToSend') return true;
                if (key === 'agentInputActionBarLayout') return 'wrap';
                if (key === 'agentInputChipDensity') return 'labels';
                if (key === 'sessionPermissionModeApplyTiming') return 'immediate';
                return null;
            },
            useSessionMessages: () => ({ messages: [], isLoaded: true }),
            useSessionTranscriptIds: () => ({ ids: [], isLoaded: true }),
            useSessionMessagesById: () => ({}),
            useSessionMessagesVersion: () => 0,
            useSessionMessagesReducerState: () => null,
            storage: {
                getState: () => ({
                    setSessionReviewCommentDraftIncluded: setDraftIncludedSpy,
                    upsertSessionReviewCommentDraft: updateDraftSpy,
                    deleteSessionReviewCommentDraft: deleteDraftSpy,
                    clearSessionReviewCommentDrafts: clearDraftsSpy,
                }),
            } as any,
        });
    },
});

vi.mock('expo-image', () => ({
    Image: (props: Record<string, unknown>) => React.createElement('Image', props, null),
}));

vi.mock('@/components/ui/forms/MultiTextInput', () => ({
    MultiTextInput: (props: Record<string, unknown>) => React.createElement('MultiTextInput', props, null),
}));

vi.mock('@/components/ui/theme/haptics', () => ({
    hapticsLight: () => {},
    hapticsError: () => {},
}));

vi.mock('expo-linear-gradient', () => ({
    LinearGradient: 'LinearGradient',
}));

vi.mock('@/components/tools/shell/permissions/PermissionFooter', () => ({
    PermissionFooter: () => null,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/hooks/ui/useKeyboardHeight', () => ({
    useKeyboardHeight: () => 0,
}));

vi.mock('@/components/sessions/sourceControl/status', () => ({
    SourceControlStatusBadge: () => null,
    useHasMeaningfulScmStatus: () => false,
}));

vi.mock('@/sync/domains/state/storageStore', () => ({
    getStorage: () => (selector: any) => selector({ sessionMessages: {} }),
}));

vi.mock('@/sync/store/hooks', () => ({
    useLocalSetting: () => 1,
}));

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['codex', 'claude', 'opencode', 'gemini'],
    DEFAULT_AGENT_ID: 'codex',
    resolveAgentIdFromFlavor: () => null,
    resolveAgentIdFromFlavorNoDefault: () => null,
    getAgentCore: () => ({
        displayNameKey: 'agents.codex',
        toolRendering: { hideUnknownToolsByDefault: false },
        model: { supportsSelection: false, allowedModes: [] },
        permissions: { modeGroup: 'codexLike' },
        sessionModes: { kind: 'legacy' },
    }),
    getAgentBehavior: () => ({
        sessionUsage: {
            supportsExactContextUsageBadge: false,
        },
    }),
}));

describe('AgentInput review comment composer badge', () => {
    it('renders review drafts as an attachment-style badge that opens the review action', async () => {
        const { AgentInput } = await import('./AgentInput');
        const { createReviewCommentsActionChip } = await import('./definitions/createReviewCommentsActionChip');

        const draft = {
            id: 'draft-1',
            filePath: 'src/demo.ts',
            source: 'file',
            anchor: { kind: 'fileLine', startLine: 12 },
            snapshot: { selectedLines: ['const x = 1;'], beforeContext: [], afterContext: [] },
            body: 'Consider extracting this.',
            createdAt: 1,
        } satisfies ReviewCommentDraft;
        const reviewCommentsChip = createReviewCommentsActionChip({
            sessionId: 's1',
            reviewCommentDrafts: [draft],
            onSetDraftIncluded: (draftId, included) => setDraftIncludedSpy('s1', draftId, included),
            onUpdateDraft: (nextDraft) => updateDraftSpy('s1', nextDraft),
            onDeleteDraft: (draftId) => deleteDraftSpy('s1', draftId),
            onClearDrafts: () => clearDraftsSpy('s1'),
        });
        if (!reviewCommentsChip) {
            throw new Error('Expected review comments chip');
        }

        modalAlertSpy.mockClear();
        modalShowSpy.mockClear();
        setDraftIncludedSpy.mockClear();
        clearDraftsSpy.mockClear();

        const screen = await renderScreen(
            <AgentInput
                value=""
                placeholder="placeholder"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompletePrefixes={[]}
                autocompleteSuggestions={async () => []}
                extraActionChips={[reviewCommentsChip]}
            />,
        );

        expect(screen.findByTestId('agent-input-review-comments-attachment-badge')).toBeTruthy();

        await screen.pressByTestIdAsync('agent-input-review-comments-attachment-badge');

        expect(modalShowSpy).toHaveBeenCalledTimes(1);
        const modalConfig = modalShowSpy.mock.calls[0]?.[0] as any;
        expect(modalConfig?.component?.name).toBe('ReviewCommentsDraftsModal');
        expect(modalConfig?.chrome?.kind).toBe('card');
    });

    it('lets the user detach or discard review comments from the composer badge remove button', async () => {
        const { AgentInput } = await import('./AgentInput');
        const { createReviewCommentsActionChip } = await import('./definitions/createReviewCommentsActionChip');

        const draft = {
            id: 'draft-1',
            filePath: 'src/demo.ts',
            source: 'file',
            anchor: { kind: 'fileLine', startLine: 12 },
            snapshot: { selectedLines: ['const x = 1;'], beforeContext: [], afterContext: [] },
            body: 'Consider extracting this.',
            createdAt: 1,
        } satisfies ReviewCommentDraft;
        const reviewCommentsChip = createReviewCommentsActionChip({
            sessionId: 's1',
            reviewCommentDrafts: [draft],
            onSetDraftIncluded: (draftId, included) => setDraftIncludedSpy('s1', draftId, included),
            onUpdateDraft: (nextDraft) => updateDraftSpy('s1', nextDraft),
            onDeleteDraft: (draftId) => deleteDraftSpy('s1', draftId),
            onClearDrafts: () => clearDraftsSpy('s1'),
        });
        if (!reviewCommentsChip) {
            throw new Error('Expected review comments chip');
        }

        modalAlertSpy.mockClear();
        setDraftIncludedSpy.mockClear();
        clearDraftsSpy.mockClear();

        const screen = await renderScreen(
            <AgentInput
                value=""
                placeholder="placeholder"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompletePrefixes={[]}
                autocompleteSuggestions={async () => []}
                extraActionChips={[reviewCommentsChip]}
            />,
        );

        await screen.pressByTestIdAsync('agent-input-review-comments-attachment-badge-remove');

        expect(modalAlertSpy).toHaveBeenCalledTimes(1);
        const buttons = modalAlertSpy.mock.calls[0]?.[2] as any[];
        const detachButton = buttons.find((button) => button.text === 'files.reviewComments.detachFromPrompt');
        const discardButton = buttons.find((button) => button.style === 'destructive');

        detachButton.onPress();
        expect(setDraftIncludedSpy).toHaveBeenCalledWith('s1', 'draft-1', false);

        discardButton.onPress();
        expect(clearDraftsSpy).toHaveBeenCalledWith('s1');
    });
});
