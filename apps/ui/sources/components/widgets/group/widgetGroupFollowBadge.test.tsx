import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import type { InputFieldHint } from '@happier-dev/protocol/inputs';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { HappierWidgetFrame } from '@happier-dev/plugin-ui/presentation';
import { USAGE_QUERY_INPUT_FIELDS } from '@happier-dev/protocol/inputs';
import type { WidgetInputBindingsV1, WidgetInstanceV1 } from '@happier-dev/protocol/widgets';

import { createSessionFixture, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { setScreenSharingPrivacyActive } from '@/desktop/capture/useNativeRecordingActive';
import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization/keys';
import { storage } from '@/sync/domains/state/storage';
import { useWidgetBindingValueLabels } from '../surface/useWidgetBindingValueLabels';
import { useWidgetGroupInputsEditor } from './useWidgetGroupInputsEditor';
import { WidgetSetupPopover } from '../add/WidgetSetupPopover';
import { useWidgetInstanceBindingLabel } from '../surface/useWidgetInstanceBindingLabel';
import type { WidgetSurfaceContext } from '../surface/widgetSurfaceSetup';
import type { WidgetCandidate } from '../widgetCatalog';
import { useWidgetGroupCardSource } from './widgetGroupFollowedInputs';
import { widgetGroupFollowSource } from './widgetGroupInputs';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/sync/sync', async () => ({ sync: (await import('@/dev/testkit/mocks/sync')).createSessionListHydrationSyncBoundary() }));
afterEach(standardCleanup);

const definition = { kind: 'builtin', id: 'usage_period_summary' } as const;
const candidate: WidgetCandidate = {
    key: 'summary', title: 'Period summary', pluginName: 'Usage', sharedPluginName: false,
    icon: 'squares-four', homeDefault: 'available', target: 'app', definition,
    inputs: {
        fields: USAGE_QUERY_INPUT_FIELDS.filter(field => field.path === 'period' || field.path === 'costBasis'),
    },
};
const follow = (slot: string) => ({ kind: 'context', slot } as const);
const last90 = { kind: 'value', value: { relative: '90days' } } as const;

async function renderCard(bindings: WidgetInputBindingsV1, group: WidgetInputBindingsV1, context: WidgetSurfaceContext = {},
    labels: Readonly<Record<string, string | null>> = {}) {
    const instance: WidgetInstanceV1 = { v: 1, id: 'child', definition, bindings };
    function Card() {
        const pageLabel = useWidgetInstanceBindingLabel(instance, candidate, context);
        const followed = useWidgetGroupCardSource(instance, candidate, context, { kind: 'corePage', pageId: 'usage', area: 'main' }, group, labels);
        return <HappierWidgetFrame frameStyle="plain" placement="home" title="Period summary" testID="card"
            source={followed ? widgetGroupFollowSource(followed.value, true) : pageLabel ?? undefined} />;
    }
    return renderScreen(<Card />);
}

const caption = (value: string) => `widgetFrame.followingGroupValue(value=${value})`;

it('shows the label of a typed Period group pin in the card', async () => {
    const screen = await renderCard({ period: follow('period') }, { period: last90 });
    expect(screen.findByTestId('card.source')?.props.accessibilityLabel).toBe(caption('usage.last90Days'));
});

it('uses the declared Period title when its bound operand has no value yet', async () => {
    const screen = await renderCard({ period: follow('period') }, { period: follow('calendar') });
    expect(screen.findByTestId('card.source')?.props.accessibilityLabel).toBe(caption('Period'));
});

it('shows the first followed field in declaration order when the card has more than one', async () => {
    const screen = await renderCard(
        { costBasis: follow('money'), period: follow('period') },
        { money: { kind: 'value', value: 'auto' }, period: follow('calendar') },
        { slots: { calendar: { label: 'This calendar', value: { value: { relative: '30days' }, label: 'Month to date' } } } },
        { money: 'Unrelated money label' },
    );
    expect(screen.findByTestId('card.source')?.props.accessibilityLabel).toBe(caption('Month to date'));
});

it('never repeats Following group when a second input follows the page', async () => {
    const screen = await renderCard(
        { costBasis: follow('costBasis'), period: follow('period') },
        { period: last90 },
        { slots: { costBasis: { label: 'This page', value: { value: 'auto', label: 'Automatic' } } } },
        { period: undefined },
    );
    expect(screen.findByTestId('card.source')?.props.accessibilityLabel).toBe(caption('usage.last90Days'));
});

it('keeps the page source for a field that follows the page instead of the group', async () => {
    const screen = await renderCard(
        { period: follow('period') },
        { unrelated: last90 },
        { slots: { period: { label: 'This page', value: null } } },
    );
    expect(screen.getTextContent()).toContain('This page');
    expect(screen.findByTestId('card.source')?.props.accessibilityLabel ?? '').not.toContain('widgetFrame.followingGroupValue');
});

it('shows no group badge for a field the child pins', async () => {
    const screen = await renderCard({ period: last90 }, { period: last90 });
    expect(screen.findByTestId('card.source')?.props.accessibilityLabel ?? '').not.toContain('widgetFrame.followingGroupValue');
});

const hiddenCases = [
    { title: 'Session', field: { widget: 'json', inputType: { hostType: 'session' } },
        value: { serverId: 'home', sessionId: 'missing-private-session' } },
    { title: 'Machine', field: { widget: 'json', inputType: { hostType: 'machine' } },
        value: { serverId: 'home', machineId: 'missing-private-machine' } },
    { title: 'Workspace', field: { widget: 'json', inputType: { hostType: 'workspace' } },
        value: { rootPath: '/home/qa/private-location' } },
    { title: 'Directory', field: { widget: 'text' }, value: '/home/qa/private-location' },
    { title: 'Home directory', field: { widget: 'text' }, value: '~/private-location' },
    { title: 'Drive location', field: { widget: 'text' }, value: 'C:\\work\\private-location' },
    { title: 'Network location', field: { widget: 'text' }, value: '\\\\machine\\private-location' },
    { title: 'Project', field: { widget: 'json', optionsSourceId: 'fixture.projects' }, value: ['private-project'] },
    { title: 'Agent', field: { widget: 'json', optionsSourceId: 'fixture.agents' }, value: ['private-agent'] },
    { title: 'Provider', field: { widget: 'json', optionsSourceId: 'fixture.providers' }, value: ['private-provider'] },
    { title: 'Session filter', field: { widget: 'select', inputType: { hostType: 'usageQuery', field: 'session' } },
        value: 'private-session' },
    { title: 'Agent participant', field: { widget: 'json', inputType: { hostType: 'agentParticipant' } },
        value: { id: 'private-participant' } },
    { title: 'Secret reference', field: { widget: 'json', inputType: { hostType: 'savedSecretReference' } },
        value: { id: 'private-secret-reference' } },
] satisfies readonly { title: string; field: Pick<InputFieldHint, 'widget' | 'inputType' | 'optionsSourceId'>; value: JsonValue }[];

it.each(hiddenCases)('does not disclose the withheld $title in either follow surface', async ({ title, field, value }) => {
    const descriptor: WidgetCandidate = {
        ...candidate, inputs: { fields: [
            { ...field, title, path: 'followed' },
            { ...field, title: 'Group operand', path: 'operand' },
        ] },
    };
    const group = { operand: { kind: 'value', value } } as const;
    const instance: WidgetInstanceV1 = { v: 1, id: 'child', definition, bindings: { followed: follow('operand') } };
    function Card() {
        const labels = useWidgetBindingValueLabels(group, descriptor);
        const name = useWidgetGroupCardSource(instance, descriptor, {}, { kind: 'home' }, group, labels);
        return <HappierWidgetFrame frameStyle="plain" placement="home" title="Card" testID="private"
            source={name ? widgetGroupFollowSource(name.value, true) : undefined} />;
    }
    const card = await renderScreen(<Card />);
    const editor = await renderHook(() => useWidgetGroupInputsEditor({
        group: { kind: 'group', id: 'group', width: 'full', frameStyle: 'plain', dividers: 'hairline',
            children: [{ kind: 'widget', instance }], context: group },
        candidates: [descriptor], title: 'Group', scope: { serverId: 'home', accountId: 'actor', owner: { kind: 'home' } },
        context: {}, setInputs: async () => ({ ok: true }), testID: 'group',
    }));
    await act(async () => editor.getCurrent().editInputs!.onPress());
    const popover = editor.getCurrent().popover;
    if (!React.isValidElement<React.ComponentProps<typeof WidgetSetupPopover>>(popover) || popover.type !== WidgetSetupPopover) {
        throw new Error('Missing widget setup popover');
    }
    const setup = popover.props.setup();
    const reading = setup.readInherited?.(setup.initial.bindings).get('followed');
    expect({
        visible: card.getTextContent().includes(caption(title)),
        accessible: card.findByTestId('private.source')?.props.accessibilityLabel,
        editor: reading,
    }).toEqual({ visible: true, accessible: caption(title), editor: { kind: 'single', valueLabel: title } });
});

it('withdraws a previously visible Session name in an already open group editor', async () => {
    const previous = storage.getState();
    const session = createSessionFixture({ id: 'redacted-fixture', serverId: 'home',
        metadata: { name: 'Review invoices', path: '/private', host: 'host' } });
    const field = { widget: 'json', inputType: { hostType: 'session' } } as const;
    const descriptor: WidgetCandidate = { ...candidate, inputs: { fields: [
        { ...field, title: 'Session', path: 'followed' },
        { ...field, title: 'Selected Session', path: 'selected' },
    ] } };
    const saved = { selected: { kind: 'value', value: { serverId: 'home', sessionId: session.id } } } as const;
    const instance: WidgetInstanceV1 = { v: 1, id: 'child', definition, bindings: { followed: follow('selected') } };
    storage.setState({ sessions: { [session.id]: session }, settings: { ...previous.settings,
        sessionListHiddenTagIdsWhileRecording: { home: ['private'] } }, sessionOrganizationTagAssignmentsBySessionKey: {
        [buildSessionOrganizationSessionKey('home', session.id)]: { sessionId: session.id, tagIds: ['private'] },
    } });
    try {
        const editor = await renderHook(() => useWidgetGroupInputsEditor({
            group: { kind: 'group', id: 'group', width: 'full', frameStyle: 'plain', dividers: 'hairline',
                children: [{ kind: 'widget', instance }], context: saved },
            candidates: [descriptor], title: 'Group', scope: { serverId: 'home', accountId: 'actor', owner: { kind: 'home' } },
            context: {}, setInputs: async () => ({ ok: true }), testID: 'group',
        }));
        await act(async () => editor.getCurrent().editInputs!.onPress());
        const read = () => {
            const popover = editor.getCurrent().popover;
            if (!React.isValidElement<React.ComponentProps<typeof WidgetSetupPopover>>(popover) || popover.type !== WidgetSetupPopover) {
                throw new Error('Missing widget setup popover');
            }
            return popover.props.readInherited?.(saved).get('followed');
        };
        expect(read()).toEqual({ kind: 'single', valueLabel: 'Review invoices' });
        await act(async () => setScreenSharingPrivacyActive(true));
        expect(read()).toEqual({ kind: 'single', valueLabel: 'Session' });
        await editor.unmount();
    } finally {
        setScreenSharingPrivacyActive(false);
        storage.setState(previous, true);
    }
});
