import * as React from 'react';
import { HappierActionPanel, HappierActionPanelSection } from '../presentation/interaction/ActionPanel.js';
import { HappierDataChart } from '../presentation/data/Chart.js';
import { HappierDataMetric } from '../presentation/data/Metric.js';
import { HappierDataRows, HappierDataTable } from '../presentation/data/DataRows.js';
import { HappierHeading, HappierMetadata } from '../presentation/content/Foundation.js';
import { HappierInfoState, HappierInfoTile } from '../presentation/state/InfoState.js';
import { HappierList, HappierListItem, HappierListSection } from '../presentation/collection/List.js';
import { HappierMarkdown } from '../presentation/content/Markdown.js';
import { HappierStack, resolveHappierLayoutGap } from '../presentation/layout/Layout.js';
import { HappierStatus } from '../presentation/status/Status.js';
import { HappierSpinner } from '../presentation/feedback/Spinner.js';
import { HAPPIER_TONE_COLOR_TOKEN, type HappierTone } from '../presentation/semantics.js';
import type { HappierUiAccessibility, HappierUiTheme } from '../environment/index.js';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import type { PluginUiDeclarativeNodeV2 as PluginDeclarativeNodeV2, PluginUiDeclarativeToneV2 as PluginDeclarativeToneV2 } from '@happier-dev/plugin-sdk/ui';
type PluginDeclarativeStateV2 = Extract<PluginDeclarativeNodeV2, { kind: 'state' }>['state'];


/**
 * The single traversal and semantic anatomy for admitted declarative content.
 * App and public viewers inject their host leaves and canonical admission/data
 * readers; those bindings never replace the node vocabulary or its traversal.
 */

type RecordValue = Readonly<Record<string, unknown>>;

const RETAIN_DISABLED_ACTION_STRUCTURE = (): void => {};

export function readDeclarativeRecord(value: unknown): RecordValue | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null;
}

/** How one consumer turns a declarative `PluginLocalizedString` into display text. */
export type DeclarativeTextResolver = (value: unknown) => string;

/**
 * The immutable-fallback resolver: parse the declared value and keep the
 * author's own words rather than leaking a raw key.
 *
 * This is the correct resolver for a persisted transcript, whose text is a
 * frozen snapshot and must not be retranslated by whatever plugin bundle
 * happens to be installed when the message is replayed.
 */
export function readDeclarativeText(value: unknown): string {
    if (typeof value === 'string') return value;
    const candidate = readDeclarativeRecord(value);
    return typeof candidate?.fallback === 'string' ? candidate.fallback : '';
}

export type DeclarativeFindTextBlock = Readonly<{
    id: string;
    text: string;
    format?: 'plain' | 'markdown';
}>;
type DeclarativeTextField = Readonly<{
    field: string;
    text: string;
    format?: 'markdown';
    afterChildren?: boolean;
}>;

function declarativeTextFields(node: RecordValue, localize: DeclarativeTextResolver, fields: readonly string[]): DeclarativeTextField[] {
    return fields.map((field) => ({ field, text: localize(node[field]) })).filter((entry) => entry.text.length > 0);
}

function readDisplayText(context: DeclarativeNodeRenderContext, field: string): string {
    return context.textFields?.get(field)?.text ?? '';
}

function readDisplayTextBlock(context: DeclarativeNodeRenderContext, field: string): DeclarativeFindTextBlock {
    const entry = context.textFields?.get(field);
    return {
        id: `structured-declarative:${context.nodePath}:${field}`,
        text: entry?.text ?? '',
        ...(entry?.format ? { format: entry.format } : {}),
    };
}

function renderDisplayText(context: DeclarativeNodeRenderContext, field: string): React.ReactNode {
    const block = readDisplayTextBlock(context, field);
    return context.renderText?.(block) ?? block.text;
}

/**
 * The live-surface resolver: the same parse, but the declared key is answered
 * by the mounted surface's admitted translation bundle for the current locale.
 *
 * A mounted document is current UI, so it follows the user's language; the
 * author's fallback still answers every key the bundle does not define, and the
 * raw key is never shown.
 */
export function createDeclarativeTextResolver(
    translate: ((key: string, fallback?: string) => string) | undefined,
): DeclarativeTextResolver {
    if (!translate) return readDeclarativeText;
    return (value) => {
        if (typeof value === 'string') return value;
        const candidate = readDeclarativeRecord(value);
        const fallback = typeof candidate?.fallback === 'string' ? candidate.fallback : '';
        const key = typeof candidate?.key === 'string' ? candidate.key : '';
        return key ? translate(key, fallback) : fallback;
    };
}

/**
 * Declarative tone is its own bounded protocol vocabulary. This maps it once
 * onto shared presentation tone; `HAPPIER_TONE_COLOR_TOKEN` then projects that
 * shared role through the already-captured presentation theme.
 */
export const DECLARATIVE_TONE_TO_HAPPIER_TONE: Readonly<Record<
    PluginDeclarativeToneV2,
    HappierTone
>> = Object.freeze({
    default: 'neutral',
    muted: 'muted',
    success: 'success',
    warning: 'warning',
    danger: 'danger',
});


/**
 * Collection-state presentation. `error` and `loading` are announced through a
 * role and a busy state respectively so a screen-reader user learns the state
 * without seeing the tint; `empty` is ordinary content whose title carries the
 * meaning.
 */
export const DECLARATIVE_STATE_PRESENTATION: Readonly<Record<
    PluginDeclarativeStateV2,
    Readonly<{ tone: PluginDeclarativeToneV2; role: 'alert' | undefined; busy: boolean }>
>> = Object.freeze({
    empty: { tone: 'muted', role: undefined, busy: false },
    loading: { tone: 'muted', role: undefined, busy: true },
    error: { tone: 'danger', role: 'alert', busy: false },
});

export function resolveDeclarativePresentationTone(tone: unknown): HappierTone {
    const resolved = typeof tone === 'string'
        ? DECLARATIVE_TONE_TO_HAPPIER_TONE[tone as PluginDeclarativeToneV2]
        : undefined;
    return resolved ?? DECLARATIVE_TONE_TO_HAPPIER_TONE.default;
}

export function resolveDeclarativeToneColor(theme: HappierUiTheme, tone: unknown): string {
    return theme.colors[HAPPIER_TONE_COLOR_TOKEN[resolveDeclarativePresentationTone(tone)]];
}


function resolveToneAccessibilityLabel(context: DeclarativeNodeRenderContext, tone: unknown): string | null {
    return context.host.toneAccessibilityLabel(tone);
}

function resolveStatePresentation(state: unknown) {
    return (typeof state === 'string'
        ? DECLARATIVE_STATE_PRESENTATION[state as PluginDeclarativeStateV2]
        : undefined) ?? DECLARATIVE_STATE_PRESENTATION.empty;
}

/**
 * What a consumer knows about invoking one action-bearing node. `null` from
 * {@link DeclarativeNodeRenderContext.resolveAction} means the consumer cannot
 * offer the action at all: a standalone `action` node then renders nothing, and
 * an `item` row degrades to a non-interactive row.
 */
export type DeclarativeActionAffordance = Readonly<{
    /** Stable identity for the affordance's `testID` — the qualified action id when it resolved. */
    key: string;
    disabled: boolean;
    busy: boolean;
    onPress?: () => unknown;
}>;

type DeclarativeTextProps = Readonly<{
    children?: React.ReactNode;
    testID?: string;
    selectable?: boolean;
    accessibilityLabel?: string;
    style?: Readonly<{ color: string }>;
}>;

export type DeclarativeRenderingHost = Readonly<{
    Text: React.ComponentType<DeclarativeTextProps>;
    renderIcon: (token: string, size: 'small' | 'large', color: string | undefined, direction: 'ltr' | 'rtl' | undefined) => React.ReactNode;
    renderMarkdown: (input: Readonly<{ value: string; selectable: boolean; testID?: string }>) => React.ReactElement;
    renderSpinner: (color: string) => React.ReactNode;
    toneAccessibilityLabel: (tone: unknown) => string | null;
    incompleteText: string;
    readDataNode: (value: unknown) => PluginDeclarativeNodeV2 | null;
    readDataField: (value: unknown, field: Extract<PluginDeclarativeNodeV2, { kind: 'metric' }>['value']) => string | number | boolean;
    readDataRows: (value: unknown, field: readonly string[]) => readonly unknown[];
    renderAction: (node: RecordValue, affordance: DeclarativeActionAffordance, context: DeclarativeNodeRenderContext, label: React.ReactNode) => React.ReactNode;
}>;

export type DeclarativeNodeRenderContext = Readonly<{
    host: DeclarativeRenderingHost;
    presentationTheme: HappierUiTheme;
    widgetPresentation?: RenderContext['widgetPresentation'];
    /**
     * How this consumer resolves declared localized text. A mounted surface
     * supplies its environment-bound resolver; a persisted transcript supplies
     * {@link readDeclarativeText} so replay stays immutable. Required, so a new
     * consumer has to state which of the two it is.
     */
    localize: DeclarativeTextResolver;
    /** Exact direction supplied by the mounted surface when it has one. */
    direction?: 'ltr' | 'rtl';
    /** Resolved by the mounted surface environment; transcript rendering has no host preference. */
    contrast?: HappierUiAccessibility['contrast'];
    /** Platform minimum interactive target, resolved by the consumer's mount. */
    minimumTouchTarget: number;
    /** Live mounted surfaces use the component adapter so mount/tab activity pauses motion. */
    useSharedSpinner?: boolean;
    resolveAction: (node: RecordValue) => DeclarativeActionAffordance | null;
    /**
     * Settings controls are the one leaf the two consumers genuinely disagree
     * about: a mounted surface edits them, a transcript block only names them.
     */
    renderField: (node: RecordValue) => React.ReactNode;
    /**
     * Account Collection data is mounted-surface-only. The renderer keeps the
     * node vocabulary closed while each consumer supplies its real Data seam.
     */
    renderCollectionList: (node: RecordValue) => React.ReactNode;
    /**
     * A live data read is supplied only by its exact host Resource adapter. `path` is the node's
     * place in the document (`root.children[1]`), stable across reads, so two nodes reading the same
     * source stay two nodes.
     */
    renderDataNode?: (node: RecordValue, path: string) => React.ReactNode;
    /**
     * Only a live mounted surface can supply the target-local bridge. Immutable
     * transcript rendering deliberately leaves it absent, so a persisted node
     * never resolves a current contributor, renderer, or Host API.
     */
    renderTargetedSurface?: (node: RecordValue) => React.ReactNode;
    /**
     * A page's declared widget area, drawn by the host's one area owner. Only a live mounted page
     * supplies it; persisted transcript and Session content exclude the node.
     */
    renderWidgetArea?: (node: RecordValue) => React.ReactNode;
    /** Live mounts bind these through the shared host runtime; replay retains only children. */
    renderDragNode?: (node: RecordValue, children: React.ReactNode) => React.ReactNode;
    /** Internal deterministic fallback for persisted nodes, which intentionally have no live projection path. */
    nodePath?: string;
    /** Owner-resolved visible fields; descendants receive their own model from the same descriptor. */
    textFields?: ReadonlyMap<string, DeclarativeTextField>;
    /** A consumer decorates glyphs without replacing the canonical node anatomy. */
    renderText?: (block: DeclarativeFindTextBlock) => React.ReactNode;
    renderMarkdown?: (block: DeclarativeFindTextBlock, selectable: boolean | undefined, testID: string | undefined) => React.ReactElement;
}>;

function readDeclarativePath(node: RecordValue, fallbackPath: string | undefined): string {
    return typeof node.path === 'string' && node.path.trim().length > 0
        ? node.path
        : (fallbackPath ?? 'root');
}

function renderDeclarativeChildren(
    node: RecordValue,
    context: DeclarativeNodeRenderContext,
): React.ReactNode[] {
    const children = Array.isArray(node.children) ? node.children : [];
    const parentPath = readDeclarativePath(node, context.nodePath);
    return children.map((child, index) => renderDeclarativeNode(
        child,
        context,
        `${parentPath}.children[${index}]`,
    ));
}

type DeclarativeNodeRenderer = (
    node: RecordValue,
    context: DeclarativeNodeRenderContext,
) => React.ReactNode;

/** The body's size without its measured room, for a node that shares the body with siblings. */
function withoutGeometry(presentation: NonNullable<DeclarativeNodeRenderContext['widgetPresentation']>): DeclarativeNodeRenderContext['widgetPresentation'] {
    const { geometry: _geometry, ...rest } = presentation;
    return rest;
}

/** `stack` and `group` are one free-form container with two spellings. */
const renderDeclarativeContainer: DeclarativeNodeRenderer = (node, context) => (
    <HappierStack
        key={readDeclarativePath(node, context.nodePath)}
        testID={`plugin-declarative-${String(node.kind)}`}
        gap={resolveHappierLayoutGap(
            node.gap === 'large' || node.gap === 'small' ? node.gap : 'medium',
            context.presentationTheme.spacing,
        )}
        direction={node.kind === 'stack' && node.direction === 'horizontal' ? 'horizontal' : 'vertical'}
        wrap
    >
        {readDisplayText(context, 'title') ? (
            <HappierHeading level={3} theme={context.presentationTheme}>{renderDisplayText(context, 'title')}</HappierHeading>
        ) : null}
        {readDisplayText(context, 'description') ? <context.host.Text>{renderDisplayText(context, 'description')}</context.host.Text> : null}
        {/* Children share the body: only a node that is the whole body may fill its height (a chart). */}
        {renderDeclarativeChildren(node, context.widgetPresentation?.geometry
            ? { ...context, widgetPresentation: withoutGeometry(context.widgetPresentation) } : context)}
    </HappierStack>
);

type DeclarativeNodeDescriptor = Readonly<{
    render: DeclarativeNodeRenderer;
    text: (node: RecordValue, localize: DeclarativeTextResolver) => readonly DeclarativeTextField[];
    children?: boolean;
    /** Persisted snapshots retain valid historical actions; malformed identities render nothing. */
    snapshotVisible?: (node: RecordValue) => boolean;
}>;

function declarativeNode(
    text: DeclarativeNodeDescriptor['text'],
    render: DeclarativeNodeRenderer,
    children = false,
): DeclarativeNodeDescriptor {
    return { text, render, children };
}

const noDisplayText = (): readonly DeclarativeTextField[] => [];
const containerDisplayText: DeclarativeNodeDescriptor['text'] = (node, localize) => (
    declarativeTextFields(node, localize, node.kind === 'group' ? ['title', 'description'] : ['description'])
);

/**
 * Inert semantic data stays readable in every declarative host: a widget body, a frozen Board
 * snapshot and a transcript block draw the same public data nodes plugin authors use
 * (`Metric`, `DataRows`, `DataTable`, `Chart`). A live Resource read is supplied by the mounted
 * host's `renderDataNode`; a node whose frozen bytes no longer match its fields draws nothing rather
 * than a guessed value.
 */
const renderDeclarativeData: DeclarativeNodeRenderer = (value, context) => {
    const key = readDeclarativePath(value, context.nodePath);
    if (context.renderDataNode) return context.renderDataNode(value, key);
    const { path: _path, order: _order, ...authored } = value;
    const node = context.host.readDataNode(authored);
    if (!node || !('data' in node) || node.data.kind !== 'value') return null;
    const data = node.data.value;
    const { readDataField: readPluginDeclarativeDataFieldV1, readDataRows: readPluginDeclarativeDataRowsV1 } = context.host;
    const testID = `plugin-declarative-${node.kind}`;
    const theme = context.presentationTheme;
    try {
        if (node.kind === 'metric') {
            return <HappierDataMetric key={key} testID={testID} theme={theme} label={context.localize(node.label)}
                value={readPluginDeclarativeDataFieldV1(data, node.value)} {...(node.unit ? { unit: context.localize(node.unit) } : {})}
                {...(node.comparison ? { comparison: { value: String(readPluginDeclarativeDataFieldV1(data, node.comparison.value)),
                    label: context.localize(node.comparison.label), meaning: node.comparison.meaning } } : {})} />;
        }
        const rows = readPluginDeclarativeDataRowsV1(data, node.rows);
        if (node.kind === 'chart') {
            return <HappierDataChart key={key} testID={testID} theme={theme} label={context.localize(node.label)} style={node.style}
                viewportHeight={context.widgetPresentation?.geometry?.height}
                points={rows.map((row) => {
                    const x = readPluginDeclarativeDataFieldV1(row, node.x);
                    return { x: typeof x === 'boolean' ? String(x) : x, y: Number(readPluginDeclarativeDataFieldV1(row, node.y)) };
                })} />;
        }
        const columns = node.columns.map((column) => ({ label: context.localize(column.label),
            ...(column.priority ? { priority: column.priority } : {}), ...(column.proportion ? { proportion: true } : {}) }));
        const cells = rows.map((row) => node.columns.map((column) => readPluginDeclarativeDataFieldV1(row, column.field)));
        const shared = { testID, theme, columns, rows: cells,
            ...(node.mark ? { marks: rows.map(row => {
                const passed = readPluginDeclarativeDataFieldV1(row, node.mark!.field) === true;
                const state = passed ? node.mark!.whenTrue : node.mark!.whenFalse;
                return { passed, label: context.localize(state.label), meaning: state.meaning };
            }) } : {}),
            ...(node.label ? { label: context.localize(node.label) } : {}),
            ...(node.incomplete ? { incomplete: context.host.incompleteText } : {}) };
        return node.kind === 'table' ? <HappierDataTable key={key} {...shared} /> : <HappierDataRows key={key} {...shared} />;
    } catch {
        return null;
    }
};

/**
 * One renderer per declarative node kind, keyed by the protocol vocabulary.
 *
 * This `Record<PluginDeclarativeNodeV2['kind'], …>` is the schema→renderer
 * closure for the node vocabulary itself, matching the tone/variant/state tables
 * above. The predecessor was an `if (node.kind === …)` chain over a schema typed
 * `z.ZodType<unknown>`: a node kind added in Protocol reached this file as a
 * string nobody handled and rendered as nothing at all. A new member now has to
 * decide what it renders before it can compile.
 */
const DECLARATIVE_NODE_RENDERERS = Object.freeze({
    metric: declarativeNode((node, localize) => declarativeTextFields(node, localize, ['label', 'unit']), renderDeclarativeData),
    table: declarativeNode((node, localize) => declarativeTextFields(node, localize, ['label']), renderDeclarativeData),
    rows: declarativeNode((node, localize) => declarativeTextFields(node, localize, ['label']), renderDeclarativeData),
    chart: declarativeNode((node, localize) => declarativeTextFields(node, localize, ['label']), renderDeclarativeData),
    dragSource: declarativeNode(noDisplayText, (node, context) => {
        const children = renderDeclarativeChildren(node, context);
        return context.renderDragNode?.(node, children) ?? children;
    }, true),
    dropTarget: declarativeNode(noDisplayText, (node, context) => {
        const children = renderDeclarativeChildren(node, context);
        return context.renderDragNode?.(node, children) ?? children;
    }, true),
    stack: declarativeNode(containerDisplayText, renderDeclarativeContainer, true),
    group: declarativeNode(containerDisplayText, renderDeclarativeContainer, true),
    list: declarativeNode(noDisplayText, (node, context) => {
        const label = context.localize(node.label);
        const path = readDeclarativePath(node, context.nodePath);
        return (
            <HappierList
                key={path}
                testID={`plugin-declarative-list:${path}`}
                {...(label ? { accessibilityLabel: label } : {})}
                style={{ gap: 8 }}
            >
                {renderDeclarativeChildren(node, context)}
            </HappierList>
        );
    }, true),
    section: declarativeNode((node, localize) => [
        ...declarativeTextFields(node, localize, ['title']),
        ...declarativeTextFields(node, localize, ['footer']).map((field) => ({ ...field, afterChildren: true })),
    ], (node, context) => {
        const footer = readDisplayText(context, 'footer');
        return (
            <HappierListSection
                key={readDeclarativePath(node, context.nodePath)}
                title={readDisplayText(context, 'title')}
                titleContent={context.renderText ? renderDisplayText(context, 'title') : undefined}
            >
                {renderDeclarativeChildren(node, context)}
                {footer ? <context.host.Text>{renderDisplayText(context, 'footer')}</context.host.Text> : null}
            </HappierListSection>
        );
    }, true),
    actionPanel: declarativeNode(noDisplayText, (node, context) => {
        const title = context.localize(node.title);
        const path = readDeclarativePath(node, context.nodePath);
        return (
            <HappierActionPanel
                key={path}
                testID={`plugin-declarative-action-panel:${path}`}
                {...(title ? { title } : {})}
            >
                <HappierActionPanelSection>
                    {renderDeclarativeChildren(node, context)}
                </HappierActionPanelSection>
            </HappierActionPanel>
        );
    }, true),
    item: declarativeNode((node, localize) => declarativeTextFields(node, localize, ['title', 'subtitle', 'detail']), (node, context) => {
        const affordance = node.action === undefined ? null : context.resolveAction(node);
        const toneLabel = resolveToneAccessibilityLabel(context, node.tone);
        const iconToken = typeof node.icon === 'string' ? node.icon : null;
        const title = readDisplayText(context, 'title');
        const subtitle = readDisplayText(context, 'subtitle');
        const detail = readDisplayText(context, 'detail');
        const path = readDeclarativePath(node, context.nodePath);
        return (
            <HappierListItem
                key={path}
                testID={`plugin-declarative-item:${path}`}
                title={title}
                subtitle={subtitle || undefined}
                detail={detail || undefined}
                titleContent={context.renderText ? renderDisplayText(context, 'title') : undefined}
                subtitleContent={context.renderText ? renderDisplayText(context, 'subtitle') : undefined}
                detailContent={context.renderText ? renderDisplayText(context, 'detail') : undefined}
                icon={iconToken ? context.host.renderIcon(iconToken, 'small', undefined, context.direction) : undefined}
                accessibilityLabel={[toneLabel, title, subtitle, detail].map(part => part?.trim()).filter(Boolean).join('. ') || undefined}
                tone={resolveDeclarativePresentationTone(node.tone)}
                busy={affordance?.busy === true}
                theme={context.presentationTheme}
                minimumTouchTarget={context.minimumTouchTarget}
                {...(affordance
                    ? {
                        disabled: affordance.disabled,
                        // An admitted Action row keeps one Pressable identity
                        // while it becomes busy, denied, or temporarily
                        // unavailable. The disabled owner suppresses this
                        // fallback, so it cannot dispatch; retaining the host
                        // node preserves focus and its accessible role.
                        onPress: affordance.onPress ?? RETAIN_DISABLED_ACTION_STRUCTURE,
                    }
                    : node.action === undefined
                        ? {}
                        : {
                            disabled: true,
                            onPress: RETAIN_DISABLED_ACTION_STRUCTURE,
                        })}
            />
        );
    }),
    state: declarativeNode((node, localize) => declarativeTextFields(node, localize, ['title', 'description']), (node, context) => {
        const presentation = resolveStatePresentation(node.state);
        const description = readDisplayText(context, 'description');
        const iconToken = typeof node.icon === 'string' ? node.icon : null;
        const color = resolveDeclarativeToneColor(context.presentationTheme, presentation.tone);
        const path = readDeclarativePath(node, context.nodePath);
        return (
            <HappierInfoState
                key={path}
                testID={`plugin-declarative-state:${path}`}
                accessibilityRole={presentation.role}
                accessibilityLiveRegion="polite"
                busy={presentation.busy}
            >
                <HappierInfoTile
                    icon={presentation.busy
                        ? context.useSharedSpinner
                            ? context.host.renderSpinner(color)
                            : <HappierSpinner color={color} animationEnabled={false} />
                        : (iconToken
                            ? context.host.renderIcon(iconToken, 'large', color, context.direction)
                            : undefined)}
                    title={<context.host.Text style={{ color }}>{renderDisplayText(context, 'title')}</context.host.Text>}
                    description={description ? <context.host.Text>{renderDisplayText(context, 'description')}</context.host.Text> : undefined}
                />
            </HappierInfoState>
        );
    }),
    metadata: declarativeNode((node, localize) => [
        ...declarativeTextFields(node, localize, ['title']),
        ...(Array.isArray(node.entries) ? node.entries : []).flatMap((entryValue, index) => {
            const entry = readDeclarativeRecord(entryValue);
            return entry ? declarativeTextFields(entry, localize, ['label', 'value'])
                .map((field) => ({ ...field, field: `entries[${index}].${field.field}` })) : [];
        }),
    ], (node, context) => {
        const entries = Array.isArray(node.entries) ? node.entries : [];
        const title = readDisplayText(context, 'title');
        const path = readDeclarativePath(node, context.nodePath);
        return <HappierMetadata
            key={path}
            testID={`plugin-declarative-metadata:${path}`}
            title={title || undefined}
            titleContent={context.renderText ? renderDisplayText(context, 'title') : undefined}
            theme={context.presentationTheme}
            entries={entries.flatMap((entryValue, index) => {
                const entry = readDeclarativeRecord(entryValue);
                if (!entry) return [];
                const label = readDisplayText(context, `entries[${index}].label`);
                const value = readDisplayText(context, `entries[${index}].value`);
                return [{
                    label,
                    value,
                    labelContent: context.renderText ? renderDisplayText(context, `entries[${index}].label`) : undefined,
                    valueContent: context.renderText ? renderDisplayText(context, `entries[${index}].value`) : undefined,
                    tone: resolveDeclarativePresentationTone(entry.tone),
                    testID: `plugin-declarative-metadata-entry:${path}:${index}`,
                    accessibilityLabel: [resolveToneAccessibilityLabel(context, entry.tone), label, value]
                        .filter((part): part is string => Boolean(part))
                        .join(': '),
                }];
            })}
        />;
    }),
    text: declarativeNode((node, localize) => declarativeTextFields(node, localize, ['text']), (node, context) => {
        const toneLabel = resolveToneAccessibilityLabel(context, node.tone);
        const text = readDisplayText(context, 'text');
        return (
            <context.host.Text
                key={readDeclarativePath(node, context.nodePath)}
                testID={`plugin-declarative-text:${readDeclarativePath(node, context.nodePath)}`}
                selectable
                {...(toneLabel ? { accessibilityLabel: `${toneLabel}: ${text}` } : {})}
                style={{ color: resolveDeclarativeToneColor(context.presentationTheme, node.tone) }}
            >
                {renderDisplayText(context, 'text')}
            </context.host.Text>
        );
    }),
    markdown: declarativeNode((node, localize) => declarativeTextFields(node, localize, ['text'])
        .map((field) => ({ ...field, format: 'markdown' as const })), (node, context) => (
        <HappierMarkdown
            key={readDeclarativePath(node, context.nodePath)}
            testID={`plugin-declarative-markdown:${readDeclarativePath(node, context.nodePath)}`}
            value={readDisplayText(context, 'text')}
            selectable
            renderContent={(input) => context.renderMarkdown
                ? context.renderMarkdown(readDisplayTextBlock(context, 'text'), input.selectable, input.testID)
                : context.host.renderMarkdown(input)}
        />
    )),
    status: declarativeNode((node, localize) => declarativeTextFields(node, localize, ['label', 'value']), (node, context) => {
        const label = readDisplayText(context, 'label');
        const value = readDisplayText(context, 'value');
        // Declarative status may carry its whole meaning in `tone` while the
        // label and value stay neutral. Sighted users read that as colour, so
        // the shared owner is given the same meaning in words, exactly once.
        const toneLabel = resolveToneAccessibilityLabel(context, node.tone);
        const accessibilityLabel = toneLabel
            ? [toneLabel, label, value].filter((part) => part.length > 0).join(': ')
            : undefined;
        return (
            <HappierStatus
                key={readDeclarativePath(node, context.nodePath)}
                testID="plugin-declarative-status"
                label={<context.host.Text>{renderDisplayText(context, 'label')}</context.host.Text>}
                value={(
                    <context.host.Text
                        testID={`plugin-declarative-status-value:${readDeclarativePath(node, context.nodePath)}`}
                        selectable
                        style={{ color: resolveDeclarativeToneColor(context.presentationTheme, node.tone) }}
                    >
                        {renderDisplayText(context, 'value')}
                    </context.host.Text>
                )}
                tone={resolveDeclarativePresentationTone(node.tone)}
                theme={context.presentationTheme}
                contrast={context.contrast}
                {...(accessibilityLabel ? { accessibilityLabel } : {})}
                accessibilityLiveRegion="polite"
            />
        );
    }),
    action: {
        ...declarativeNode((node, localize) => declarativeTextFields(node, localize, ['label']), (node, context) => {
            const affordance = context.resolveAction(node);
            return affordance ? context.host.renderAction(node, affordance, context, renderDisplayText(context, 'label')) : null;
        }),
        snapshotVisible: (node: RecordValue) => node.action !== undefined,
    },
    field: declarativeNode(noDisplayText, (node, context) => context.renderField(node)),
    collectionList: declarativeNode(noDisplayText, (node, context) => context.renderCollectionList(node)),
    targetedSurface: declarativeNode(noDisplayText, (node, context) => context.renderTargetedSurface?.(node) ?? null),
    widgetArea: declarativeNode(noDisplayText, (node, context) => context.renderWidgetArea?.(node) ?? null),
} satisfies Readonly<Record<PluginDeclarativeNodeV2['kind'], DeclarativeNodeDescriptor>>);

function readDeclarativeNodeDescriptor(node: RecordValue): DeclarativeNodeDescriptor | undefined {
    return typeof node.kind === 'string' && Object.hasOwn(DECLARATIVE_NODE_RENDERERS, node.kind)
        ? DECLARATIVE_NODE_RENDERERS[node.kind as PluginDeclarativeNodeV2['kind']]
        : undefined;
}

export function renderDeclarativeNode(
    nodeValue: unknown,
    context: DeclarativeNodeRenderContext,
    fallbackPath = 'root',
): React.ReactNode {
    const node = readDeclarativeRecord(nodeValue);
    if (!node) return null;
    const descriptor = readDeclarativeNodeDescriptor(node);
    return descriptor ? descriptor.render(node, {
        ...context,
        nodePath: readDeclarativePath(node, fallbackPath),
        textFields: new Map(descriptor.text(node, context.localize).map((field) => [field.field, field])),
    }) : null;
}

/** Frozen glyph sources, projected through the same vocabulary, field model and paths as rendering. */
export function projectDeclarativeStructuredFindText(root: unknown, isActionSelectionValid: (action: unknown) => boolean): readonly DeclarativeFindTextBlock[] {
    const blocks: DeclarativeFindTextBlock[] = [];
    const visit = (nodeValue: unknown, fallbackPath: string): void => {
        const node = readDeclarativeRecord(nodeValue);
        if (!node) return;
        const descriptor = readDeclarativeNodeDescriptor(node);
        if (!descriptor || (descriptor.snapshotVisible && !isActionSelectionValid(node.action))) return;
        const path = readDeclarativePath(node, fallbackPath);
        const fields = descriptor.text(node, readDeclarativeText);
        const append = (field: DeclarativeTextField) => blocks.push({
            id: `structured-declarative:${path}:${field.field}`,
            text: field.text,
            ...(field.format ? { format: field.format } : {}),
        });
        fields.filter((field) => !field.afterChildren).forEach(append);
        if (descriptor.children && Array.isArray(node.children)) {
            node.children.forEach((child, index) => visit(child, `${path}.children[${index}]`));
        }
        fields.filter((field) => field.afterChildren).forEach(append);
    };
    visit(root, 'root');
    return blocks;
}
