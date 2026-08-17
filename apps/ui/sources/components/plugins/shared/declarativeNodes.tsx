import * as React from 'react';
import { View } from 'react-native';

import {
    HappierActionPanel,
    HappierActionPanelSection,
    HappierHeading,
    HappierInfoState,
    HappierInfoTile,
    HappierList,
    HappierListItem,
    HappierListSection,
    HappierMarkdown,
    HappierMetadata,
    HappierPressable,
    HappierStack,
    HappierStatus,
    HAPPIER_TONE_COLOR_TOKEN,
    type HappierTone,
} from '@happier-dev/plugin-ui/presentation';
import type { HappierUiAccessibility, HappierUiTheme } from '@happier-dev/plugin-ui/environment';

import type {
    PluginDeclarativeActionVariantV2,
    PluginDeclarativeNodeV2,
    PluginDeclarativeStateV2,
    PluginDeclarativeToneV2,
} from '@happier-dev/protocol';

import type { Theme } from '@/theme';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { buildActionRowAccessibilityLabel } from '@/components/ui/lists/actionRowAccessibility';
import { Text } from '@/components/ui/text/Text';
import { resolvePluginUiIconName } from '@/components/plugins/surfaces/iconToken/resolvePluginUiIconToken';
import { t } from '@/text';

/**
 * The single host renderer for the declarative plugin node vocabulary
 * (`PluginDeclarativeNodeV2Schema`, plan §3.11).
 *
 * Two renderers used to walk this vocabulary — the mounted plugin surface and
 * the transcript structured-message block — and they had already drifted: the
 * transcript one dropped tone, rendered markdown as plain text, and would have
 * silently rendered nothing for every node kind the other one learned. One
 * vocabulary needs one renderer; the two consumers differ only in how an action
 * is dispatched and how a settings field is presented, so those are the only two
 * things they inject.
 */

type RecordValue = Readonly<Record<string, unknown>>;
type ThemeColors = Theme['colors'];

export function readDeclarativeRecord(value: unknown): RecordValue | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null;
}

/**
 * Resolve a `PluginLocalizedString` to display text. The projected plugin
 * translation bundle is applied upstream; this keeps the author-declared
 * fallback rather than leaking a raw key.
 */
export function readDeclarativeText(value: unknown): string {
    if (typeof value === 'string') return value;
    const candidate = readDeclarativeRecord(value);
    return typeof candidate?.fallback === 'string' ? candidate.fallback : '';
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

export const DECLARATIVE_ACTION_VARIANT_COLORS: Readonly<Record<
    PluginDeclarativeActionVariantV2,
    (colors: ThemeColors) => Readonly<{ background: string; border: string; label: string }>
>> = Object.freeze({
    primary: (colors) => ({
        background: colors.button.primary.background,
        border: colors.button.primary.background,
        label: colors.button.primary.tint,
    }),
    secondary: (colors) => ({
        background: colors.button.secondary.background,
        border: colors.border.default,
        label: colors.text.primary,
    }),
    destructive: (colors) => ({
        background: colors.state.danger.background,
        border: colors.state.danger.border,
        label: colors.state.danger.foreground,
    }),
});

/**
 * Tone reaches assistive technology as a word, never as a colour alone. `default`
 * and `muted` carry no semantic state, so they add nothing to speak. The same
 * `Record<…V2, …>` keying closes the vocabulary: a new tone member has to decide
 * what it announces.
 */
export const DECLARATIVE_TONE_ACCESSIBILITY_LABELS: Readonly<Record<
    PluginDeclarativeToneV2,
    (() => string) | null
>> = Object.freeze({
    default: null,
    muted: null,
    success: () => t('common.success'),
    warning: () => t('common.warning'),
    danger: () => t('common.error'),
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

function resolveVariantColors(colors: ThemeColors, variant: unknown) {
    const resolver = typeof variant === 'string'
        ? DECLARATIVE_ACTION_VARIANT_COLORS[variant as PluginDeclarativeActionVariantV2]
        : undefined;
    return (resolver ?? DECLARATIVE_ACTION_VARIANT_COLORS.secondary)(colors);
}

function resolveToneAccessibilityLabel(tone: unknown): string | null {
    const resolver = typeof tone === 'string'
        ? DECLARATIVE_TONE_ACCESSIBILITY_LABELS[tone as PluginDeclarativeToneV2]
        : undefined;
    return resolver ? resolver() : null;
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
    onPress?: () => void;
}>;

export type DeclarativeNodeRenderContext = Readonly<{
    colors: ThemeColors;
    presentationTheme: HappierUiTheme;
    /** Resolved by the mounted surface environment; transcript rendering has no host preference. */
    contrast?: HappierUiAccessibility['contrast'];
    /** Platform minimum interactive target, resolved by the consumer's mount. */
    minimumTouchTarget: number;
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
     * Only a live mounted surface can supply the target-local bridge. Immutable
     * transcript rendering deliberately leaves it absent, so a persisted node
     * never resolves a current contributor, renderer, or Host API.
     */
    renderTargetedSurface?: (node: RecordValue) => React.ReactNode;
    /** Internal deterministic fallback for persisted nodes, which intentionally have no live projection path. */
    nodePath?: string;
}>;

function renderActionAffordance(
    node: RecordValue,
    affordance: DeclarativeActionAffordance,
    context: DeclarativeNodeRenderContext,
): React.ReactElement {
    const variantColors = resolveVariantColors(context.colors, node.variant);
    return (
        <HappierPressable
            key={readDeclarativePath(node, context.nodePath)}
            testID={`plugin-declarative-action:${affordance.key}`}
            accessibilityRole="button"
            accessibilityHint={node.variant === 'destructive' ? t('common.destructiveActionHint') : undefined}
            disabled={affordance.disabled}
            busy={affordance.busy}
            onPress={affordance.onPress ?? (() => undefined)}
            style={{
                minWidth: context.minimumTouchTarget,
                minHeight: context.minimumTouchTarget,
                justifyContent: 'center',
                alignItems: 'center',
                paddingHorizontal: 12,
                borderRadius: 10,
                borderWidth: 1,
                backgroundColor: variantColors.background,
                borderColor: variantColors.border,
                opacity: affordance.disabled ? 0.5 : 1,
            }}
        >
            <Text
                testID={`plugin-declarative-action-label:${affordance.key}`}
                style={{ color: variantColors.label }}
            >
                {readDeclarativeText(node.label)}
            </Text>
        </HappierPressable>
    );
}

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

/** `stack` and `group` are one free-form container with two spellings. */
const renderDeclarativeContainer: DeclarativeNodeRenderer = (node, context) => (
    <HappierStack
        key={readDeclarativePath(node, context.nodePath)}
        testID={`plugin-declarative-${String(node.kind)}`}
        gap={node.gap === 'large' ? 16 : node.gap === 'small' ? 4 : 8}
        direction={node.kind === 'stack' && node.direction === 'horizontal' ? 'horizontal' : 'vertical'}
        wrap
    >
        {node.kind === 'group' && readDeclarativeText(node.title) ? (
            <HappierHeading level={3} theme={context.presentationTheme}>{readDeclarativeText(node.title)}</HappierHeading>
        ) : null}
        {readDeclarativeText(node.description) ? <Text>{readDeclarativeText(node.description)}</Text> : null}
        {renderDeclarativeChildren(node, context)}
    </HappierStack>
);

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
    stack: renderDeclarativeContainer,
    group: renderDeclarativeContainer,
    list: (node, context) => {
        const label = readDeclarativeText(node.label);
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
    },
    section: (node, context) => {
        const footer = readDeclarativeText(node.footer);
        return (
            <HappierListSection
                key={readDeclarativePath(node, context.nodePath)}
                title={readDeclarativeText(node.title)}
            >
                {renderDeclarativeChildren(node, context)}
                {footer ? <Text>{footer}</Text> : null}
            </HappierListSection>
        );
    },
    actionPanel: (node, context) => {
        const title = readDeclarativeText(node.title);
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
    },
    item: (node, context) => {
        const affordance = node.action === undefined ? null : context.resolveAction(node);
        const toneLabel = resolveToneAccessibilityLabel(node.tone);
        const iconToken = typeof node.icon === 'string' ? node.icon : null;
        const title = readDeclarativeText(node.title);
        const subtitle = readDeclarativeText(node.subtitle);
        const detail = readDeclarativeText(node.detail);
        const path = readDeclarativePath(node, context.nodePath);
        return (
            <HappierListItem
                key={path}
                testID={`plugin-declarative-item:${path}`}
                title={title}
                subtitle={subtitle || undefined}
                detail={detail || undefined}
                icon={iconToken ? <Icon name={resolvePluginUiIconName(iconToken)} size={ICON_SIZE.sm} /> : undefined}
                accessibilityLabel={buildActionRowAccessibilityLabel([toneLabel, title, subtitle, detail])}
                tone={resolveDeclarativePresentationTone(node.tone)}
                busy={affordance?.busy === true}
                theme={context.presentationTheme}
                minimumTouchTarget={context.minimumTouchTarget}
                {...(affordance
                    ? {
                        disabled: affordance.disabled,
                        onPress: affordance.onPress,
                    }
                    : {})}
            />
        );
    },
    state: (node, context) => {
        const presentation = resolveStatePresentation(node.state);
        const description = readDeclarativeText(node.description);
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
                        ? <ActivitySpinner />
                        : (iconToken ? <Icon name={resolvePluginUiIconName(iconToken)} size={ICON_SIZE.lg} color={color} /> : undefined)}
                    title={<Text style={{ color }}>{readDeclarativeText(node.title)}</Text>}
                    description={description ? <Text>{description}</Text> : undefined}
                />
            </HappierInfoState>
        );
    },
    metadata: (node, context) => {
        const entries = Array.isArray(node.entries) ? node.entries : [];
        const title = readDeclarativeText(node.title);
        const path = readDeclarativePath(node, context.nodePath);
        return <HappierMetadata
            key={path}
            testID={`plugin-declarative-metadata:${path}`}
            title={title || undefined}
            theme={context.presentationTheme}
            entries={entries.flatMap((entryValue, index) => {
                const entry = readDeclarativeRecord(entryValue);
                if (!entry) return [];
                const label = readDeclarativeText(entry.label);
                const value = readDeclarativeText(entry.value);
                return [{
                    label,
                    value,
                    tone: resolveDeclarativePresentationTone(entry.tone),
                    testID: `plugin-declarative-metadata-entry:${path}:${index}`,
                    accessibilityLabel: [resolveToneAccessibilityLabel(entry.tone), label, value]
                        .filter((part): part is string => Boolean(part))
                        .join(': '),
                }];
            })}
        />;
    },
    text: (node, context) => {
        const toneLabel = resolveToneAccessibilityLabel(node.tone);
        const text = readDeclarativeText(node.text);
        return (
            <Text
                key={readDeclarativePath(node, context.nodePath)}
                testID={`plugin-declarative-text:${readDeclarativePath(node, context.nodePath)}`}
                selectable
                {...(toneLabel ? { accessibilityLabel: `${toneLabel}: ${text}` } : {})}
                style={{ color: resolveDeclarativeToneColor(context.presentationTheme, node.tone) }}
            >
                {text}
            </Text>
        );
    },
    markdown: (node, context) => (
        <HappierMarkdown
            key={readDeclarativePath(node, context.nodePath)}
            testID={`plugin-declarative-markdown:${readDeclarativePath(node, context.nodePath)}`}
            value={readDeclarativeText(node.text)}
            selectable
            renderContent={(input) => (
                <MarkdownView markdown={input.value} selectable={input.selectable} testID={input.testID} />
            )}
        />
    ),
    status: (node, context) => (
        <HappierStatus
            key={readDeclarativePath(node, context.nodePath)}
            testID="plugin-declarative-status"
            label={<Text>{readDeclarativeText(node.label)}</Text>}
            value={(
                <Text
                    testID={`plugin-declarative-status-value:${readDeclarativePath(node, context.nodePath)}`}
                    selectable
                    style={{ color: resolveDeclarativeToneColor(context.presentationTheme, node.tone) }}
                >
                    {readDeclarativeText(node.value)}
                </Text>
            )}
            tone={resolveDeclarativePresentationTone(node.tone)}
            theme={context.presentationTheme}
            contrast={context.contrast}
            accessibilityLiveRegion="polite"
        />
    ),
    action: (node, context) => {
        const affordance = context.resolveAction(node);
        return affordance ? renderActionAffordance(node, affordance, context) : null;
    },
    field: (node, context) => context.renderField(node),
    collectionList: (node, context) => context.renderCollectionList(node),
    targetedSurface: (node, context) => context.renderTargetedSurface?.(node) ?? null,
} satisfies Readonly<Record<PluginDeclarativeNodeV2['kind'], DeclarativeNodeRenderer>>);

export function renderDeclarativeNode(
    nodeValue: unknown,
    context: DeclarativeNodeRenderContext,
    fallbackPath = 'root',
): React.ReactNode {
    const node = readDeclarativeRecord(nodeValue);
    if (!node || typeof node.kind !== 'string') return null;
    const renderer = DECLARATIVE_NODE_RENDERERS[node.kind as PluginDeclarativeNodeV2['kind']];
    return renderer ? renderer(node, { ...context, nodePath: fallbackPath }) : null;
}
