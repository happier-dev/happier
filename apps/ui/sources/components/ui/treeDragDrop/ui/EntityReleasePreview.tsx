import {
    HappierDragGrip,
    HappierReleaseOutcomePill,
    HappierReleasePreviewCard,
    HappierStagedMoveDock,
    type HappierReleaseGlyph,
    type HappierReleaseOutcome,
    type HappierReleasePreviewColors,
    type HappierReleasePreviewHost,
    type HappierReleasePreviewIdentity,
    type HappierStagedMoveHint,
} from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { Platform, type View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { Text } from '@/components/ui/text/Text';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

/**
 * Happier core's binding of the ONE release preview, grip and staged-move dock
 * (`@happier-dev/plugin-ui/presentation`, the same owners a plugin target draws through). It supplies
 * only what the runtime owns: app Text (font scale), the icon pack, theme colours and the
 * reduced-motion preference. What the preview says comes from the drag owner's admission.
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
    return (
        <HappierReleasePreviewCard
            {...props}
            colors={colors}
            host={CORE_RELEASE_PREVIEW_HOST}
            reducedMotion={reducedMotion}
        />
    );
}

export function EntityReleaseOutcomePill(props: Readonly<{ outcome: HappierReleaseOutcome; testID?: string }>): React.ReactElement {
    const colors = useEntityReleasePreviewColors();
    const reducedMotion = useReducedMotionPreference();
    return <HappierReleaseOutcomePill {...props} colors={colors} host={CORE_RELEASE_PREVIEW_HOST} reducedMotion={reducedMotion} />;
}

export function EntityStagedMoveDock(props: Readonly<{
    outcome: HappierReleaseOutcome;
    hints: readonly HappierStagedMoveHint[];
    testID?: string;
}>): React.ReactElement {
    const colors = useEntityReleasePreviewColors();
    const reducedMotion = useReducedMotionPreference();
    return <HappierStagedMoveDock {...props} colors={colors} host={CORE_RELEASE_PREVIEW_HOST} reducedMotion={reducedMotion} />;
}

export const EntityDragGrip = React.forwardRef<View, Readonly<{
    active?: boolean;
    revealed?: boolean;
    density?: 'pointer' | 'touch';
    accessibilityLabel: string;
    testID?: string;
}>>(function EntityDragGrip(props, ref) {
    const { theme } = useUnistyles();
    const colors = React.useMemo(() => ({
        glyph: theme.colors.text.tertiary,
        activeGlyph: theme.colors.text.primary,
        activeFill: theme.colors.surface.elevated,
    }), [theme.colors.surface.elevated, theme.colors.text.primary, theme.colors.text.tertiary]);
    return (
        <HappierDragGrip
            ref={ref}
            {...props}
            colors={colors}
            minimumTargetSize={resolveMinimumInteractiveTargetSize(Platform.OS)}
            renderGlyph={(color, size) => <Icon name="dots-six-vertical" size={size} color={color} />}
        />
    );
});
