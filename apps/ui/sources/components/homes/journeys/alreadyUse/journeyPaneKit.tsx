import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { View, type StyleProp, type TextStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

/**
 * The few pieces every "Already use Happier?" pane is made of (lab `.hi-cxr`): a title with its
 * lead sentence, a small field label, help under a control, and the identity row of the service or
 * Home a pane is about. Local to the journeys: they are this panel's anatomy, not a new primitive.
 */
export function PaneHeader(props: Readonly<{ title: string; lead: string; testID?: string }>) {
    return (
        <View style={styles.header} testID={props.testID}>
            <Text accessibilityRole="header" style={styles.title}>{props.title}</Text>
            <Text style={styles.lead}>{props.lead}</Text>
        </View>
    );
}

export function PaneLabel(props: Readonly<{ children: string; nativeID?: string }>) {
    return <Text nativeID={props.nativeID} style={styles.label}>{props.children}</Text>;
}

export function PaneHelp(props: Readonly<{ children: React.ReactNode; tone?: 'help' | 'error'; testID?: string }>) {
    return (
        <Text
            testID={props.testID}
            style={props.tone === 'error' ? styles.error : styles.help}
            accessibilityRole={props.tone === 'error' ? 'alert' : undefined}
            accessibilityLiveRegion={props.tone === 'error' ? 'polite' : undefined}
        >
            {props.children}
        </Text>
    );
}

/** A quiet inline action in the journey's identity row. */
export function PaneLink(props: Readonly<{ label: string; onPress: () => void; testID?: string; disabled?: boolean; accessibilityHint?: string }>) {
    return (
        <HappierPressable testID={props.testID} accessibilityRole="link" disabled={props.disabled} accessibilityHint={props.accessibilityHint} onPress={props.onPress}>
            <Text style={styles.link}>{props.label}</Text>
        </HappierPressable>
    );
}

/** Keep the service's identity distinct within the translated "with <service>" line. */
export function PaneServiceLabel(props: Readonly<{ service: string; style?: StyleProp<TextStyle>; numberOfLines?: number }>) {
    const label = t('homesJourneys.withService', { service: props.service });
    const at = label.indexOf(props.service);
    return (
        <Text style={props.style} numberOfLines={props.numberOfLines}>
            {label.slice(0, at)}<Text style={styles.serviceName}>{props.service}</Text>{label.slice(at + props.service.length)}
        </Text>
    );
}

/** The service or Home a pane is about: its mark, name and one fact, with at most one trailing thing. */
export function PaneIdentityRow(props: Readonly<{
    mark: React.ReactNode;
    title: string;
    subtitle: string;
    trailing?: React.ReactNode;
    testID?: string;
}>) {
    return (
        <View testID={props.testID} style={styles.identity}>
            {props.mark}
            <View style={styles.identityCopy}>
                <Text style={styles.identityTitle} numberOfLines={1}>{props.title}</Text>
                <Text style={styles.identitySubtitle} numberOfLines={1}>{props.subtitle}</Text>
            </View>
            {props.trailing ?? null}
        </View>
    );
}

/** A quiet connected-presence dot beside an identity row. */
export function PaneConfirmed(props: Readonly<{ label: string; dotOnly?: boolean }>) {
    return (
        <View style={styles.confirmed} accessibilityLabel={props.label}>
            <View style={styles.confirmedDot} />
            {props.dotOnly ? null : <Text style={styles.confirmedText}>{props.label}</Text>}
        </View>
    );
}

/** A thin rule with "or" in the middle, between two ways to do the same thing. */
export function PaneOrDivider(props: Readonly<{ label: string }>) {
    return (
        <View style={styles.or} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <View style={styles.orRule} />
            <Text style={styles.orText}>{props.label}</Text>
            <View style={styles.orRule} />
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    header: {
        gap: theme.space.s6,
    },
    title: {
        ...Typography.variant('heading'),
        color: theme.colors.text.primary,
    },
    lead: {
        ...Typography.variant('body'),
        color: theme.colors.text.secondary,
        maxWidth: 520,
    },
    label: {
        ...Typography.variant('meta', 'semiBold'),
        color: theme.colors.text.secondary,
    },
    help: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    error: {
        ...Typography.variant('meta'),
        color: theme.colors.state.danger.foreground,
    },
    link: {
        ...Typography.variant('meta', 'medium'),
        color: theme.colors.text.primary,
    },
    serviceName: { ...Typography.default('medium'), color: theme.colors.text.primary },
    identity: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s12,
        paddingVertical: theme.space.s10,
        paddingHorizontal: theme.space.s12,
        borderRadius: 12,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
    },
    identityCopy: {
        flex: 1,
        minWidth: 0,
    },
    identityTitle: {
        ...Typography.variant('body', 'semiBold'),
        color: theme.colors.text.primary,
    },
    identitySubtitle: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    confirmed: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
    },
    confirmedText: {
        ...Typography.variant('meta', 'medium'),
        color: theme.colors.text.secondary,
    },
    confirmedDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.colors.state.success.foreground },
    or: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s10,
    },
    orRule: {
        flex: 1,
        height: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.border.default,
    },
    orText: {
        ...Typography.variant('meta'),
        color: theme.colors.text.tertiary,
    },
}));
