import {
    HappierDragGrip,
    HappierDragGripTrigger,
    type HappierDragGripTriggerProps,
    HappierReleaseOutcomePill,
    HappierReleasePreviewCard,
    HappierStagedMoveDock,
    type HappierReleaseGlyph,
    type HappierReleaseOutcome,
    type HappierReleasePreviewColors,
    type HappierReleasePreviewHost,
    type HappierReleasePreviewIdentity,
    type HappierStagedMoveHint,
    resolveHappierStagedMoveHints,
} from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { I18nManager, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';
import { renderPanelMaterialSurface } from '@/components/ui/glass/GlassSurface';
import { resolveThemeSurfaceFinish } from '@/components/ui/surfaces/themeRaisedEdge';

/**
 * Happier core's binding of the ONE release preview, grip and staged-move dock
 * (`@happier-dev/plugin-ui/presentation`, the same owners a plugin target draws through). It supplies
 * only what the runtime owns: app Text (font scale), the icon pack, theme colours and the
 * reduced-motion preference and the canonical app spinner. What the preview says comes from the drag owner's admission.
 */

const GLYPH_ICONS: Readonly<Record<HappierReleaseGlyph, IconName>> = {
    nest: 'arrow-elbow-down-right',
    above: 'arrow-up',
    below: 'arrow-down',
    folder: 'folder',
    topLevel: 'arrow-elbow-up-left',
    open: 'arrow-square-out',
    tab: 'browsers',
    goTo: 'arrow-right',
    split: 'square-split-horizontal',
    splitVertical: 'square-split-vertical',
    here: 'check',
    copy: 'copy',
    attach: 'paperclip',
    upload: 'upload',
    add: 'plus',
    move: 'arrows-out-cardinal',
    board: 'squares-four',
    refused: 'octagon-x',
};

function CorePreviewText(props: React.ComponentProps<HappierReleasePreviewHost['Text']>): React.ReactElement {
    return (
        <Text style={props.style as React.ComponentProps<typeof Text>['style']} numberOfLines={props.numberOfLines} testID={props.testID}>
            {props.children}
        </Text>
    );
}

const CORE_RELEASE_PREVIEW_HOST: HappierReleasePreviewHost = {
    Text: CorePreviewText,
    renderGlyph: (glyph, color, size) => <Icon name={GLYPH_ICONS[glyph]} size={size} color={color} />,
    renderPendingSpinner: (size, color) => <ActivitySpinner size={size} color={color} />,
};

export function useEntityReleasePreviewColors(): HappierReleasePreviewColors {
    const { theme } = useUnistyles();
    const colors = theme.colors;
    return React.useMemo(() => ({
        surface: colors.surface.base,
        border: colors.border.modal,
        divider: colors.border.subtle,
        text: colors.text.primary,
        textSecondary: colors.text.secondary,
        accent: colors.state.active.foreground,
        allowedFill: colors.state.active.background,
        refusedFill: colors.surface.inset,
        keycapFill: colors.surface.elevated,
        shadow: colors.shadowLevels[5].shadowColor,
    }), [colors]);
}

export function EntityReleasePreviewCard(props: Readonly<{
    identity: HappierReleasePreviewIdentity;
    outcome: HappierReleaseOutcome | null;
    density?: 'pointer' | 'touch';
    side?: 'right' | 'left';
    testID?: string;
}>): React.ReactElement {
    const colors = useEntityReleasePreviewColors();
    const reducedMotion = useReducedMotionPreference();
    const { theme } = useUnistyles();
    return (
        <HappierReleasePreviewCard
            {...props}
            colors={colors}
            host={CORE_RELEASE_PREVIEW_HOST}
            reducedMotion={reducedMotion}
            gradient={resolveThemeSurfaceFinish(theme, 'floating')}
            renderMaterialSurface={renderPanelMaterialSurface}
        />
    );
}

export function EntityReleaseOutcomePill(props: Readonly<{ outcome: HappierReleaseOutcome; testID?: string }>): React.ReactElement {
    const colors = useEntityReleasePreviewColors();
    const reducedMotion = useReducedMotionPreference();
    const { theme } = useUnistyles();
    return <HappierReleaseOutcomePill {...props} colors={colors} host={CORE_RELEASE_PREVIEW_HOST} reducedMotion={reducedMotion} gradient={resolveThemeSurfaceFinish(theme, 'floating')} renderMaterialSurface={renderPanelMaterialSurface} />;
}

/** Where a staged-move dock sits: over its list's foot, so the list never grows when a move starts. */
export const ENTITY_STAGED_MOVE_DOCK_PLACEMENT = { position: 'absolute', left: 8, right: 8, bottom: 12 } as const;

/**
 * A host with a fixed footer (a popover) takes the staged-move dock there, so the dock never covers a row and
 * stays in view while the list scrolls; a host without one keeps the dock over its list's foot. The host renders
 * {@link StagedMoveDockFooter} in its footer and provides the slot around its list.
 */
export type StagedMoveDockSlot = (dock: React.ReactNode) => void;
export const StagedMoveDockSlotContext = React.createContext<StagedMoveDockSlot | null>(null);

export function useStagedMoveDockSlot(): Readonly<{ dock: React.ReactNode; slot: StagedMoveDockSlot }> {
    const [dock, slot] = React.useState<React.ReactNode>(null);
    return { dock, slot };
}

export function StagedMoveDockFooter(props: Readonly<{ dock: React.ReactNode }>): React.ReactElement | null {
    return props.dock ? <View pointerEvents="none" style={STAGED_MOVE_DOCK_FOOTER_STYLE}>{props.dock}</View> : null;
}

const STAGED_MOVE_DOCK_FOOTER_STYLE = { paddingHorizontal: ENTITY_STAGED_MOVE_DOCK_PLACEMENT.left, paddingTop: 8, paddingBottom: ENTITY_STAGED_MOVE_DOCK_PLACEMENT.left } as const;

export function EntityStagedMoveDock(props: Readonly<{
    outcome: HappierReleaseOutcome;
    hints: readonly HappierStagedMoveHint[];
    testID?: string;
}>): React.ReactElement {
    const colors = useEntityReleasePreviewColors();
    const reducedMotion = useReducedMotionPreference();
    const { theme } = useUnistyles();
    return <HappierStagedMoveDock {...props} colors={colors} host={CORE_RELEASE_PREVIEW_HOST} reducedMotion={reducedMotion} gradient={resolveThemeSurfaceFinish(theme, 'floating')} renderMaterialSurface={renderPanelMaterialSurface} />;
}

function useEntityDragGripColors() {
    const { theme } = useUnistyles();
    const colors = theme.colors;
    return React.useMemo(() => ({
        glyph: colors.text.tertiary,
        activeGlyph: colors.text.primary,
        activeFill: colors.surface.elevated,
        hoverFill: colors.surface.inset,
        focusRing: colors.border.focus,
    }), [colors]);
}

const renderGripGlyph = (color: string, size: number) => <Icon name="dots-six-vertical" size={size} color={color} />;

/**
 * The grip as chrome only, for a host whose gesture surface is the grip itself (a phone Organize row,
 * whose long-press menu belongs to the row). Anything pressable or focusable uses
 * {@link EntityDragGripTrigger}.
 */
export const EntityDragGrip = React.forwardRef<View, Readonly<{
    active?: boolean;
    revealed?: boolean;
    density?: 'pointer' | 'touch';
    accessibilityLabel: string;
    testID?: string;
}>>(function EntityDragGrip(props, ref) {
    const colors = useEntityDragGripColors();
    return (
        <HappierDragGrip
            ref={ref}
            {...props}
            colors={colors}
            renderGlyph={renderGripGlyph}
        />
    );
});

export type EntityDragGripKeyEvent = Readonly<{ key: string; repeat?: boolean; shiftKey?: boolean; preventDefault(): void; stopPropagation(): void }>;

/**
 * The ONE grip trigger (DnD lab K1/KS): the shared grip on the shared pressable, so every list, Board
 * and plugin surface gets the same press feedback and a keyboard-only focus ring. Press opens the
 * Move chooser; a focused grip owns the staged keyboard move through `onKeyDown`.
 */
export function EntityDragGripTrigger(props: Readonly<{
    accessibilityLabel: string;
    accessibilityHint?: string;
    onPress: () => void;
    /** Staged-move keys; returns whether it consumed the key. */
    onKeyDown?: (event: EntityDragGripKeyEvent) => boolean;
    onFocusChange?: (focused: boolean) => void;
    accessibilityActions?: HappierDragGripTriggerProps['accessibilityActions'];
    onAccessibilityAction?: HappierDragGripTriggerProps['onAccessibilityAction'];
    controlRef?: HappierDragGripTriggerProps['controlRef'];
    tabIndex?: HappierDragGripTriggerProps['tabIndex'];
    active?: boolean;
    revealed?: boolean;
    density?: 'pointer' | 'touch';
    expanded?: boolean;
    testID?: string;
}>): React.ReactElement {
    const colors = useEntityDragGripColors();
    const { onKeyDown } = props;
    return (
        <HappierDragGripTrigger
            testID={props.testID}
            accessibilityLabel={props.accessibilityLabel}
            accessibilityHint={props.accessibilityHint}
            accessibilityActions={props.accessibilityActions}
            onAccessibilityAction={props.onAccessibilityAction}
            controlRef={props.controlRef}
            tabIndex={props.tabIndex}
            expanded={props.expanded}
            onPress={props.onPress}
            onFocusChange={props.onFocusChange}
            active={props.active}
            revealed={props.revealed}
            density={props.density}
            colors={colors}
            renderGlyph={renderGripGlyph}
            onKeyDown={onKeyDown ? (key, event) => {
                const native = event as Partial<Readonly<{ repeat: boolean; shiftKey: boolean; preventDefault(): void; stopPropagation(): void; nativeEvent: Readonly<{ repeat?: boolean; shiftKey?: boolean }> }>>;
                return onKeyDown({
                    key,
                    repeat: native.repeat ?? native.nativeEvent?.repeat,
                    shiftKey: native.shiftKey ?? native.nativeEvent?.shiftKey,
                    preventDefault: () => native.preventDefault?.(),
                    stopPropagation: () => native.stopPropagation?.(),
                });
            } : undefined}
        />
    );
}

/**
 * The staged keyboard move's key hints, one convention under every list (lab KS). `nested` adds
 * the in/out keys where a list puts items under others.
 */
export function useEntityStagedMoveHints(options: Readonly<{ nested?: boolean }> = {}): readonly HappierStagedMoveHint[] {
    const nested = options.nested === true;
    return React.useMemo(() => resolveHappierStagedMoveHints({
        rtl: I18nManager.isRTL,
        labels: {
            choose: t('entityDragDrop.keyboard.choose'),
            drop: t('entityDragDrop.keyboard.drop'),
            cancel: t('entityDragDrop.keyboard.cancel'),
            escapeKey: t('entityDragDrop.keyboard.escapeKey'),
            ...(nested ? { in: t('entityDragDrop.keyboard.putUnder'), out: t('entityDragDrop.keyboard.topLevel') } : {}),
        },
    }), [nested]);
}
