import type {
    HappierCapsuleColors,
    HappierCapsuleHost,
    HappierSurfaceGlyph,
} from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { Animated, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { RoundButton, type RoundButtonDisplay } from '@/components/ui/buttons/RoundButton';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { GlassPanel } from '@/components/ui/glass/GlassPanel';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { ContentMorphBackdrop } from '@/components/ui/motion/ContentMorphBackdrop';
import { StepTransitionFrame } from '@/components/ui/motion/StepTransitionFrame';
import {
    resolveOverlayMotionPreset,
    useOverlayMotionAnimation,
    useOverlayPresence,
} from '@/components/ui/overlays/motion/overlayMotion';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

const GLYPH_ICON: Record<HappierSurfaceGlyph, IconName> = {
    hand: 'hand',
    warning: 'warning',
    sparkle: 'sparkle',
    pointer: 'navigation-arrow',
};

const BUTTON_DISPLAY: Record<React.ComponentProps<HappierCapsuleHost['Button']>['emphasis'], RoundButtonDisplay> = {
    primary: 'default',
    secondary: 'secondary',
    plain: 'inverted',
};

/** The step frame clips its own layers; the capsule's width is still its content's. */
const MORPH_STYLE = { width: 'auto' } as const;
/** A reshaping glass fills the frame `ContentMorphBackdrop` sizes to the content. */
const FILL_FRAME = { flex: 1 } as const;

/** A docked capsule arrives from the frame edge it stands on and settles back into it. */
const DOCK_MOTION = {
    top: resolveOverlayMotionPreset({ kind: 'popover', direction: 'bottom' }),
    bottom: resolveOverlayMotionPreset({ kind: 'popover', direction: 'top' }),
} as const;

function CapsuleSurface(props: React.ComponentProps<HappierCapsuleHost['Surface']>): React.ReactElement {
    const shadowLevel = props.elevation === 'high' ? 3 : 2;
    if (props.fill) {
        // A backing only: the glass fills the box it is placed in and its content stands over it.
        return <GlassPanel shadowLevel={shadowLevel} innerShadow={false} frameStyle={FILL_FRAME} testID={props.testID}>{null}</GlassPanel>;
    }
    if (!props.reshape) {
        return <GlassPanel shadowLevel={shadowLevel} innerShadow={false} testID={props.testID}>{props.children}</GlassPanel>;
    }
    // The glass travels to the new row's size while the row lays out at once and cross-fades.
    return (
        <ContentMorphBackdrop
            backdrop={<GlassPanel shadowLevel={shadowLevel} innerShadow={false} frameStyle={FILL_FRAME}>{null}</GlassPanel>}
        >
            <View testID={props.testID}>{props.children}</View>
        </ContentMorphBackdrop>
    );
}

function CapsuleDock(props: React.ComponentProps<NonNullable<HappierCapsuleHost['Dock']>>): React.ReactElement | null {
    const elementRef = React.useRef<React.ComponentRef<typeof View>>(null);
    const motion = useOverlayMotionAnimation({ visible: props.visible, preset: DOCK_MOTION[props.edge], elementRef });
    const { present } = useOverlayPresence(props.visible, motion.exitMs);
    if (!present) return null;
    // A leaving capsule keeps its last words while it settles out, but no longer speaks or takes presses.
    const leaving = !props.visible;
    return (
        <Animated.View
            ref={elementRef}
            style={[props.style as React.ComponentProps<typeof View>['style'], motion.style]}
            pointerEvents={leaving ? 'none' : 'box-none'}
            aria-hidden={leaving ? true : undefined}
            accessibilityElementsHidden={leaving}
            importantForAccessibility={leaving ? 'no-hide-descendants' : 'auto'}
        >
            {props.children(leaving)}
        </Animated.View>
    );
}

function CapsuleText(props: React.ComponentProps<HappierCapsuleHost['Text']>): React.ReactElement {
    const role = props.role === 'title' ? Typography.rowTitle() : props.role === 'meta' ? Typography.rowMeta() : null;
    return (
        <Text
            numberOfLines={props.numberOfLines}
            style={[role, props.color ? { color: props.color } : null, props.style as React.ComponentProps<typeof Text>['style']]}
        >
            {props.children}
        </Text>
    );
}

/**
 * Happier core's leaves for the shared floating capsules (`HappierStatusCapsule`,
 * `HappierPresenceCapsule` in `@happier-dev/plugin-ui/presentation`): the glass panel they float on,
 * the app's row type roles (font scale), the small round button, the spinner, the icon pack, the
 * canonical step transition, and the overlay motion a docked capsule arrives and leaves with. One
 * binding for every core capsule, so they cannot drift apart.
 */
export const CORE_CAPSULE_HOST: HappierCapsuleHost = {
    Surface: CapsuleSurface,
    Dock: CapsuleDock,
    Text: CapsuleText,
    Button: (props) => (
        <RoundButton
            size="small"
            display={BUTTON_DISPLAY[props.emphasis]}
            title={props.title}
            loading={props.loading}
            leading={props.leading}
            onPress={props.onPress}
            testID={props.testID}
        />
    ),
    Spinner: (props) => <ActivitySpinner size="small" color={props.color} />,
    renderGlyph: (glyph, color, size) => (
        <Icon name={GLYPH_ICON[glyph]} size={size} color={color} weight={glyph === 'pointer' ? 'fill' : undefined} />
    ),
    Morph: (props) => <StepTransitionFrame transitionKey={props.stateKey} style={MORPH_STYLE}>{props.children}</StepTransitionFrame>,
};

/** The capsules' colour roles in the app's exact tokens. */
export function useCoreCapsuleColors(): HappierCapsuleColors {
    const { theme } = useUnistyles();
    return React.useMemo(() => ({
        text: theme.colors.text.primary,
        secondaryText: theme.colors.text.secondary,
        warning: theme.colors.state.warning.foreground,
        stripBackground: theme.colors.surface.base,
        stripBorder: theme.colors.border.default,
    }), [theme]);
}
