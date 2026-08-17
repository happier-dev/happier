import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { collectHostText, makeToolCall, renderScreen, standardCleanup } from '@/dev/testkit';
import { createMixedAgentTranscriptFixture } from '@/dev/testkit/fixtures/sessionAgentTransitionFixtures';
import { buildSessionTranscriptAgentAttributionIndex } from '@/components/sessions/transcript/attribution/sessionTranscriptAgentAttribution';
import {
    SessionTranscriptAgentAttributionProvider,
    TranscriptRowSeqProvider,
} from '@/components/sessions/transcript/attribution/SessionTranscriptAgentAttributionContext';
import { installToolShellCommonModuleMocks } from './ToolView.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installToolShellCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

/**
 * The row sequence has to actually arrive. This renders the real component
 * through the real contexts rather than calling the resolver directly, because
 * the way this defect ships is a consumer that never receives the row identity.
 */
describe('ToolInlineBody historical Agent', () => {
    afterEach(() => {
        standardCleanup();
    });

    const CLAUDE_ERA_SEQ = 10;
    const CODEX_ERA_SEQ = 30;

    async function renderDeniedToolBodyAtSeq(seq: number | null) {
        const { ToolInlineBody } = await import('./ToolInlineBody');
        // The Session ran Claude, then switched to Codex, and is in read-only mode now.
        const index = buildSessionTranscriptAgentAttributionIndex(
            createMixedAgentTranscriptFixture({ sourceAgentId: 'claude', targetAgentId: 'codex' }).messages,
        );
        const tool = makeToolCall({
            name: 'Bash',
            state: 'error',
            permission: { id: 'p1', status: 'denied' },
        } as Parameters<typeof makeToolCall>[0]);

        const screen = await renderScreen(
            <SessionTranscriptAgentAttributionProvider value={index}>
                <TranscriptRowSeqProvider value={seq}>
                    <ToolInlineBody
                        mode="card"
                        tool={tool}
                        normalizedToolName="Bash"
                        metadata={{ flavor: 'codex', permissionMode: 'read-only' } as never}
                        messages={[]}
                        detailLevel="summary"
                        setHeaderActions={() => {}}
                    />
                </TranscriptRowSeqProvider>
            </SessionTranscriptAgentAttributionProvider>,
        );
        return collectHostText(screen.tree).join(' ');
    }

    it('does not blame Codex read-only mode for a denial made while Claude was running', async () => {
        expect(await renderDeniedToolBodyAtSeq(CLAUDE_ERA_SEQ)).toContain('errors.permissionDenied');
        expect(await renderDeniedToolBodyAtSeq(CLAUDE_ERA_SEQ)).not.toContain('errors.permissionDeniedReadOnlyMode');
    });

    it('still blames read-only mode for a row Codex really produced', async () => {
        expect(await renderDeniedToolBodyAtSeq(CODEX_ERA_SEQ)).toContain('errors.permissionDeniedReadOnlyMode');
    });

    it('keeps the live answer for a row with no sequence', async () => {
        expect(await renderDeniedToolBodyAtSeq(null)).toContain('errors.permissionDeniedReadOnlyMode');
    });
});
