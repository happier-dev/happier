import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { Text } from 'react-native';
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
import { WidgetSetupStep } from '../add/WidgetSetupStep';
import { useWidgetInstanceBindingLabel } from '../surface/useWidgetInstanceBindingLabel';
import { widgetGroupSurfaceContext, widgetSetupFieldsForCandidate, type WidgetSurfaceContext } from '../surface/widgetSurfaceSetup';
import type { WidgetCandidate } from '../widgetCatalog';
import { readWidgetGroupInputFollowers, useWidgetGroupCardSource, type WidgetGroupInputReadings } from './widgetGroupFollowedInputs';
import { describeWidgetGroupInputsBinding, useWidgetGroupHeaderReading, widgetGroupFollowSource } from './widgetGroupInputs';

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

function groupReading(instance: WidgetInstanceV1, fields: WidgetGroupInputReadings['fields'], labels: WidgetGroupInputReadings['labels']): WidgetGroupInputReadings {
    return { fields, byChild: new Map([[instance.id, fields]]), labels };
}

async function renderCard(bindings: WidgetInputBindingsV1, group: WidgetInputBindingsV1, context: WidgetSurfaceContext = {},
    labels?: WidgetGroupInputReadings['labels']) {
    const instance: WidgetInstanceV1 = { v: 1, id: 'child', definition, bindings };
    const fields = readWidgetGroupInputFollowers(instance, candidate);
    function Card() {
        const ownedLabels = useWidgetBindingValueLabels(group, null, fields);
        const pageLabel = useWidgetInstanceBindingLabel(instance, candidate, context);
        const followed = useWidgetGroupCardSource(instance, candidate, context, { kind: 'corePage', pageId: 'usage', area: 'main' }, group, groupReading(instance, fields, labels ?? ownedLabels));
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


it('prints only label-owner answers across the five mounted group input surfaces', async () => {
    const marker = 'raw-private-operand';
    const cases: readonly { field: Pick<InputFieldHint, 'widget' | 'inputType' | 'optionsSourceId'>; title: string; value: JsonValue }[] = [
        { title: 'Session', field: { widget: 'json', inputType: { hostType: 'session' } }, value: { serverId: 'home', sessionId: marker } },
        { title: 'Machine', field: { widget: 'json', inputType: { hostType: 'machine' } }, value: { serverId: 'home', machineId: marker } },
        { title: 'Project', field: { widget: 'json', optionsSourceId: 'test.projects' }, value: [marker] },
        { title: 'Agent', field: { widget: 'text', optionsSourceId: 'test.agents' }, value: marker },
        { title: 'Provider', field: { widget: 'text', optionsSourceId: 'test.providers' }, value: marker },
        { title: 'Location', field: { widget: 'text' }, value: '/private/' + marker },
        { title: 'Period', field: { widget: 'json', inputType: { hostType: 'usageQuery', field: 'period' } }, value: { relative: '90days' } },
        { title: 'Retry limit', field: { widget: 'integer' }, value: 27 },
        { title: 'Note', field: { widget: 'json' }, value: { label: 'Safe note', path: '/private/' + marker } },
        { title: 'Text', field: { widget: 'text' }, value: 'Plain note' },
    ];
    const scope = { serverId: 'home', accountId: 'actor', owner: { kind: 'home' } } as const;
    const open = async (descriptor: WidgetCandidate, instance: WidgetInstanceV1, context: WidgetInputBindingsV1,
        page: WidgetSurfaceContext = {}) => {
        const hook = await renderHook(() => useWidgetGroupInputsEditor({
            group: { kind: 'group', id: 'group', width: 'full', frameStyle: 'plain', dividers: 'hairline',
                children: [{ kind: 'widget', instance }], context },
            candidates: [descriptor], title: 'Group', scope, context: page, setInputs: async () => ({ ok: true }), testID: 'group',
        }));
        await act(async () => hook.getCurrent().editInputs!.onPress());
        return hook;
    };
    for (const { field, title, value } of cases) {
        for (const path of ['declared', 'consumer', 'dynamicConsumer']) {
            const slot = path === 'declared' ? path : 'operand';
            const hint: InputFieldHint = { ...field, path, title };
            const descriptor: WidgetCandidate = { ...candidate, inputs: { fields: [hint] } };
            const instance: WidgetInstanceV1 = { v: 1, id: 'child', definition, bindings: { [path]: follow(slot) } };
            const group = { [slot]: { kind: 'value', value } } as const;
            for (const answer of ['Admitted ' + title, null, undefined, 'fresh draft'] as const) {
                const fresh = answer === 'fresh draft';
                const owner = fresh ? undefined : answer;
                const fields = readWidgetGroupInputFollowers(instance, descriptor);
                const readings = groupReading(instance, fields, owner === undefined ? {} : { [slot]: owner });
                const editor = await open(descriptor, instance, {}, fresh ? {} : { slots: {
                    [slot]: { label: 'Page', value: { value, label: owner } },
                } });
                const popover = editor.getCurrent().popover;
                if (!React.isValidElement<React.ComponentProps<typeof WidgetSetupPopover>>(popover)) throw Error('No group editor');
                const setup = popover.props.setup();
                const draft = fresh ? group : {};
                const inherited = setup.readInherited?.(draft).get(path);
                const editorLabel = inherited?.kind === 'single' ? inherited.valueLabel : undefined;
                const freshLabels: Readonly<Record<string, string>> = {
                    Period: 'usage.last90Days', 'Retry limit': '27', Note: 'Safe note', Text: 'Plain note',
                };
                const expectedEditor = fresh ? (path === slot ? undefined : freshLabels[title] ?? title) : owner ?? title;
                expect.soft(editorLabel, title + ' / ' + path + ' / ' + String(answer)).toBe(expectedEditor);
                function Readings() {
                    const header = useWidgetGroupHeaderReading(true, group, readings);
                    const badge = useWidgetGroupCardSource(instance, descriptor, {}, scope.owner, group, readings);
                    const menu = describeWidgetGroupInputsBinding(group, readings);
                    const context = widgetGroupSurfaceContext({}, group, readings);
                    const setupFields = widgetSetupFieldsForCandidate(descriptor, context, 'personal', instance.bindings);
                    const setupLabel = setupFields[0]?.follow?.values[0]?.label;
                    return <>
                        <HappierWidgetFrame frameStyle="plain" placement="home" title="Group" testID="header" source={header?.source} />
                        <Text testID="menu" accessibilityLabel={menu ?? undefined}>{menu}</Text>
                        <Text testID="setup" accessibilityLabel={setupLabel ?? undefined}>{setupLabel}</Text>
                        <HappierWidgetFrame frameStyle="plain" placement="home" title="Card" testID="card"
                            source={badge ? widgetGroupFollowSource(badge.value, true) : undefined} />
                        <Text testID="inherited" accessibilityLabel={editorLabel}>{editorLabel}</Text>
                        {setup.renderPreview?.({ input: {}, draft: { bindings: draft } })}
                    </>;
                }
                const screen = await renderScreen(<Readings />);
                const observation = [screen.getTextContent(), ...['header.source', 'menu', 'setup', 'card.source', 'inherited'].map(id =>
                    screen.findByTestId(id)?.props.accessibilityLabel ?? '')].join(' ');
                expect.soft(observation, title + ' ' + path + ' ' + String(answer)).not.toContain(marker);
                const badge = screen.findByTestId('card.source')?.props.accessibilityLabel;
                // A typed formatter must not replace a missing owner answer, even with a legible value.
                expect.soft(badge, title + ' ' + path).toBe(caption(owner ?? title));
                expect.soft(screen.findByTestId('header.source.text')?.props.children).toBe(owner ?? undefined);
                expect.soft(screen.findByTestId('header.source')?.props.accessibilityLabel).toBe(owner ?? undefined);
                expect.soft(screen.findByTestId('menu')?.props.accessibilityLabel).toBe(owner ? `widgetFrame.groupInputsValue(field=${title},value=${owner})` : undefined);
                expect.soft(screen.findByTestId('setup')?.props.accessibilityLabel).toBe(owner ?? title);
                expect.soft(screen.getTextContent()).toContain('widgetFrame.groupFollowCount(following=1,count=1)');
                await screen.unmount();
                await editor.unmount();
            }
        }
    }

    // The current draft reaches the same owner with the child's declared input type.
    const descriptor: WidgetCandidate = { ...candidate, inputs: { fields: [
        { path: 'followed', title: 'Note', widget: 'json' },
        { path: 'operand', title: 'Group note', widget: 'json' },
    ] } };
    const instance: WidgetInstanceV1 = { v: 1, id: 'child', definition, bindings: { followed: follow('operand'), operand: follow('operand') } };
    const hook = await open(descriptor, instance, {});
    const popover = hook.getCurrent().popover;
    if (!React.isValidElement<React.ComponentProps<typeof WidgetSetupPopover>>(popover)) throw Error('No group editor');
    const draft = { operand: { kind: 'value', value: { label: 'Safe note', path: '/private/' + marker } } } as const;
    expect.soft(popover.props.readInherited?.(draft).get('followed')).toEqual({ kind: 'single', valueLabel: 'Safe note', source: 'group' });
    await hook.unmount();

    const calendar: WidgetCandidate = { ...candidate, inputs: { fields: [{ path: 'calendar', title: 'Calendar', widget: 'text' }] } };
    const page = { slots: {
        a: { label: 'Page', value: { value: 'Today', label: 'A' } },
        b: { label: 'Page', value: { value: 'Today', label: 'B' } },
        c: { label: 'Page', value: { value: 'Yesterday', label: 'C' } },
    } } as const;
    for (const order of ['abc', 'acb', 'bac', 'bca', 'cab', 'cba']) {
        const children = Array.from(order, slot => ({ kind: 'widget' as const, instance: {
            ...instance, id: slot, bindings: { calendar: follow(slot) },
        } }));
        const editor = await renderHook(() => useWidgetGroupInputsEditor({
            group: { kind: 'group', id: 'ordered', width: 'full', frameStyle: 'plain', dividers: 'hairline', children },
            candidates: children.map(() => calendar), title: 'Group', scope, context: page, testID: 'ordered',
            setInputs: async () => ({ ok: true }),
        }));
        await act(async () => editor.getCurrent().editInputs!.onPress());
        const form = editor.getCurrent().popover;
        if (!React.isValidElement<React.ComponentProps<typeof WidgetSetupPopover>>(form)) throw Error('No group editor');
        expect.soft(form.props.readInherited?.({}).get('calendar'), order).toEqual({ kind: 'several', source: 'page' });
        await editor.unmount();
    }

    for (const following of [0, 3]) {
        const period: WidgetCandidate = { ...candidate, inputs: { fields: [{ path: 'period', title: 'Period', widget: 'text' }] } };
        const group = { kind: 'group', id: 'counted', width: 'full', frameStyle: 'plain', dividers: 'hairline',
            children: Array.from({ length: 7 }, (_, index) => ({
                kind: 'widget' as const, instance: { ...instance, id: `card-${index}`,
                    bindings: { period: index < following ? follow('period') : { kind: 'value' as const, value: 'Monday' } } },
            })) } as const;
        const editor = await renderHook(() => useWidgetGroupInputsEditor({
            group, candidates: group.children.map(() => period), title: 'Group', scope, setInputs: async () => ({ ok: true }), testID: 'group',
            context: { slots: { period: { label: 'This page', value: { value: 'Today', label: 'Today' } } } },
        }));
        await act(async () => editor.getCurrent().editInputs!.onPress());
        const form = editor.getCurrent().popover;
        if (!React.isValidElement<React.ComponentProps<typeof WidgetSetupPopover>>(form)) throw Error('No group editor');
        const setup = form.props.setup();
        const screen = await renderScreen(<WidgetSetupStep setup={setup} phone={false} testID="count" onDone={() => {}} />);
        expect.soft(screen.getTextContent()).toContain(`widgetFrame.groupFollowCount(following=${following},count=7)`);
        const periodEditor = screen.findByTestId('count.field.period.input');
        if (following === 0) expect.soft(periodEditor?.props.placeholder).toBeUndefined();
        else {
            // The children follow the group, while the group's own Period follows the page.
            expect.soft(screen.findByTestId('count.field.period.trigger')?.props.accessibilityLabel)
                .toBe('Period, widgetAdd.inheritedValue(value=Today,source=This page)');
            expect.soft(periodEditor).toBeNull();
        }
        await screen.unmount();
        await editor.unmount();
    }
}, 30_000);

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
    const fields = readWidgetGroupInputFollowers(instance, descriptor);
    function Card() {
        const labels = useWidgetBindingValueLabels(group, null, fields);
        const name = useWidgetGroupCardSource(instance, descriptor, {}, { kind: 'home' }, group, groupReading(instance, fields, labels));
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
    }).toEqual({ visible: true, accessible: caption(title), editor: { kind: 'single', valueLabel: title, source: 'group' } });
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
        expect(read()).toEqual({ kind: 'single', valueLabel: 'Review invoices', source: 'group' });
        await act(async () => setScreenSharingPrivacyActive(true));
        expect(read()).toEqual({ kind: 'single', valueLabel: 'Session', source: 'group' });
        await editor.unmount();
    } finally {
        setScreenSharingPrivacyActive(false);
        storage.setState(previous, true);
    }
});

it('uses the slot name in the badge and editor when consuming titles disagree', async () => {
    const group = { operand: { kind: 'value', value: '/private/unnamed-operand' } } as const;
    const declarations = ['Directory', 'Target', 'Directory'].map(title => ({
        slot: 'operand', sessionTarget: false, field: { path: 'targetPath', title, widget: 'text' as const },
    }));
    const instance: WidgetInstanceV1 = { v: 1, id: 'child', definition, bindings: { targetPath: follow('operand') } };
    const descriptor: WidgetCandidate = { ...candidate, inputs: { fields: [declarations[0]!.field] } };
    for (const order of ['012', '021', '102', '120', '201', '210']) {
        const fields = Array.from(order, digit => declarations[Number(digit)]!);
        const readings = groupReading(instance, fields, { operand: null });
        const output = await renderHook(() => ({
            header: useWidgetGroupHeaderReading(true, group, readings)?.source?.text,
            menu: describeWidgetGroupInputsBinding(group, readings),
            badge: useWidgetGroupCardSource(instance, descriptor, {}, { kind: 'home' }, group, readings)?.value,
            editor: useWidgetGroupInputsEditor({
                group: { kind: 'group', id: 'order', width: 'full', frameStyle: 'plain', dividers: 'hairline', context: group,
                    children: fields.map((_, index) => ({ kind: 'widget', instance: { ...instance, id: `child-${index}` } })) },
                candidates: fields.map(({ field }) => ({ ...candidate, inputs: { fields: [field] } })),
                title: 'Group', scope: { serverId: 'home', accountId: 'actor', owner: { kind: 'home' } }, context: {},
                setInputs: async () => ({ ok: true }), testID: 'order',
            }),
        }));
        const { editor, ...captions } = output.getCurrent();
        expect.soft(captions, order).toEqual({ header: undefined, menu: null, badge: 'operand' });
        await act(async () => editor.editInputs!.onPress());
        const popover = output.getCurrent().editor.popover;
        if (!React.isValidElement<React.ComponentProps<typeof WidgetSetupPopover>>(popover)) throw Error('No group editor');
        expect.soft(popover.props.readInherited?.(group).get('targetPath'), order).toEqual({ kind: 'single', valueLabel: 'operand', source: 'group' });
        await output.unmount();
    }
});
