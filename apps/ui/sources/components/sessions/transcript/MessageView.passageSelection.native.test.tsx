import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentTextMessage, UserTextMessage } from '@happier-dev/session-core/messages';
import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';
// Only OS/platform adapters are replaced. MessageView, source and Markdown composition stay real.
installMessageViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeNativeMock({ platformOS: 'ios' });
    },
    storage: (importOriginal) => importOriginal(),
});
const { initializeRealAppRuntimeForTests } = await import('@/dev/testkit/harness/realAppRuntimeHarness');
await initializeRealAppRuntimeForTests();
const { createSessionFixture, renderScreen, standardCleanup } = await import('@/dev/testkit');
const { storage } = await import('@/sync/domains/state/storage');
const { AppSessionTranscriptSourceProvider } = await import('./source/appSessionTranscriptSource');
const { MessageView } = await import('./MessageView');
const { Modal } = await import('@/modal');
const { activateStorageAccountScope } = await import('@/dev/testkit/runtime/storageRuntime');
const { deriveTranscriptInteractionFromSession } = await import('@/utils/sessions/deriveTranscriptInteraction');
let home: Awaited<ReturnType<typeof activateStorageAccountScope>> | null = null;

afterEach(() => { standardCleanup(); home?.dispose(); home = null; storage.setState(storage.getInitialState(), true); });

describe('MessageView native passage selection', () => {
    it('wires Quote and Annotate only on committed completed user and assistant prose', async () => {
        home = await activateStorageAccountScope({ serverId: 'home', accountId: 'alice' });
        const session = createSessionFixture({ id: 's1', serverId: 'home' });
        storage.getState().applySessions([session]);
        const user: UserTextMessage = { kind: 'user-text', id: 'user-row', localId: null, createdAt: 1,
            text: 'A repeated passage. A repeated passage.',
            messageActionReference: { v: 1, sessionId: session.id, messageId: 'committed-user', observedRevision: 'rev-user' } };
        const assistant: AgentTextMessage = { ...user, kind: 'agent-text', isThinking: false,
            messageActionReference: { v: 1, sessionId: session.id, messageId: 'committed-assistant', observedRevision: 'rev-assistant' } };
        const render = (message: UserTextMessage | AgentTextMessage,
            options: Readonly<{ historical?: boolean; readOnly?: boolean; discarded?: boolean }> = {}) =>
            <AppSessionTranscriptSourceProvider sessionId={session.id} serverId="home"
                readOnly={options.readOnly} interaction={deriveTranscriptInteractionFromSession(session)}>
                <MessageView message={message}
                    metadata={options.discarded ? { ...session.metadata!, discardedCommittedMessageLocalIds: ['discarded'] } : null}
                    sessionId={session.id} historical={options.historical} />
            </AppSessionTranscriptSourceProvider>;
        const screen = await renderScreen(render(user));
        const labels = () => screen.findAllByType('EnrichedMarkdownText')
            .flatMap((node) => (node.props.contextMenuItems ?? []).map((item: { text: string }) => item.text));
        expect(labels()).toEqual(['transcriptPassage.quote', 'transcriptPassage.annotate']);
        // An older native binary supplies exact event text without renderedText. The real Markdown
        // segment and MessageView wiring must carry it all the way to the shared note form.
        await act(async () => screen.findAllByType('EnrichedMarkdownText')[0]!.props.contextMenuItems[1].onPress({
            text: 'repeated passage', selection: { start: 22, end: 38 },
        }));
        expect(vi.mocked(Modal.show)).toHaveBeenCalledWith(expect.objectContaining({
            props: expect.objectContaining({ quote: 'repeated passage' }),
        }));
        await screen.update(render(assistant));
        expect(labels()).toEqual(['transcriptPassage.quote', 'transcriptPassage.annotate']);
        await screen.update(render(assistant, { historical: true }));
        expect(labels()).toEqual([]);
        await screen.update(render({ ...assistant, isThinking: true }));
        expect(labels()).toEqual([]);
        await screen.update(render({ ...user, messageActionReference: undefined }));
        expect(labels()).toEqual([]);
        await screen.update(render(user, { readOnly: true }));
        expect(labels()).toEqual([]);
        await screen.update(render({ ...user, localId: 'discarded' }, { discarded: true }));
        expect(labels()).toEqual([]);
        await screen.update(render({ ...assistant, localId: 'assistant-stream', meta: {
            happierStreamSegmentV1: { v: 1, segmentKind: 'assistant', segmentLocalId: 'assistant-stream',
                segmentState: 'streaming', startedAtMs: 1, updatedAtMs: 2 },
        } }));
        expect(labels()).toEqual([]);
        await screen.update(render({ ...user, text: '' }));
        expect(labels()).toEqual([]);
    });
});
