import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierDisclosureTurn, type HappierDisclosureCaretDensity } from '@happier-dev/plugin-ui/presentation';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

import { ITEM_CHEVRON_SIZE } from './itemDensityMetrics';

/** The caret's two density steps: `row` ends a row at the row chevron's size, `compact` sits beside a meta label. */
const DISCLOSURE_CARET_SIZE: Readonly<Record<HappierDisclosureCaretDensity, number>> = {
    row: ITEM_CHEVRON_SIZE.comfortable,
    compact: ICON_SIZE.xxs,
};

/**
 * The one disclosure caret of Happier core: the app's own right caret (the user's icon family, the row chevron's
 * ink) bound to the shared disclosure turn, so it points at the row while closed and turns down toward the body
 * while open. `Item` draws it for any header whose `accessibilityState.expanded` is set (spread the disclosure's
 * `headerProps`); a header that is not an `Item` renders it directly. `density` picks one of the two shared steps
 * (the plugin host binding and the in-place "Details" / "Review output" toggle use them). Decorative: the header's
 * pressable owns the expanded state and the label.
 */
export const DisclosureCaret = React.memo(function DisclosureCaret(props: Readonly<{
    expanded: boolean;
    density?: HappierDisclosureCaretDensity;
    size?: number;
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    const reducedMotion = useReducedMotionPreference();
    return (
        <HappierDisclosureTurn expanded={props.expanded} reducedMotion={reducedMotion} testID={props.testID}>
            <Icon name="caret-right" size={props.size ?? (props.density ? DISCLOSURE_CARET_SIZE[props.density] : ICON_SIZE.sm)} color={theme.colors.text.secondary} />
        </HappierDisclosureTurn>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    /** The in-place disclosure's label: quiet by size and placement, not by contrast. */
    label: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    /** Disclosed machine text (a reason code, a failed start's output): the meta step in the mono face. */
    code: {
        ...Typography.variant('meta'),
        ...Typography.mono(),
        color: theme.colors.text.secondary,
    },
    centered: {
        textAlign: 'center',
    },
}));

/** Core's binding of the one in-place disclosure ("Details", "Review output"): its caret, quiet label and focus ink. */
export type CoreDisclosureToggleBinding = Readonly<{
    renderCaret: (open: boolean) => React.ReactElement;
    renderLabel: (label: React.ReactNode) => React.ReactElement;
    focusColor: string;
}>;

const renderCaret = (open: boolean) => <DisclosureCaret expanded={open} density="compact" />;
const renderLabel = (label: React.ReactNode) => <Text accessible={false} style={stylesheet.label}>{label}</Text>;

/**
 * One binding for every core consumer of the shared disclosure toggle (`HappierDisclosureToggle`, the state card's
 * Details), so its caret, label and focus never drift between them. It adds no behaviour of its own.
 */
export function useCoreDisclosureToggleBinding(): CoreDisclosureToggleBinding {
    const { theme } = useUnistyles();
    const focusColor = theme.colors.border.focus;
    return React.useMemo(() => ({ renderCaret, renderLabel, focusColor }), [focusColor]);
}

/** The one text role for what a disclosure reveals of machine text: a reason code or a failed start's output. */
export function DisclosedCodeText(props: Readonly<{ children: React.ReactNode; align?: 'center'; testID?: string }>) {
    return <Text testID={props.testID} selectable style={[stylesheet.code, props.align === 'center' ? stylesheet.centered : null]}>{props.children}</Text>;
}
