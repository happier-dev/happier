import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createMixedAgentTranscriptFixture } from '@/dev/testkit/fixtures/sessionAgentTransitionFixtures';
import { buildSessionTranscriptAgentAttributionIndex } from '@/components/sessions/transcript/attribution/sessionTranscriptAgentAttribution';
import {
    SessionTranscriptAgentAttributionProvider,
    TranscriptRowSeqProvider,
} from '@/components/sessions/transcript/attribution/SessionTranscriptAgentAttributionContext';
import { installPermissionShellCommonModuleMocks } from './permissionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

vi.mock('@/sync/ops', () => ({
    sessionAllow: vi.fn(async () => {}),
    sessionAllowWithPermissionUpdates: vi.fn(async () => {}),
    sessionDeny: vi.fn(async () => {}),
    sessionAbort: vi.fn(async () => {}),
}));

vi.mock('@/sync/sync', () => ({ sync: { sendMessage: vi.fn(async () => {}) } }));

installPermissionShellCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            storage: { getState: () => ({ updateSessionPermissionMode: vi.fn() }) },
        });
    },
});

/**
 * `permission-footer.allow-for-session` exists only in the Codex decision
 * protocol branch, so its presence is a clean read of which Agent's protocol
 * the footer chose.
 */
const CODEX_PROTOCOL_TEST_ID = 'permission-footer.allow-for-session';

describe('PermissionFooter historical Agent', () => {
    afterEach(() => {
        standardCleanup();
    });

    const CODEX_ERA_SEQ = 10;
    const CLAUDE_ERA_SEQ = 30;

    async function renderFooterAtSeq(params: Readonly<{
        seq: number | null;
        status: 'pending' | 'denied';
    }>) {
        const { PermissionFooter } = await import('./PermissionFooter');
        // The Session ran Codex, then switched to Claude. Claude is current.
        const index = buildSessionTranscriptAgentAttributionIndex(
            createMixedAgentTranscriptFixture({ sourceAgentId: 'codex', targetAgentId: 'claude' }).messages,
        );

        return renderScreen(
            <SessionTranscriptAgentAttributionProvider value={index}>
                <TranscriptRowSeqProvider value={params.seq}>
                    <PermissionFooter
                        permission={{ id: 'p1', status: params.status }}
                        sessionId="s1"
                        toolName="Bash"
                        toolInput={{ command: 'pwd' }}
                        metadata={{ flavor: 'claude' } as never}
                    />
                </TranscriptRowSeqProvider>
            </SessionTranscriptAgentAttributionProvider>,
        );
    }

    function hasCodexProtocol(screen: Awaited<ReturnType<typeof renderFooterAtSeq>>): boolean {
        return screen.tree.root.findAllByProps({ testID: CODEX_PROTOCOL_TEST_ID }).length > 0;
    }

    it('renders a terminal Codex-era outcome with the Codex protocol after the Session moved to Claude', async () => {
        expect(hasCodexProtocol(await renderFooterAtSeq({ seq: CODEX_ERA_SEQ, status: 'denied' }))).toBe(true);
    });

    it('renders a terminal Claude-era outcome with the Claude protocol', async () => {
        expect(hasCodexProtocol(await renderFooterAtSeq({ seq: CLAUDE_ERA_SEQ, status: 'denied' }))).toBe(false);
    });

    it('keeps a pending request on live authority — history never answers a live prompt', async () => {
        // Same historical row position, but the request is still open. Only the
        // Agent running now can decide it, so the current protocol must win.
        expect(hasCodexProtocol(await renderFooterAtSeq({ seq: CODEX_ERA_SEQ, status: 'pending' }))).toBe(false);
    });
});
