/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
const { isThemeSurfaceAddress } = await import('@happier-dev/plugin-ui');
const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
const { getSessionStatus } = await import('@/utils/sessions/sessionUtils');
const { createSessionItemRowViewModel } = await import('@/components/sessions/shell/sessionItemRowViewModelTestFixture');
const { installSessionPaneRuntimeTestHarness } = await import('@/components/sessions/panes/sessionPaneRuntimeTestHarness');
const runtime = installSessionPaneRuntimeTestHarness();
const { AgentInput } = await import('@/components/sessions/agentInput/AgentInput');
const { SessionItem } = await import('@/components/sessions/shell/SessionItem');
const { UserMessageBubble } = await import('@/components/sessions/transcript/UserMessageBubble');
const { Text } = await import('@/components/ui/text/Text');
const { AppShellMaterialFrame } = await import('@/components/navigation/shell/AppShellMaterialFrame');
const { SessionPaneHeader } = await import('@/components/sessions/shell/view/SessionPaneHeader');
const { SegmentedTabBar } = await import('@/components/ui/navigation/SegmentedTabBar');
const { CockpitTabBarView } = await import('@/components/navigation/mobile/chrome/bars/CockpitTabBar');
const { resolveTabBarMetrics } = await import('@/components/ui/navigation/tabBarMetrics');
const { AppShellTitleStrip } = await import('@/components/navigation/shell/appRail/AppShellTitleStrip');
const { AppRailSurface } = await import('@/components/navigation/shell/appRail/AppRail');
const { buildAppRailEntries } = await import('@/components/navigation/shell/appRail/appRailModel');
const { resolveCompactAppDestinations } = await import('@/components/appShell/destinations/compactAppDestinationCatalog');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { InboxSummaryProvider } = await import('@/hooks/inbox/useInboxSummary');
const { View } = await import('react-native');
const { CodeBlockViewFrame } = await import('@/components/ui/code/blocks/CodeBlockViewFrame');
const { ToolTimelineRowHeader } = await import('@/components/tools/shell/views/timeline/ToolTimelineRowHeader');
const { SessionModelPicker } = await import('@/components/sessions/modelPicker/SessionModelPicker');
const { SelectionList } = await import('@/components/ui/selectionList');
const { PROJECT_PICKER_THEME_SURFACE } = await import('@/components/projects/projectPickerThemeSurface');
const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
const { FieldTextInput } = await import('@/components/ui/forms/FieldTextInput');
const { InlineCode } = await import('@/components/ui/text/InlineCode');
const { Switch } = await import('@/components/ui/forms/Switch.web');
const { AnchoredTooltipBubble } = await import('@/components/ui/overlays/AnchoredTooltip');
const { ModalCardFrame } = await import('@/modal/components/card/ModalCardFrame');
const { ModalCardFooterActions } = await import('@/modal/components/card/ModalCardFooterActions');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { MarkdownView } = await import('@/components/markdown/MarkdownView');

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

// Approved D4 author vocabulary: omitting an owner from the registry must fail too.
const promisedParts = {
    sidebar: ['root', 'header', 'row', 'footer'],
    'session-row': ['root', 'title', 'meta', 'status'],
    'chat-header': ['root', 'title', 'facts'],
    'user-bubble': ['root', 'text'],
    'assistant-text': ['root', 'paragraph', 'heading', 'link', 'quote', 'list'],
    'tool-row': ['root', 'icon', 'title', 'detail'],
    'code-block': ['root', 'header', 'body'],
    composer: ['root', 'input', 'toolbar', 'send'],
    button: ['root', 'label', 'icon'],
    menu: ['root', 'row', 'separator'],
    input: ['root', 'text'],
    dialog: ['root', 'header', 'body', 'footer'],
    'tab-bar': ['root', 'tab', 'label', 'icon'],
    'model-picker': ['root', 'provider', 'row', 'effort'],
    'project-picker': ['root', 'row', 'label', 'device'],
    switch: ['root', 'track', 'thumb'],
    tooltip: ['root', 'text'],
    'inline-code': ['root', 'text'],
};

describe('theme surface hooks on the rendered owning primitives', () => {
    beforeEach(async () => {
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
        const session = createSessionFixture({ id: 's1', serverId: runtime.serverId, active: true, activeAt: Date.now(),
            presence: 'online', thinking: true, thinkingAt: Date.now() });
        const rowViewModel = (selected: boolean) => createSessionItemRowViewModel({ session, serverId: runtime.serverId,
            overrides: { selected, sessionStatus: getSessionStatus(session, Date.now()), secondaryLineMode: 'status', activityAt: Date.now() - 60_000 } });
        const railEntries = buildAppRailEntries(resolveCompactAppDestinations({
            builtins: { externalSessions: true, search: true, inbox: true, workflows: true, friends: true, bots: true }, pages: [],
        }));
        const composerProps = {
            sessionId: session.id, value: 'Hello', placeholder: 'Message', onChangeText: () => {}, onSend: () => {},
            connectionStatus: { text: 'Ready', color: 'gray', dotColor: 'gray' },
            autocompleteKinds: [], autocompleteSuggestions: async () => [],
        };
        await act(async () => {
            root!.render(<runtime.Wrapper>
                <AppShellMaterialFrame showChrome dragEnabled={false} leftOffsetPx={384} sidebarWidth={320}
                    titleStrip={<AppShellTitleStrip columnVisible columnToggleAvailable onToggleColumn={() => {}} />}
                    rail={<InjectedAuthProvider credentials={null}><InboxSummaryProvider><AppRailSurface entries={railEntries}
                        activeId={null} onOpen={() => {}} renderFooter={item => <View testID={item.id} />} /></InboxSummaryProvider></InjectedAuthProvider>}
                    column={<div>Sessions</div>} peek={null}><div>Page</div></AppShellMaterialFrame>
                <SessionPaneHeader title="Session" subtitle="app · Development machine" showBackButton={false} />
                <SegmentedTabBar tabs={[
                    { id: 'one', label: 'One', icon: <Text>1</Text> },
                    { id: 'two', label: 'Two', icon: <Text>2</Text> },
                    { id: 'disabled', label: 'Disabled', icon: <Text>3</Text>, disabled: true },
                ]} activeTabId="one" onSelectTab={() => {}} iconPlacement="leading" />
                <CockpitTabBarView bottomInset={0} metrics={resolveTabBarMetrics('regular', true)} activeSurface="chat"
                    barTestId="phone-tabs" tabTestIdPrefix="phone-tab:" tabs={[{ id: 'chat', label: 'Chat', icon: 'terminal' }]} onSurfacePress={() => {}} />
                <CodeBlockViewFrame code="const a = 1" language="ts"><Text>const a = 1</Text></CodeBlockViewFrame>
                <ToolTimelineRowHeader density="comfortable" icon={<Text>i</Text>} title="Read" subtitle="src/file.ts" />
                <SessionModelPicker agentTargetKey="agent:happier.agent.codex/codex" nativeSourceLabel="Codex"
                    nativeModels={[{ value: 'gpt-6.1-terra', label: 'GPT-6.1 Terra' }, { value: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' }]}
                    providerGroups={[]} providerProjectionAuthoritative
                    selected={{ agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'gpt-6.1-terra' }}
                    selectedOptionControls={[{ option: { id: 'reasoning_effort', name: 'Thinking', type: 'select', currentValue: 'medium',
                        options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }] }, effectiveValue: 'medium', isPending: false }]}
                    onSelectOptionControlValue={() => {}} multiColumn onSelect={() => {}} />
                <SelectionList themeSurface={PROJECT_PICKER_THEME_SURFACE} testID="surface-project-choices"
                    listAccessibilityLabel="Projects" rootStep={{ id: 'projects', sections: [{ kind: 'static', id: 'projects',
                        options: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }, { id: 'disabled', label: 'Disabled', disabled: true }] }] }}
                    selectedOptionId="one" onSelect={() => {}} />
                <RoundButton title="Save" onPress={() => {}} leading={<View />} />
                <RoundButton title="Unavailable" disabled onPress={() => {}} leading={<View />} />
                <FieldTextInput value="query" onChangeText={() => {}} accessibilityLabel="Query" />
                <FieldTextInput value="locked" editable={false} onChangeText={() => {}} accessibilityLabel="Locked query" />
                <InlineCode>code</InlineCode>
                <Switch value onValueChange={() => {}} accessibilityLabel="Enabled" />
                <Switch value={false} disabled onValueChange={() => {}} accessibilityLabel="Unavailable switch" />
                <AnchoredTooltipBubble label="Details" />
                <ModalCardFrame title="Dialog" footer={<ModalCardFooterActions><RoundButton title="Done" onPress={() => {}} /></ModalCardFooterActions>}>
                    <Text>Body</Text>
                </ModalCardFrame>
                <DropdownMenu open onOpenChange={() => {}} onSelect={() => {}} separateCategories
                    items={[{ id: 'one', title: 'One', category: 'First' }, { id: 'two', title: 'Two', category: 'Second' }]}
                    trigger={({ toggle }) => <button onClick={toggle}>Menu</button>} />
                <MarkdownView profile="assistant" markdown={'# Heading\n\nParagraph [link](https://example.com)\n\n> Quote\n\n- List'} />
                <div data-fixture="editable"><AgentInput {...composerProps} /></div>
                <div data-fixture="disabled"><AgentInput {...composerProps} disabled /></div>
                <div data-fixture="read-only"><AgentInput {...composerProps} onChangeText={undefined} /></div>
                <SessionItem session={session} serverId={runtime.serverId} variant="default" compact={false} selected={false} rowViewModel={rowViewModel(false)} />
                <SessionItem session={session} serverId={runtime.serverId} variant="default" compact={false} selected rowViewModel={rowViewModel(true)} />
                <div data-fixture="bubble"><UserMessageBubble><MarkdownView profile="user" markdown="Prompt" /></UserMessageBubble></div>
                <div data-fixture="attention"><UserMessageBubble attention={{ sessionAddress: { serverId: runtime.serverId, sessionId: session.id }, routeMessageId: 'message-1', radius: 12 }}><MarkdownView profile="user" markdown="Prompt" /></UserMessageBubble></div>
            </runtime.Wrapper>);
        });
    });

    it('emits real reachable owner parts and semantic states, including alternate painted roots', () => {
        // Open overlays retain their real portal owner outside the root container.
        const addresses = emittedAddresses(document.body);
        expect(addresses).toContain('sidebar/root/default');
        const emitted = new Set(addresses);
        // These approved parts have no exposed ordinary renderer/data owner yet.
        // The complete-vocabulary assertion below deliberately keeps that gap visible.
        const inaccessibleParts = new Set([
            'assistant-text/paragraph', 'assistant-text/heading', 'assistant-text/link',
            'assistant-text/quote', 'assistant-text/list', 'project-picker/device',
        ]);
        const emittedParts = new Set(addresses.map(address => address.split('/').slice(0, 2).join('/')));
        for (const [surface, parts] of Object.entries(promisedParts)) {
            for (const part of parts) {
                const address = `${surface}/${part}`;
                if (!inaccessibleParts.has(address)) expect(emittedParts.has(address), address).toBe(true);
            }
        }
        for (const address of emitted) {
            const [surface, part, state] = address.split('/');
            expect(isThemeSurfaceAddress(surface!, part, state), address).toBe(true);
        }
        // Container roots do not fabricate their children's interaction states.
        for (const part of ['root', 'title', 'meta', 'status']) {
            for (const state of ['default', 'selected']) expect(emitted.has(`session-row/${part}/${state}`)).toBe(true);
        }
        for (const part of ['tab', 'label', 'icon']) {
            for (const state of ['default', 'selected', 'disabled']) expect(emitted.has(`tab-bar/${part}/${state}`)).toBe(true);
        }
        for (const part of ['root', 'input', 'toolbar', 'send']) {
            for (const state of ['default', 'disabled']) expect(emitted.has(`composer/${part}/${state}`), `composer/${part}/${state}`).toBe(true);
        }
        for (const fixture of ['editable', 'read-only']) {
            expect(emittedAddresses(container.querySelector(`[data-fixture="${fixture}"]`)!)).toContain('composer/root/default');
        }
        for (const fixture of ['bubble', 'attention']) {
            expect(emittedAddresses(container.querySelector(`[data-fixture="${fixture}"]`)!)).toEqual(['user-bubble/root/default', 'user-bubble/text/default']);
        }
    });

    it('emits the complete approved D4 vocabulary from the actual owners', () => {
        const promised = Object.entries(promisedParts).flatMap(([surface, parts]) => parts.map(part => `${surface}/${part}`));
        const actual = [...new Set(emittedAddresses(document.body).map(address => address.split('/').slice(0, 2).join('/')))];
        expect(actual.sort()).toEqual(promised.sort());
    });
});
