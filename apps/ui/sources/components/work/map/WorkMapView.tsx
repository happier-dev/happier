import * as React from 'react';
import type { GestureResponderEvent, StyleProp, TextStyle } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import {
    HappierWorkMapView,
    resolveHappierWorkTextStep,
    type HappierWorkHost,
    type HappierWorkMapNode,
    type HappierWorkMapViewProps,
    type HappierWorkTextProps,
    type HappierWorkTheme,
} from '@happier-dev/plugin-ui/presentation';

import { projectPluginUiHostPalette, projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { Text } from '@/components/ui/text/Text';
import { projectWorkColors } from '@/components/work/status/workStatusTreatment';
import { Typography } from '@/constants/Typography';
import type { Theme } from '@/theme';

/**
 * Happier core's binding of the shared Work primitives (`@happier-dev/plugin-ui/presentation`, the
 * same owners a plugin's Work-style surface draws with): the Work theme projected from the app theme,
 * core's text host, and the one Work map renderer. The map renderer, its grammar slots, geometry and
 * connectors, the Work section, row shell and summary leaf all live in the shared package; this file
 * only supplies core's theme and text owner. `WorkSection`, `WorkRowShell` and
 * `SessionAgentActivitySummary` bind through `useWorkTheme` and `WORK_HOST`.
 */

const hostWorkThemes = new WeakMap<Theme, HappierWorkTheme>();

/** Happier core's Work theme: its snapshot, page palette, Work colours and the user's density and radii. */
function projectWorkTheme(theme: Theme): HappierWorkTheme {
    const existing = hostWorkThemes.get(theme);
    if (existing) return existing;
    const projected: HappierWorkTheme = Object.freeze({
        base: projectPluginUiTheme(theme),
        palette: projectPluginUiHostPalette(theme),
        colors: projectWorkColors(theme),
        spacing: Object.freeze({ xsmall: theme.margins.xs, small: theme.margins.sm }),
        radii: Object.freeze({ control: theme.borderRadius.md, inset: theme.borderRadius.lg, card: theme.borderRadius.xl }),
    });
    hostWorkThemes.set(theme, projected);
    return projected;
}

/** The shared Work primitives' theme, from the theme the app is rendering with. */
export function useWorkTheme(): HappierWorkTheme {
    const { theme } = useUnistyles();
    return projectWorkTheme(theme);
}

const workTextStyles = new Map<string, TextStyle>();

/**
 * A Work text role in core's own family for its weight (and tabular figures where the role asks). A host
 * that must draw a shared slot with its own text (a find-aware transcript card) uses the same step.
 */
export function workTextStyle(role: HappierWorkTextProps['role'], strong?: boolean): TextStyle {
    const key = `${role}:${strong === true ? 'strong' : 'plain'}`;
    const existing = workTextStyles.get(key);
    if (existing) return existing;
    const step = resolveHappierWorkTextStep(role, strong);
    const style: TextStyle = {
        ...Typography.default(step.weight),
        ...(step.tabular ? Typography.tabular() : null),
        fontSize: step.fontSize,
        lineHeight: step.lineHeight,
        ...(step.letterSpacing === undefined ? null : { letterSpacing: step.letterSpacing }),
    };
    workTextStyles.set(key, style);
    return style;
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
