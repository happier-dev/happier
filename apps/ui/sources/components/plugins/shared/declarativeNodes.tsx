import * as React from 'react';
import { HappierPressable, happierFocusRingStyle } from '@happier-dev/plugin-ui/presentation';
import { Spinner } from '@happier-dev/plugin-ui/components';
import { renderDeclarativeNode as renderPortableDeclarativeNode, projectDeclarativeStructuredFindText as projectPortableFindText, readDeclarativeRecord, type DeclarativeNodeRenderContext as PortableContext, type DeclarativeActionAffordance, type DeclarativeRenderingHost } from '@happier-dev/plugin-ui/declarative';
import { PluginContributionIdentityV1Schema, buildQualifiedPluginContributionKey, type PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { PluginDeclarativeNodeV2Schema } from '@happier-dev/protocol/plugins/contributions/ui/v2';
import { readPluginDeclarativeDataFieldV1, readPluginDeclarativeDataRowsV1 } from '@happier-dev/protocol/plugins/contributions/ui/declarativeDataV1';
import type { PluginDeclarativeActionVariantV2, PluginDeclarativeToneV2 } from '@happier-dev/protocol';
import type { Theme } from '@/theme';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import type { MarkdownRenderingProfile } from '@/components/markdown/rendering/MarkdownRenderingProfile';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { resolvePluginUiIconName } from '@/components/plugins/surfaces/iconToken/resolvePluginUiIconToken';
import { t } from '@/text';
import { motionTokens } from '@/components/ui/motion/motionTokens';
export { readDeclarativeRecord, readDeclarativeText, createDeclarativeTextResolver, DECLARATIVE_TONE_TO_HAPPIER_TONE, DECLARATIVE_STATE_PRESENTATION, resolveDeclarativePresentationTone, resolveDeclarativeToneColor } from '@happier-dev/plugin-ui/declarative';
export type { DeclarativeTextResolver, DeclarativeFindTextBlock, DeclarativeActionAffordance } from '@happier-dev/plugin-ui/declarative';
type RecordValue = Readonly<Record<string, unknown>>;
type ThemeColors = Theme['colors'];
export type DeclarativeNodeRenderContext = Omit<PortableContext, 'host'> & Readonly<{ colors: ThemeColors; markdownProfile?: MarkdownRenderingProfile }>;
export function readDeclarativeActionSelection(nodeAction: unknown): Readonly<{
    identity: PluginContributionIdentityV1;
    qualifiedId: string;
}> | null {
    const action = readDeclarativeRecord(nodeAction);
    const identity = PluginContributionIdentityV1Schema.safeParse(action?.identity ?? action);
    if (!identity.success) return null;
    const qualifiedId = buildQualifiedPluginContributionKey(identity.data);
    return action?.qualifiedId === undefined || action.qualifiedId === qualifiedId
        ? { identity: identity.data, qualifiedId }
        : null;
}

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

function resolveVariantColors(colors: ThemeColors, variant: unknown) {
    const resolver = typeof variant === 'string'
        ? DECLARATIVE_ACTION_VARIANT_COLORS[variant as PluginDeclarativeActionVariantV2]
        : undefined;
    return (resolver ?? DECLARATIVE_ACTION_VARIANT_COLORS.secondary)(colors);
}

function renderActionAffordance(
    node: RecordValue,
    affordance: DeclarativeActionAffordance,
    context: DeclarativeNodeRenderContext,
    label: React.ReactNode,
): React.ReactElement {
    const variantColors = resolveVariantColors(context.colors, node.variant);
    return (
        <HappierPressable
            key={context.nodePath ?? 'root'}
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
                borderColor: variantColors.border,
                ...happierFocusRingStyle({ visible: state.focused, color: context.presentationTheme.colors.focus }),
                opacity: state.disabled ? 0.5 : state.pressed ? motionTokens.press.opacitySubtle : 1,
            })}
        >
            <Text
                testID={`plugin-declarative-action-label:${affordance.key}`}
                style={{ color: variantColors.label }}
            >
                {label}
            </Text>
        </HappierPressable>
    );
}


export function projectDeclarativeStructuredFindText(root: unknown) {
    return projectPortableFindText(root, (action) => readDeclarativeActionSelection(action) !== null);
}

/** App leaves bind the one portable vocabulary to current theme, text, icons, Markdown and motion. */
export function renderDeclarativeNode(node: unknown, context: DeclarativeNodeRenderContext, fallbackPath = 'root'): React.ReactNode {
    const host: DeclarativeRenderingHost = {
        Text,
        renderIcon: (token, size, color, direction) => <Icon name={resolvePluginUiIconName(token, direction)} size={size === 'small' ? ICON_SIZE.sm : ICON_SIZE.lg} color={color} />,
        renderMarkdown: (input) => <MarkdownView markdown={input.value} selectable={input.selectable} testID={input.testID} profile={context.markdownProfile} />,
        renderSpinner: () => <Spinner />,
        toneAccessibilityLabel: (tone) => {
            const resolver = typeof tone === 'string' ? DECLARATIVE_TONE_ACCESSIBILITY_LABELS[tone as PluginDeclarativeToneV2] : undefined;
            return resolver ? resolver() : null;
        },
        incompleteText: t('widgetDefinition.moreInSource'),
        readDataNode: (value) => { const result = PluginDeclarativeNodeV2Schema.safeParse(value); return result.success ? result.data : null; },
        readDataField: readPluginDeclarativeDataFieldV1,
        readDataRows: readPluginDeclarativeDataRowsV1,
        renderAction: (value, affordance, portable, label) => renderActionAffordance(value, affordance, { ...context, nodePath: portable.nodePath }, label),
    };
    return renderPortableDeclarativeNode(node, { ...context, host }, fallbackPath);
}
