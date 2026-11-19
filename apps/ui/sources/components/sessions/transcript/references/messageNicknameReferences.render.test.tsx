import * as React from 'react';
import { expect, it, vi } from 'vitest';
import { act, renderHook } from '@/dev/testkit/hooks/renderHook';
import { createTestSessionTranscriptSource, renderHookWithSessionTranscriptSource } from '@/dev/testkit/sessionTranscriptSource';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionMessagesFixture, createToolCallMessageFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storageStore';
import { buildMessageRouteId } from '@happier-dev/session-core/messages';

import { useMessageStructuredReferences } from './messageStructuredReferences';
import type { InlineSessionReferenceTarget } from './messageNicknameReferences';
import { TranscriptNicknameReferences, TranscriptNicknameSidechainScope, useTranscriptNicknameTargets } from './TranscriptNicknameReferences';
import { useMessageInlineReferences } from './useMessageInlineReferences';

it('scans a committed message once across unrelated renders and a virtualized row remount', async () => {
    const scout: InlineSessionReferenceTarget = {
        kind: 'nativeChild', parentSessionId: 'parent', toolMessageRouteId: 'tool:scout', agentId: 'codex',
    };
    const nicknameTargets = new Map([['Scout', scout]]);
    const readNames = vi.spyOn(nicknameTargets, 'keys');
    const message = { text: 'Ask Scout.', meta: undefined };
    const render = () => renderHook((_: number) => useMessageStructuredReferences({
        message, text: message.text, meta: message.meta, ownSessionId: 'parent', nicknameTargets,
    }), { initialProps: 0 });
    const first = await render();
    expect(first.getCurrent().inline.size).toBe(1);
    await first.rerender(1);
    await first.rerender(2);
    await first.unmount();
    const second = await render();
    expect(second.getCurrent().inline.size).toBe(1);
    expect(readNames).toHaveBeenCalledTimes(1);
    await second.unmount();
});

it.each([false, true])('opens a native sibling on the same Home through its spawn anchor (legacy carrier: %s)', async (legacy) => {
    const serverId = legacy ? getActiveServerSnapshot().serverId : 'home-a';
    const parent = createSessionFixture({
        id: 'parent', serverId: legacy ? undefined : serverId,
        metadata: { ...createSessionFixture().metadata!, flavor: 'codex', codexSessionId: 'root-native' },
    });
    const child = (thread: string, nickname: string) => {
        const row = createToolCallMessageFixture();
        return { ...row, id: thread, tool: { ...row.tool, id: thread, name: 'SubAgent',
            input: { sidechainId: thread, parentThreadId: 'root-native', nickname } } };
    };
    const scout = child('scout-thread', 'Scout');
    const sibling = child('sibling-thread', 'Dove');
    const navigate = vi.fn();
    const source = createTestSessionTranscriptSource({ sessionId: parent.id, serverId, navigate });
    const before = storage.getState();
    let unmount: (() => Promise<void>) | undefined;
    try {
        storage.setState({
            sessions: { [parent.id]: parent },
            sessionLocalStateScope: { serverId, accountId: 'nickname-test-account' },
            sessionMessages: { [parent.id]: createSessionMessagesFixture({ messagesById: { [scout.id]: scout, [sibling.id]: sibling } }) },
        });
        storage.getState().applySettingsLocal({ transcriptLinkAgentNames: true });
        const rendered = await renderHookWithSessionTranscriptSource(() => {
            const targets = useTranscriptNicknameTargets();
            const projection = useMessageStructuredReferences({ text: 'Ask Scout or Dove.', meta: undefined, nicknameTargets: targets });
            const bindings = useMessageInlineReferences({ projection, pictures: [], openPath: () => false });
            return { projection, bindings };
        }, { source, wrapper: ({ children }) => <TranscriptNicknameReferences source={source}>
            <TranscriptNicknameSidechainScope sidechainId={sibling.id}>{children}</TranscriptNicknameSidechainScope>
        </TranscriptNicknameReferences> });
        unmount = rendered.unmount;
        const { projection, bindings } = rendered.getCurrent();
        const references = [...projection.inline.values()];
        expect(references.map(reference => reference.label)).toEqual(['Scout']);
        const [reference] = references;
        expect(bindings.inlineReferences?.resolve(reference!.ref, reference!.token)).toMatchObject({ label: 'Scout', agentId: 'codex' });
        bindings.inlineReferences?.onPress(reference!.ref);
        expect(navigate).toHaveBeenCalledWith(`/session/parent/message/${encodeURIComponent(buildMessageRouteId(scout))}?serverId=${encodeURIComponent(serverId)}`);
        await act(async () => { storage.getState().applySettingsLocal({ transcriptLinkAgentNames: false }); });
        expect(rendered.getCurrent().projection.markdown).toBeUndefined();
        expect(rendered.getCurrent().bindings.inlineReferences).toBeUndefined();
    } finally {
        await unmount?.();
        storage.setState(before);
    }
});
