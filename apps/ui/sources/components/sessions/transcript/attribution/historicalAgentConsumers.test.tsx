import { describe, expect, it } from 'vitest';

import { makeToolCall } from '@/dev/testkit';
import { createMixedAgentTranscriptFixture } from '@/dev/testkit/fixtures/sessionAgentTransitionFixtures';
import { installToolShellCommonModuleMocks } from '@/components/tools/shell/views/ToolView.testHelpers';

import {
    buildSessionTranscriptAgentAttributionIndex,
    resolveHistoricalAgentIdAtSeq,
} from './sessionTranscriptAgentAttribution';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installToolShellCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

/**
 * The two pure historical consumers, exercised against the real Agent catalog.
 *
 * A Session that switched Agent keeps every earlier row on screen. Before
 * `AM-17` these two read the Session's *current* Agent, so the history was
 * relabelled the moment the user switched.
 */
describe('historical Agent consumers', () => {
    const CLAUDE_ERA_SEQ = 10;
    const CODEX_ERA_SEQ = 30;

    function indexForSwitch(sourceAgentId: string, targetAgentId: string) {
        return buildSessionTranscriptAgentAttributionIndex(
            createMixedAgentTranscriptFixture({ sourceAgentId, targetAgentId }).messages,
        );
    }

    describe('resolveToolPermissionTerminalErrorMessage', () => {
        const deniedTool = makeToolCall({
            name: 'Bash',
            state: 'error',
            permission: { id: 'p1', status: 'denied' },
        } as Parameters<typeof makeToolCall>[0]);

        it('does not blame the current Agent read-only mode for a denial the previous Agent made', async () => {
            const { resolveToolPermissionTerminalErrorMessage } =
                await import('@/components/tools/shell/permissions/resolveToolPermissionTerminalErrorMessage');
            const index = indexForSwitch('claude', 'codex');
            // The Session is on Codex now, in read-only mode. The denial on
            // screen happened while Claude was running, and Claude has no
            // read-only mode to blame it on.
            const historicalAgentId = resolveHistoricalAgentIdAtSeq(index, CLAUDE_ERA_SEQ);
            expect(historicalAgentId).toBe('claude');

            const message = resolveToolPermissionTerminalErrorMessage({
                tool: deniedTool,
                metadata: { flavor: 'codex', permissionMode: 'read-only' } as never,
                historicalAgentId,
            });

            expect(message).toBe('errors.permissionDenied');
        });

        it('still blames read-only mode for a denial the Codex-era row really made', async () => {
            const { resolveToolPermissionTerminalErrorMessage } =
                await import('@/components/tools/shell/permissions/resolveToolPermissionTerminalErrorMessage');
            const index = indexForSwitch('claude', 'codex');

            const message = resolveToolPermissionTerminalErrorMessage({
                tool: deniedTool,
                metadata: { flavor: 'codex', permissionMode: 'read-only' } as never,
                historicalAgentId: resolveHistoricalAgentIdAtSeq(index, CODEX_ERA_SEQ),
            });

            expect(message).toBe('errors.permissionDeniedReadOnlyMode');
        });

        it('keeps the live-metadata answer when the Session never switched', async () => {
            const { resolveToolPermissionTerminalErrorMessage } =
                await import('@/components/tools/shell/permissions/resolveToolPermissionTerminalErrorMessage');

            const message = resolveToolPermissionTerminalErrorMessage({
                tool: deniedTool,
                metadata: { flavor: 'codex', permissionMode: 'read-only' } as never,
                historicalAgentId: null,
            });

            expect(message).toBe('errors.permissionDeniedReadOnlyMode');
        });
    });

    describe('buildToolHeaderModel', () => {
        const headerInput = {
            tool: makeToolCall({ name: 'SomeToolNobodyKnows' }),
            iconSize: 16,
            iconColorPrimary: '#000',
            iconColorSecondary: '#111',
        };

        it('renders a row from the previous Agent with that Agent unknown-tool policy', async () => {
            const { buildToolHeaderModel } =
                await import('@/components/tools/shell/presentation/buildToolHeaderModel');
            // Gemini hides unknown tools by default; Claude does not. After a
            // gemini -> claude switch the Gemini-era rows must keep Gemini's
            // policy instead of silently un-hiding.
            const index = indexForSwitch('gemini', 'claude');

            const model = buildToolHeaderModel({
                ...headerInput,
                metadata: { flavor: 'claude' } as never,
                historicalAgentId: resolveHistoricalAgentIdAtSeq(index, CLAUDE_ERA_SEQ),
            });

            expect(model.hideUnknownToolsByDefault).toBe(true);
        });

        it('keeps the live-metadata answer when there is no historical evidence', async () => {
            const { buildToolHeaderModel } =
                await import('@/components/tools/shell/presentation/buildToolHeaderModel');

            const model = buildToolHeaderModel({
                ...headerInput,
                metadata: { flavor: 'claude' } as never,
                historicalAgentId: null,
            });

            expect(model.hideUnknownToolsByDefault).toBe(false);
        });
    });
});
