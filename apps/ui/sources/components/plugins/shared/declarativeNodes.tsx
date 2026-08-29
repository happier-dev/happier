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
    HappierSpinner,
    HAPPIER_TONE_COLOR_TOKEN,
    resolveHappierLayoutGap,
    type HappierTone,
} from '@happier-dev/plugin-ui/presentation';
import { Spinner } from '@happier-dev/plugin-ui/components';
import type { HappierUiAccessibility, HappierUiTheme } from '@happier-dev/plugin-ui/environment';

import type {
    PluginDeclarativeActionVariantV2,
    PluginDeclarativeNodeV2,
    PluginDeclarativeStateV2,
    PluginDeclarativeToneV2,
} from '@happier-dev/protocol';

import type { Theme } from '@/theme';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { buildActionRowAccessibilityLabel } from '@/components/ui/lists/actionRowAccessibility';
import { Text } from '@/components/ui/text/Text';
import {
    resolvePluginUiIconName,
    type PluginUiIconDirection,
} from '@/components/plugins/surfaces/iconToken/resolvePluginUiIconToken';
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
    onPress?: () => unknown;
}>;

export type DeclarativeNodeRenderContext = Readonly<{
    colors: ThemeColors;
    presentationTheme: HappierUiTheme;
    /**
     * How this consumer resolves declared localized text. A mounted surface
     * supplies its environment-bound resolver; a persisted transcript supplies
     * {@link readDeclarativeText} so replay stays immutable. Required, so a new
     * consumer has to state which of the two it is.
     */
    localize: DeclarativeTextResolver;
    /** Exact direction supplied by the mounted surface when it has one. */
    direction?: PluginUiIconDirection;
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
            style={(state) => ({
                minWidth: context.minimumTouchTarget,
                minHeight: context.minimumTouchTarget,
                justifyContent: 'center',
                alignItems: 'center',
                paddingHorizontal: 12,
                borderRadius: 10,
                borderWidth: 1,
                backgroundColor: variantColors.background,
                borderColor: state.focused ? context.presentationTheme.colors.focus : variantColors.border,
                opacity: state.disabled ? 0.5 : state.pressed ? 0.8 : 1,
            })}
        >
            <Text
                testID={`plugin-declarative-action-label:${affordance.key}`}
                style={{ color: variantColors.label }}
            >
                {context.localize(node.label)}
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
        gap={resolveHappierLayoutGap(
            node.gap === 'large' || node.gap === 'small' ? node.gap : 'medium',
            context.presentationTheme.spacing,
        )}
        direction={node.kind === 'stack' && node.direction === 'horizontal' ? 'horizontal' : 'vertical'}
        wrap
    >
        {node.kind === 'group' && context.localize(node.title) ? (
            <HappierHeading level={3} theme={context.presentationTheme}>{context.localize(node.title)}</HappierHeading>
        ) : null}
        {context.localize(node.description) ? <Text>{context.localize(node.description)}</Text> : null}
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
    },
    section: (node, context) => {
        const footer = context.localize(node.footer);
        return (
            <HappierListSection
                key={readDeclarativePath(node, context.nodePath)}
                title={context.localize(node.title)}
            >
                {renderDeclarativeChildren(node, context)}
                {footer ? <Text>{footer}</Text> : null}
            </HappierListSection>
        );
    },
    actionPanel: (node, context) => {
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
    },
    item: (node, context) => {
        const affordance = node.action === undefined ? null : context.resolveAction(node);
        const toneLabel = resolveToneAccessibilityLabel(node.tone);
        const iconToken = typeof node.icon === 'string' ? node.icon : null;
        const title = context.localize(node.title);
        const subtitle = context.localize(node.subtitle);
        const detail = context.localize(node.detail);
        const path = readDeclarativePath(node, context.nodePath);
        return (
            <HappierListItem
                key={path}
                testID={`plugin-declarative-item:${path}`}
                title={title}
                subtitle={subtitle || undefined}
                detail={detail || undefined}
                icon={iconToken ? <Icon name={resolvePluginUiIconName(iconToken, context.direction)} size={ICON_SIZE.sm} /> : undefined}
                accessibilityLabel={buildActionRowAccessibilityLabel([toneLabel, title, subtitle, detail])}
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
    },
    state: (node, context) => {
        const presentation = resolveStatePresentation(node.state);
        const description = context.localize(node.description);
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
                            ? <Spinner />
                            : <HappierSpinner color={color} animationEnabled={false} />
                        : (iconToken
                            ? <Icon name={resolvePluginUiIconName(iconToken, context.direction)} size={ICON_SIZE.lg} color={color} />
                            : undefined)}
                    title={<Text style={{ color }}>{context.localize(node.title)}</Text>}
                    description={description ? <Text>{description}</Text> : undefined}
                />
            </HappierInfoState>
        );
    },
    metadata: (node, context) => {
        const entries = Array.isArray(node.entries) ? node.entries : [];
        const title = context.localize(node.title);
        const path = readDeclarativePath(node, context.nodePath);
        return <HappierMetadata
            key={path}
            testID={`plugin-declarative-metadata:${path}`}
            title={title || undefined}
            theme={context.presentationTheme}
            entries={entries.flatMap((entryValue, index) => {
                const entry = readDeclarativeRecord(entryValue);
                if (!entry) return [];
                const label = context.localize(entry.label);
                const value = context.localize(entry.value);
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
        const text = context.localize(node.text);
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
            value={context.localize(node.text)}
            selectable
            renderContent={(input) => (
                <MarkdownView markdown={input.value} selectable={input.selectable} testID={input.testID} />
            )}
        />
    ),
    status: (node, context) => {
        const label = context.localize(node.label);
        const value = context.localize(node.value);
        // Declarative status may carry its whole meaning in `tone` while the
        // label and value stay neutral. Sighted users read that as colour, so
        // the shared owner is given the same meaning in words, exactly once.
        const toneLabel = resolveToneAccessibilityLabel(node.tone);
        const accessibilityLabel = toneLabel
            ? [toneLabel, label, value].filter((part) => part.length > 0).join(': ')
            : undefined;
        return (
            <HappierStatus
                key={readDeclarativePath(node, context.nodePath)}
                testID="plugin-declarative-status"
                label={<Text>{label}</Text>}
                value={(
                    <Text
                        testID={`plugin-declarative-status-value:${readDeclarativePath(node, context.nodePath)}`}
                        selectable
                        style={{ color: resolveDeclarativeToneColor(context.presentationTheme, node.tone) }}
                    >
                        {value}
                    </Text>
                )}
                tone={resolveDeclarativePresentationTone(node.tone)}
                theme={context.presentationTheme}
                contrast={context.contrast}
                {...(accessibilityLabel ? { accessibilityLabel } : {})}
                accessibilityLiveRegion="polite"
            />
        );
    },
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
