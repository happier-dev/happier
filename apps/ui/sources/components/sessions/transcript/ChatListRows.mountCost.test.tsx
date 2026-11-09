import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@happier-dev/session-core/raw';
import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';

// Platform boundaries only: the source, storage, row and Markdown stay real.
installMessageViewCommonModuleMocks({ storage: (importOriginal) => importOriginal() });
const { initializeRealAppRuntimeForTests } = await import('@/dev/testkit/harness/realAppRuntimeHarness');
await initializeRealAppRuntimeForTests();
const { createSessionFixture, renderScreen, standardCleanup, flushHookEffects } = await import('@/dev/testkit');
const { storage, useSession } = await import('@/sync/domains/state/storage');
const { AppSessionTranscriptSourceProvider } = await import('./source/appSessionTranscriptSource');
const { ChatListMessageRow } = await import('./ChatListRows');
const { TranscriptMessageSelectionBoundary } = await import('./messageSelection/TranscriptMessageSelectionContext');
const { PluginMessageActionHostProvider } = await import('./messageActions/PluginMessageActions');
const { useChatListRootState } = await import('./useChatListRootState');
const { PluginContextualResourceStoreProvider } = await import('@/components/plugins/surfaces/PluginContextualResourceStoreProvider');
const { SessionForkVisualOriginV1Schema } = await import('@happier-dev/protocol/sessions/board/forkVisualCopies');
const { TranscriptVisualContextProvider } = await import('./source/SessionTranscriptSourceContext');

afterEach(() => {
    standardCleanup();
    vi.restoreAllMocks();
    storage.setState(storage.getInitialState(), true);
});

describe('transcript message row mount cost', () => {
    // A Session switch mounts every visible row at once on the thread the user is waiting on, so the
    // per-row component count and per-row work are the cost of the switch.
    it('mounts a committed row without a fork visual-context layer or a per-row fork-origin parse', async () => {
        const session = createSessionFixture({ id: 'row-mount-cost' });
        const committed: NormalizedMessage[] = Array.from({ length: 6 }, (_, index) => {
            const common = { id: `committed-${index}`, seq: index + 1, localId: null, createdAt: index + 1, isSidechain: false };
            return index % 2 === 0 ? { ...common, role: 'user', content: { type: 'text', text: `Prompt ${index}` } }
                : { ...common, role: 'agent', content: [{ type: 'text', text: `Answer ${index}`, uuid: common.id, parentUUID: null }] };
        });
        storage.getState().applySessions([session]);
        storage.getState().applyMessages(session.id, committed);
        storage.getState().applyMessagesLoaded(session.id);
        const ids = storage.getState().sessionMessages[session.id]!.messageIdsOldestFirst;
        const originParses = vi.spyOn(SessionForkVisualOriginV1Schema, 'safeParse');
        const resolveThinkingExpanded = () => false;
        const setThinkingExpanded = () => {};
        function Transcript() {
            const currentSession = useSession(session.id) ?? session;
            const { internalProps: props, boundary, pluginMessageActionHost } = useChatListRootState({ session: currentSession, sessionSurfaceKey: session.id });
            return <PluginMessageActionHostProvider host={pluginMessageActionHost}>
                <TranscriptMessageSelectionBoundary key={boundary.key} sessionId={boundary.sessionId}
                    eligibleMessageIdsInOrder={boundary.eligibleMessageIdsInOrder} enabled={boundary.selectionEnabled}>
                    {ids.map(id => <ChatListMessageRow key={id} messageId={id}
                        sessionId={props.sessionId} metadata={props.metadata} activeThinkingMessageId={props.activeThinkingMessageId}
                        interaction={props.interaction} eventEmphasisByMessageId={props.eventEmphasisByMessageId}
                        rollbackAction={props.rollbackActionsByMessageId[id] ?? null} rollbackRanges={props.rollbackRanges}
                        messagePins={props.messagePins} onToggleMessagePin={props.onToggleMessagePin}
                        forkCommon={props.forkCommon} messageDisplayCommon={props.messageDisplayCommon}
                        toolChromeCommon={props.toolChromeCommon} toolRouteCommon={props.toolRouteCommon}
                        resolveThinkingExpanded={resolveThinkingExpanded} setThinkingExpanded={setThinkingExpanded} />)}
                </TranscriptMessageSelectionBoundary>
            </PluginMessageActionHostProvider>;
        }
        const screen = await renderScreen(<AppSessionTranscriptSourceProvider sessionId={session.id}>
            <PluginContextualResourceStoreProvider><Transcript /></PluginContextualResourceStoreProvider>
        </AppSessionTranscriptSourceProvider>);
        await flushHookEffects({ cycles: 5, turns: 2 });

        const rows = ids.map(id => screen.findHostByTestId(`transcript-message-${id}`));
        expect(rows.every(Boolean)).toBe(true);
        const rowInstances = rows.reduce((sum, row) => sum + (row?.findAll(() => true).length ?? 0), 0);
        console.info('row-mount-cost', JSON.stringify({ rows: rows.length, instancesPerRow: rowInstances / rows.length, originParses: originParses.mock.calls.length }));
        // Without fork visual context the row inherits the transcript's (absent) context: no provider, no parse.
        expect(originParses.mock.calls.length).toBe(0);
        expect(screen.tree.root.findAllByType(TranscriptVisualContextProvider)).toHaveLength(0);
    });
});
