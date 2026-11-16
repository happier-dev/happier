/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installAgentInputCommonModuleMocks } from '@/components/sessions/agentInput/agentInputTestHelpers';

// RN hosts and external transport are the boundaries; every emitting owner stays real.
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('@/components/ui/forms/MultiTextInput', async () => import('@/components/ui/forms/MultiTextInput.web'));
installAgentInputCommonModuleMocks({
    reactNative: async () => import('@/platform/shims/reactNativeWebShim'),
    modal: () => vi.importActual('@/modal'),
    text: () => vi.importActual('@/text'),
});
vi.doMock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    const mock = createReanimatedModuleMock();
    const rn = await vi.importActual<typeof import('react-native-web')>('react-native-web');
    const hosts = { View: rn.View, ScrollView: rn.ScrollView, Text: rn.Text };
    return { ...mock, ...hosts, default: { ...mock.default, ...hosts } };
});
const { THEME_SURFACE_REGISTRY } = await import('@happier-dev/plugin-ui');
const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
const { createSessionItemRowViewModel } = await import('@/components/sessions/shell/sessionItemRowViewModelTestFixture');
const { installSessionPaneRuntimeTestHarness } = await import('@/components/sessions/panes/sessionPaneRuntimeTestHarness');
const runtime = installSessionPaneRuntimeTestHarness();
const { AgentInput } = await import('@/components/sessions/agentInput/AgentInput');
const { SessionItem } = await import('@/components/sessions/shell/SessionItem');
const { UserMessageBubble } = await import('@/components/sessions/transcript/UserMessageBubble');
const { Text } = await import('@/components/ui/text/Text');
const { AppShellMaterialFrame } = await import('@/components/navigation/shell/AppShellMaterialFrame');

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(async () => {
    await act(async () => { root?.unmount(); });
    root = null;
    container?.remove();
    container = null;
});

function emittedAddresses(scope: ParentNode) {
    return Array.from(scope.querySelectorAll<HTMLElement>('[data-surface]'), node => {
        expect(node.dataset.part).toBeTruthy();
        expect(node.dataset.state).toBeTruthy();
        return `${node.dataset.surface}/${node.dataset.part}/${node.dataset.state}`;
    });
}

describe('theme surface hooks on the rendered owning primitives', () => {
    it('emits every registered surface, part and semantic state, including alternate painted roots', async () => {
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
        const session = createSessionFixture({ id: 's1', serverId: runtime.serverId });
        const composerProps = {
            sessionId: session.id, value: '', placeholder: 'Message', onChangeText: () => {}, onSend: () => {},
            connectionStatus: { text: 'Ready', color: 'gray', dotColor: 'gray' },
            autocompleteKinds: [], autocompleteSuggestions: async () => [],
        };
        await act(async () => {
            root!.render(<runtime.Wrapper>
                <AppShellMaterialFrame showChrome dragEnabled={false} leftOffsetPx={384} sidebarWidth={320} titleStrip={null} rail={null} column={<div>Sessions</div>} peek={null}><div>Page</div></AppShellMaterialFrame>
                <div data-fixture="editable"><AgentInput {...composerProps} /></div>
                <div data-fixture="disabled"><AgentInput {...composerProps} disabled /></div>
                <div data-fixture="read-only"><AgentInput {...composerProps} readOnly /></div>
                <SessionItem session={session} serverId={runtime.serverId} rowViewModel={createSessionItemRowViewModel({ session, serverId: runtime.serverId })} />
                <SessionItem session={session} serverId={runtime.serverId} rowViewModel={createSessionItemRowViewModel({ session, serverId: runtime.serverId, overrides: { selected: true } })} />
                <div data-fixture="bubble"><UserMessageBubble><Text>Prompt</Text></UserMessageBubble></div>
                <div data-fixture="attention"><UserMessageBubble attention={{ sessionAddress: { serverId: runtime.serverId, sessionId: session.id }, routeMessageId: 'message-1', radius: 12 }}><Text>Prompt</Text></UserMessageBubble></div>
            </runtime.Wrapper>);
        });
        expect(emittedAddresses(container)).toContain('sidebar/root/default');
        const expected = Object.entries(THEME_SURFACE_REGISTRY).flatMap(([surface, entry]) =>
            Object.keys(entry.parts).flatMap(part => entry.states.map(state => `${surface}/${part}/${state}`)));
        expect([...new Set(emittedAddresses(container))].sort()).toEqual(expected.sort());
        for (const fixture of ['editable', 'read-only']) {
            expect(emittedAddresses(container.querySelector(`[data-fixture="${fixture}"]`)!)).toContain('composer/root/default');
        }
        for (const fixture of ['bubble', 'attention']) {
            expect(emittedAddresses(container.querySelector(`[data-fixture="${fixture}"]`)!)).toEqual(['user-bubble/root/default']);
        }
    });
});
