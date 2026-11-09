import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import { renderWithSessionTranscriptSource as renderScreen, standardCleanup } from '@/dev/testkit';
import { createPartialStorageModuleMock } from '@/dev/testkit/mocks/storage';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import type { ToolCallMessage } from '@happier-dev/session-core/messages';
import { deriveTranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';
import { createTranscriptSessionCommonPropsFixture } from './toolCalls/units/toolCallsGroupUnitsTestFixtures';
import { DelegateOutputMessageCard } from '@/components/sessions/delegations/messages/DelegateOutputMessageCard';
import { PlanOutputMessageCard } from '@/components/sessions/plans/messages/PlanOutputMessageCard';
import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';

let chromeMode: 'cards' | 'activity_feed' = 'cards';
let collapsedDetail: 'title' | 'summary' = 'title';

installMessageViewCommonModuleMocks({
    storage: async (importOriginal) => createPartialStorageModuleMock(importOriginal, {
        useSetting: (key: keyof typeof settingsDefaults) => {
            if (key === 'toolViewTimelineChromeMode') return chromeMode;
            if (key === 'toolViewDetailLevelDefault' || key === 'toolViewDetailLevelDefaultLocalControl') return collapsedDetail;
            if (key === 'toolViewTapAction') return 'expand';
            if (key === 'toolViewTimelineFeedDefaultExpanded') return false;
            return settingsDefaults[key];
        },
    }),
});

const { MessageViewWithSessionCommon } = await import('./MessageView');

afterEach(() => standardCleanup());

describe('tool-result media disclosure', () => {
    it.each(['cards', 'activity_feed'] as const)('mounts media only inside expanded %s tool details', async (mode) => {
        chromeMode = mode;
        const path = '.happier/uploads/artifacts/read-image/comparison.png';
        const message: ToolCallMessage = {
            kind: 'tool-call', id: 'read-image', localId: null, createdAt: 1, children: [],
            tool: { id: 'read-1', name: 'Read', state: 'completed', input: { file_path: 'comparison.png' }, createdAt: 1, startedAt: 1, completedAt: 2, description: null, result: {} },
            meta: { happierMedia: { kind: 'session_media.v1', payload: { media: [{
                id: 'media-1', role: 'output', category: 'tool-artifact', mediaKind: 'image',
                mimeType: 'image/png', name: 'comparison.png', path, sizeBytes: 80,
                origin: { source: 'tool-output', toolCallId: 'read-1' },
            }] } } },
        };
        for (const detail of ['title', 'summary'] as const) {
            collapsedDetail = detail;
            const screen = await renderScreen(<MessageViewWithSessionCommon {...createTranscriptSessionCommonPropsFixture({ toolChromeCommon: { toolViewTimelineChromeMode: mode } })}
                message={message} metadata={null} sessionId="s1" interaction={deriveTranscriptInteraction({ kind: 'public' })} />);
            expect(screen.findByTestId(`message-session-media-inline-image:${path}`) !== null).toBe(false);
            const header = mode === 'cards' ? 'tool-view-header-primary' : 'tool-timeline-row';
            await act(async () => { screen.pressByTestId(header); });
            expect(screen.findByTestId(`message-session-media-inline-image:${path}`)).not.toBeNull();
            await act(async () => { screen.pressByTestId(header); });
            expect(screen.findByTestId(`message-session-media-inline-image:${path}`) !== null).toBe(false);
            await screen.unmount();
        }
    });
});


describe('structured tool-result cards', () => {
    it.each(['cards', 'activity_feed'] as const)('keeps delegation and plan results visible beside the %s tool disclosure', async (mode) => {
        chromeMode = mode;
        collapsedDetail = 'title';
        const runRef = { runId: 'r1', callId: 'c1', backendId: 'b1' };
        const results = [
            { kind: 'delegate_output.v1', payload: { runRef, summary: 'Delegated investigation complete.', deliverables: [], generatedAtMs: 1 }, Card: DelegateOutputMessageCard },
            { kind: 'plan_output.v1', payload: { runRef, summary: 'Plan the disclosure correction.', sections: [], generatedAtMs: 1 }, Card: PlanOutputMessageCard },
        ];
        for (const result of results) {
            const message: ToolCallMessage = {
                kind: 'tool-call', id: 'structured-result', localId: null, createdAt: 1, children: [],
                tool: { id: 'c1', name: 'mcp__happier__execution_run_get', state: 'completed', input: { runId: 'r1' }, createdAt: 1, startedAt: 1, completedAt: 2, description: null, result: {} },
                meta: { happier: result },
            };
            const screen = await renderScreen(<MessageViewWithSessionCommon {...createTranscriptSessionCommonPropsFixture({ toolChromeCommon: { toolViewTimelineChromeMode: mode } })}
                message={message} metadata={null} sessionId="s1" interaction={deriveTranscriptInteraction({ kind: 'public' })} />);
            const header = mode === 'cards' ? 'tool-view-header-primary' : 'tool-timeline-row';
            expect(screen.findAllByType(result.Card)).toHaveLength(1);
            expect(screen.findByTestId(header)).not.toBeNull();
            await act(async () => { screen.pressByTestId(header); });
            expect(screen.findAllByType(result.Card)).toHaveLength(1);
            await act(async () => { screen.pressByTestId(header); });
            expect(screen.findAllByType(result.Card)).toHaveLength(1);
            await screen.unmount();
        }
    });
});
