import * as React from 'react';
import type { GestureResponderEvent, StyleProp, TextStyle, ViewStyle } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import {
    HappierWorkMapView,
    type HappierWorkHost,
    type HappierWorkMapNode,
    type HappierWorkMapViewProps,
    type HappierWorkTextProps,
    type HappierWorkTheme,
    type HappierWorkUpdateCardSurface,
} from '@happier-dev/plugin-ui/presentation';

import { projectPluginUiHostPalette, projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { SurfaceCard } from '@/components/ui/cards/SurfaceCard';
import { Text } from '@/components/ui/text/Text';
import { projectWorkColors } from '@/components/work/status/workStatusTreatment';
import { workTextStyle } from '@/components/work/workTextStyle';
import type { Theme } from '@/theme';

/**
 * Happier core's binding of the shared Work primitives (`@happier-dev/plugin-ui/presentation`, the
 * same owners a plugin's Work-style surface draws with): the Work theme projected from the app theme,
 * core's text host, and the one Work map renderer. The map renderer, its grammar slots, geometry and
 * connectors, the Work section, row shell and summary leaf all live in the shared package; this file
 * only supplies core's theme and text owner. `WorkSection`, `WorkRowShell` and
 * `SessionAgentActivitySummary` bind through `useWorkTheme` and `WORK_HOST`.
 */

/** Happier core's Work theme: its snapshot, page palette, Work colours and the user's density and radii. */
function projectWorkTheme(theme: Theme): HappierWorkTheme {
    return Object.freeze({
        base: projectPluginUiTheme(theme),
        palette: projectPluginUiHostPalette(theme),
        colors: projectWorkColors(theme),
        spacing: Object.freeze({ xsmall: theme.space.s4, small: theme.space.s8 }),
        radii: Object.freeze({ control: theme.borderRadius.md, inset: theme.borderRadius.lg, card: theme.borderRadius.xl }),
    });
}

/** The shared Work primitives' theme, from the theme the app is rendering with. */
export function useWorkTheme(): HappierWorkTheme {
    const { theme } = useUnistyles();
    // Like usePluginUiTheme, depend on resolved fields: Unistyles replaces the outer Proxy each render.
    return React.useMemo(() => projectWorkTheme(theme), [
        theme.colors, theme.dark, theme.space, theme.borderRadius, theme.finish, theme.parts, theme.typography,
    ]);
}

/** The shared primitives pass colour and layout only; core's text owner keeps the user's font scale. */
function WorkText(props: HappierWorkTextProps) {
    return (
        <Text
            style={[workTextStyle(props.role, props.strong), props.style as StyleProp<TextStyle>]}
            {...(props.numberOfLines === undefined ? {} : { numberOfLines: props.numberOfLines })}
            {...(props.accessibilityRole === undefined ? {} : { accessibilityRole: props.accessibilityRole })}
            {...(props.testID === undefined ? {} : { testID: props.testID })}
        >
            {props.children}
        </Text>
    );
}

/** Core's host primitives for the shared Work primitives: the app's own text owner. */
export const WORK_HOST: HappierWorkHost = Object.freeze({ Text: WorkText });

/** Every Work update card stands on core's inset card material; the frame hands it the tone's ring and tint. */
export function renderWorkUpdateCardSurface(surface: HappierWorkUpdateCardSurface) {
    return (
        <SurfaceCard testID={surface.testID} tone="muted" padding="none" style={surface.toneStyle as StyleProp<ViewStyle>}>
            {surface.children}
        </SurfaceCard>
    );
}

export type WorkMapViewProps<TNode extends HappierWorkMapNode> = Omit<
    HappierWorkMapViewProps<TNode>,
    'theme' | 'host' | 'onOpen'
> & Readonly<{
    /** Opening forwards the node; the press event lets callers restore focus. */
    onOpen?: (node: TNode, event: GestureResponderEvent) => void;
}>;

/** The one Work map renderer (`HappierWorkMapView`) in core's theme and text. */
export function WorkMapView<TNode extends HappierWorkMapNode>(props: WorkMapViewProps<TNode>): React.ReactElement {
    const theme = useWorkTheme();
    const { onOpen, ...mapProps } = props;
    // The shared renderer forwards React Native's own press event; its portable type only narrows
    // what a plugin author may read.
    const handleOpen = React.useMemo<HappierWorkMapViewProps<TNode>['onOpen']>(
        () => (onOpen ? (node, event) => onOpen(node, event as GestureResponderEvent) : undefined),
        [onOpen],
    );
    return <HappierWorkMapView<TNode> {...mapProps} onOpen={handleOpen} theme={theme} host={WORK_HOST} />;
}
