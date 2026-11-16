import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { View, type StyleProp, type TextStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { UnauthenticatedStepHeading } from '@/components/onboarding/unauthShell/UnauthenticatedStep';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

/**
 * The pieces only the "Already use Happier?" panes have (lab `.hi-cxr`): a title with its lead
 * sentence and the identity row of the service or Home a pane is about. A field's label, the line
 * under it and the "or" between two ways are every signed-out form's (`StepFormParts`).
 */
/**
 * `step`: the panes stand as a step of a signed-out page (the Welcome wizard), so a pane's title is
 * that step's heading and takes the step heading's look.
 */
export const JourneyPanePresentationContext = React.createContext<'pane' | 'step'>('pane');

export function PaneHeader(props: Readonly<{ title: string; lead: string; testID?: string }>) {
    const presentation = React.useContext(JourneyPanePresentationContext);
    if (presentation === 'step') return <UnauthenticatedStepHeading title={props.title} subtitle={props.lead} testID={props.testID} />;
    return (
        <View style={styles.header} testID={props.testID}>
            <Text accessibilityRole="header" style={styles.title}>{props.title}</Text>
            <Text style={styles.lead}>{props.lead}</Text>
        </View>
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
}));
