import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { HappierUiTheme } from '@happier-dev/plugin-ui/environment';
import { createMessageStructuredPresentationV1 } from '@happier-dev/protocol';
import { Spinner } from '@happier-dev/plugin-ui/components';
import { HappierDataChart, HappierDataMetric, HappierDataRows, HappierDataTable } from '@happier-dev/plugin-ui/presentation';

import { projectDeclarativeStructuredFindText, renderDeclarativeNode, type DeclarativeNodeRenderContext } from './declarativeNodes';
import { motionTokens } from '@/components/ui/motion/motionTokens';

describe('declarative frozen display-text projection', () => {
    it('keeps drag wrappers inert in snapshots and retains their visible children', () => {
        expect(projectDeclarativeStructuredFindText({ kind: 'dropTarget', target: { qualifiedId: 'acme/tray' }, children: [
            { kind: 'dragSource', source: { qualifiedId: 'acme/card' }, reference: { secret: 'transport' }, children: [
                { kind: 'text', text: 'Visible card' },
            ] },
        ] })).toEqual([{ id: 'structured-declarative:root.children[0].children[0]:text', text: 'Visible card' }]);
    });
    it('keeps visible snapshot fields and renderer fallback paths while excluding hidden identities and null leaves', () => {
        const persistedAction = createMessageStructuredPresentationV1({
            owner: { pluginId: 'acme.plugin', contributionLocalId: 'card' },
            snapshot: { kind: 'action', action: 'open', label: 'Retained action' },
        }).snapshot;
        const blocks = projectDeclarativeStructuredFindText({
            kind: 'group', title: { key: 'hidden-current-key', fallback: 'Frozen heading' }, description: 'Description',
            children: [
                { kind: 'list', label: 'Accessible collection name', children: [
                    { kind: 'section', title: 'Section', footer: 'Footer', children: [
                        { kind: 'item', title: 'Title', subtitle: 'Subtitle', detail: 'Detail', action: { hidden: 'identity' } },
                    ] },
                ] },
                { kind: 'metadata', path: 'captured', title: 'Metadata', entries: [
                    { label: 'Label', value: { key: 'hidden-value-key', fallback: 'Value' }, secret: 'Hidden extra' },
                ] },
                { kind: 'markdown', text: '**Visible** [link](hidden-target)' },
                { kind: 'status', label: 'State', value: 'Ready' },
                { ...persistedAction, path: 'root.children[4]' },
                { kind: 'action', label: 'Malformed action', action: { secret: 'Not rendered' } },
                { kind: 'field', label: 'Not rendered field' },
                { kind: 'collectionList', title: 'Not rendered collection' },
                { kind: 'targetedSurface', title: 'Not rendered target' },
                { kind: 'actionPanel', title: 'Accessible toolbar name', children: [{ kind: 'text', text: 'Body' }] },
                { kind: 'constructor', title: 'Invalid vocabulary' },
                { kind: '__proto__', title: 'Invalid vocabulary' },
            ],
        });
        expect(blocks).toEqual([
            { id: 'structured-declarative:root:title', text: 'Frozen heading' },
            { id: 'structured-declarative:root:description', text: 'Description' },
            { id: 'structured-declarative:root.children[0].children[0]:title', text: 'Section' },
            { id: 'structured-declarative:root.children[0].children[0].children[0]:title', text: 'Title' },
            { id: 'structured-declarative:root.children[0].children[0].children[0]:subtitle', text: 'Subtitle' },
            { id: 'structured-declarative:root.children[0].children[0].children[0]:detail', text: 'Detail' },
            { id: 'structured-declarative:root.children[0].children[0]:footer', text: 'Footer' },
            { id: 'structured-declarative:captured:title', text: 'Metadata' },
            { id: 'structured-declarative:captured:entries[0].label', text: 'Label' },
            { id: 'structured-declarative:captured:entries[0].value', text: 'Value' },
            { id: 'structured-declarative:root.children[2]:text', text: '**Visible** [link](hidden-target)', format: 'markdown' },
            { id: 'structured-declarative:root.children[3]:label', text: 'State' },
            { id: 'structured-declarative:root.children[3]:value', text: 'Ready' },
            { id: 'structured-declarative:root.children[4]:label', text: 'Retained action' },
            { id: 'structured-declarative:root.children[9].children[0]:text', text: 'Body' },
        ]);
    });
});

describe('declarative item action structure', () => {
    it('routes live loading state through the activity-aware shared Spinner adapter', () => {
        const rendered = renderDeclarativeNode({
            kind: 'state',
            path: 'root',
            state: 'loading',
            title: 'Loading reviews',
        }, {
            colors: {} as DeclarativeNodeRenderContext['colors'],
            presentationTheme: {
                colors: { textSecondary: '#777777' },
            } as unknown as HappierUiTheme,
            minimumTouchTarget: 44,
            useSharedSpinner: true,
            localize: (value) => typeof value === 'string' ? value : '',
            resolveAction: () => null,
            renderField: () => null,
            renderCollectionList: () => null,
        });

        expect(React.isValidElement(rendered)).toBe(true);
        const tile = (rendered as React.ReactElement<Readonly<{ children?: React.ReactNode }>>).props.children;
        expect(React.isValidElement(tile)).toBe(true);
        const icon = (tile as React.ReactElement<Readonly<{ icon?: React.ReactNode }>>).props.icon;
        expect(React.isValidElement(icon)).toBe(true);
        expect((icon as React.ReactElement).type).toBe(Spinner);
    });

    it('projects focus-visible and pressed state through the shared pressable style owner', () => {
        const context = {
            colors: {
                button: {
                    primary: { background: '#111111', tint: '#ffffff' },
                    secondary: { background: '#eeeeee' },
                },
                border: { default: '#777777' },
                text: { primary: '#222222' },
                state: { danger: { background: '#ffeeee', border: '#cc0000', foreground: '#990000' } },
            } as DeclarativeNodeRenderContext['colors'],
            presentationTheme: { colors: { focus: '#0055ff' } } as HappierUiTheme,
            minimumTouchTarget: 44,
            localize: (value: unknown) => typeof value === 'string' ? value : '',
            resolveAction: () => ({ key: 'acme.plugin/refresh', disabled: false, busy: false }),
            renderField: () => null,
            renderCollectionList: () => null,
        } satisfies DeclarativeNodeRenderContext;
        const rendered = renderDeclarativeNode({
            kind: 'action',
            path: 'root',
            action: 'refresh',
            label: 'Refresh',
        }, context) as React.ReactElement<Readonly<{ style?: unknown }>>;

        expect(rendered.props.style).toEqual(expect.any(Function));
        const label = (rendered as React.ReactElement<Readonly<{ children: React.ReactElement<Readonly<{ children: string }>> }>>).props.children;
        expect(label.props.children).toBe('Refresh');
        const style = rendered.props.style as (state: Readonly<{
            focused: boolean;
            pressed: boolean;
            disabled: boolean;
        }>) => Readonly<Record<string, unknown>>;
        // Focus draws the shared ring around the action; its own border keeps its colour.
        expect(style({ focused: true, pressed: false, disabled: false })).toMatchObject({
            borderColor: '#777777',
            outlineColor: '#0055ff',
            outlineOffset: 2,
            opacity: 1,
        });
        const unfocused = style({ focused: false, pressed: true, disabled: false });
        expect(unfocused).toMatchObject({
            borderColor: '#777777',
            opacity: motionTokens.press.opacitySubtle,
        });
        expect(unfocused.outlineColor).toBeUndefined();
        expect(style({ focused: true, pressed: true, disabled: true })).toMatchObject({
            outlineColor: '#0055ff',
            opacity: 0.5,
        });
    });

    it('retains one disabled primary-action host when an admitted action is temporarily unavailable', () => {
        const context: DeclarativeNodeRenderContext = {
            colors: {} as DeclarativeNodeRenderContext['colors'],
            presentationTheme: {} as HappierUiTheme,
            minimumTouchTarget: 44,
            localize: (value) => typeof value === 'string' ? value : '',
            resolveAction: () => ({
                key: 'acme.plugin/refresh',
                disabled: true,
                busy: true,
            }),
            renderField: () => null,
            renderCollectionList: () => null,
        };

        const rendered = renderDeclarativeNode({
            kind: 'item',
            path: 'root.children[0]',
            title: 'Refresh',
            action: 'refresh',
        }, context);
        expect(React.isValidElement(rendered)).toBe(true);
        const props = (rendered as React.ReactElement<Readonly<{
            disabled?: boolean;
            busy?: boolean;
            onPress?: () => void;
        }>>).props;
        expect(props).toMatchObject({ disabled: true, busy: true });
        expect(props.onPress).toEqual(expect.any(Function));
        expect(() => props.onPress?.()).not.toThrow();
    });

    it('does not manufacture an action host for a genuinely non-action item', () => {
        const resolveAction = vi.fn();
        const rendered = renderDeclarativeNode({
            kind: 'item',
            path: 'root.children[0]',
            title: 'Read only',
        }, {
            colors: {} as DeclarativeNodeRenderContext['colors'],
            presentationTheme: {} as HappierUiTheme,
            minimumTouchTarget: 44,
            localize: (value) => typeof value === 'string' ? value : '',
            resolveAction,
            renderField: () => null,
            renderCollectionList: () => null,
        });
        const props = (rendered as React.ReactElement<Readonly<{ onPress?: () => void }>>).props;
        expect(resolveAction).not.toHaveBeenCalled();
        expect(props.onPress).toBeUndefined();
    });

    it('uses the mounted direction for declarative logical icons', () => {
        const rendered = renderDeclarativeNode({
            kind: 'item',
            path: 'root.children[0]',
            title: 'Back',
            icon: 'back',
        }, {
            colors: {} as DeclarativeNodeRenderContext['colors'],
            presentationTheme: {} as HappierUiTheme,
            minimumTouchTarget: 44,
            direction: 'rtl',
            localize: (value) => typeof value === 'string' ? value : '',
            resolveAction: () => null,
            renderField: () => null,
            renderCollectionList: () => null,
        });

        const props = (rendered as React.ReactElement<Readonly<{
            icon?: React.ReactElement<Readonly<{ name?: string }>>;
        }>>).props;
        expect(props.icon?.props.name).toBe('arrow-right');
    });
});

describe('declarative data nodes', () => {
    const context = {
        colors: {} as DeclarativeNodeRenderContext['colors'],
        presentationTheme: {} as HappierUiTheme,
        minimumTouchTarget: 44,
        localize: (value: unknown) => typeof value === 'string' ? value : '',
        resolveAction: () => null,
        renderField: () => null,
        renderCollectionList: () => null,
    } satisfies DeclarativeNodeRenderContext;

    it('projects a comparison and CI marks into the shared public data components', () => {
        const metric = renderDeclarativeNode({ kind: 'metric', label: 'Checks',
            data: { kind: 'value', value: { count: 7, change: '+18%' } }, value: { path: ['count'], type: 'number' },
            comparison: { value: { path: ['change'], type: 'string' }, label: 'vs last week', meaning: 'good' },
        }, context) as React.ReactElement<Readonly<Record<string, unknown>>>;
        expect(metric.props.comparison).toEqual({ value: '+18%', label: 'vs last week', meaning: 'good' });
        const rows = renderDeclarativeNode({ kind: 'rows', rows: [],
            data: { kind: 'value', value: [{ name: 'Unit', passed: true }, { name: 'Build', passed: false }] },
            columns: [{ label: 'Check', field: { path: ['name'], type: 'string' } }],
            mark: { field: { path: ['passed'], type: 'boolean' }, whenTrue: { label: 'Passed', meaning: 'good' },
                whenFalse: { label: 'Failed', meaning: 'bad' } },
        }, context) as React.ReactElement<Readonly<Record<string, unknown>>>;
        expect(rows.props.marks).toEqual([{ passed: true, label: 'Passed', meaning: 'good' }, { passed: false, label: 'Failed', meaning: 'bad' }]);
    });

    it('draws frozen table data through the public table node with every row, column priority and the incomplete fact', () => {
        const people = Array.from({ length: 40 }, (_, index) => ({ c0: `Person ${index}`, c1: index % 2 ? 'Team' : 'Free', c2: `${10 + index}:00` }));
        const rendered = renderDeclarativeNode({
            kind: 'table', path: 'root', label: 'Newest people', incomplete: true, rows: [],
            data: { kind: 'value', value: people },
            columns: [
                { label: 'Person', field: { path: ['c0'], type: 'string' } },
                { label: 'Plan', field: { path: ['c1'], type: 'string' }, priority: 'secondary' },
                { label: 'Joined', field: { path: ['c2'], type: 'string' } },
            ],
        }, context) as React.ReactElement<Readonly<Record<string, unknown>>>;

        expect(rendered.type).toBe(HappierDataTable);
        expect(rendered.props.columns).toEqual([{ label: 'Person' }, { label: 'Plan', priority: 'secondary' }, { label: 'Joined' }]);
        expect(rendered.props.rows).toHaveLength(40);
        expect((rendered.props.rows as unknown[][])[39]).toEqual(['Person 39', 'Team', '49:00']);
        expect(rendered.props.incomplete).toEqual(expect.any(String));
    });

    it('draws a funnel as rows with a proportion column and a chart as one series of points', () => {
        const rows = renderDeclarativeNode({
            kind: 'rows', path: 'root.children[0]', rows: ['steps'],
            data: { kind: 'value', value: { steps: [{ name: 'Signed up', n: 1284 }, { name: 'Paired', n: 812 }] } },
            columns: [{ label: 'Step', field: { path: ['name'], type: 'string' } }, { label: 'People', field: { path: ['n'], type: 'number' }, proportion: true }],
        }, context) as React.ReactElement<Readonly<Record<string, unknown>>>;
        expect(rows.type).toBe(HappierDataRows);
        expect(rows.props.rows).toEqual([['Signed up', 1284], ['Paired', 812]]);
        expect(rows.props.columns).toEqual([{ label: 'Step' }, { label: 'People', proportion: true }]);

        const chart = renderDeclarativeNode({
            kind: 'chart', path: 'root.children[1]', label: 'Signups per day', style: 'bar', rows: [],
            data: { kind: 'value', value: [{ x: 'Tue', y: 236 }, { x: 'Wed', y: 183 }] },
            x: { path: ['x'], type: 'string' }, y: { path: ['y'], type: 'number' },
        }, context) as React.ReactElement<Readonly<Record<string, unknown>>>;
        expect(chart.type).toBe(HappierDataChart);
        expect(chart.props).toMatchObject({ label: 'Signups per day', style: 'bar', points: [{ x: 'Tue', y: 236 }, { x: 'Wed', y: 183 }] });

        const metric = renderDeclarativeNode({
            kind: 'metric', path: 'root.children[2]', label: 'Signups this week', unit: 'people',
            data: { kind: 'value', value: 1284 }, value: { path: [], type: 'number' },
        }, context) as React.ReactElement<Readonly<Record<string, unknown>>>;
        expect(metric.type).toBe(HappierDataMetric);
        expect(metric.props).toMatchObject({ label: 'Signups this week', value: 1284, unit: 'people' });
    });

    it('draws nothing rather than a guessed value when frozen bytes no longer match their fields', () => {
        expect(renderDeclarativeNode({
            kind: 'metric', path: 'root', label: 'Signups', data: { kind: 'value', value: { total: 'many' } },
            value: { path: ['total'], type: 'number' },
        }, context)).toBeNull();
    });

    it('gives the widget body’s height to a chart only when the chart is the whole body, never to one beside a metric', () => {
        const sized = { ...context, widgetPresentation: { size: 'medium' as const, footprint: { columns: 2, columnSpan: 1, rowSpan: 2, height: 'regular' as const, width: 'half' as const },
            geometry: { width: 320, height: 300 } } } satisfies DeclarativeNodeRenderContext;
        const series = { kind: 'chart', label: 'Signups per day', style: 'bar', rows: [],
            data: { kind: 'value', value: [{ x: 'Tue', y: 236 }, { x: 'Wed', y: 183 }] },
            x: { path: ['x'], type: 'string' }, y: { path: ['y'], type: 'number' } };
        const alone = renderDeclarativeNode({ ...series, path: 'root' }, sized) as React.ReactElement<Readonly<Record<string, unknown>>>;
        expect(alone.props.viewportHeight).toBe(300);
        const stack = renderDeclarativeNode({ kind: 'stack', path: 'root', children: [
            { kind: 'metric', label: 'Signups', data: { kind: 'value', value: 1284 }, value: { path: [], type: 'number' } }, series,
        ] }, sized) as React.ReactElement<Readonly<{ children: React.ReactNode }>>;
        const nested = React.Children.toArray(stack.props.children).flat()
            .find((child): child is React.ReactElement<Readonly<Record<string, unknown>>> => React.isValidElement(child) && child.type === HappierDataChart);
        expect(nested).toBeDefined();
        // Beside the metric the chart keeps its own plot height, so metric and bars both fit the card.
        expect(nested!.props.viewportHeight).toBeUndefined();
    });
});
