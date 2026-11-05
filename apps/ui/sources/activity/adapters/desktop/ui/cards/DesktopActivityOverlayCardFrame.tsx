import * as React from 'react';
import { View } from 'react-native';
import { HappierApprovalPromptChrome, type HappierApprovalPromptTextRender } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { projectWorkColors } from '@/components/work/status/workStatusTreatment';
import { Typography } from '@/constants/Typography';

import type { DesktopActivityOverlayRequestSubject } from '../../presentation/snapshot/desktopActivityOverlaySnapshotTypes';
import { createDesktopActivityOverlayInteriorSurfaceStyle } from '../DesktopActivityOverlayChrome';
import type { DesktopActivityOverlayVisualModeForTestID as DesktopActivityOverlayVisualMode } from '../shared/desktopActivityOverlaySelectors';

/**
 * One request or update on the island. An update stands directly on the island's material; a pending
 * ask (`ask`) is the shared compact approval card on a whisper tint, headed by an amber dot, so the decision reads
 * as a single object under the header that says who asks (lab `ntask` C, owner ruling 13): what it does, what it
 * acts on in mono with its line delta, a body only when it adds a fact, then its actions close beneath.
 */
export function DesktopActivityOverlayCardFrame(props: Readonly<{
    visualMode: DesktopActivityOverlayVisualMode;
    testID: string;
    /** A pending ask that waits for the person: raised well and amber dot. */
    ask?: boolean;
    eyebrow?: string | null;
    title: string;
    subject?: DesktopActivityOverlayRequestSubject | null;
    badgeText?: string | null;
    body?: string | null;
    children?: React.ReactNode;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    // The source line ("Bash", "Question") only when neither the title nor the subject already says it.
    const eyebrow = !props.subject && props.eyebrow?.trim()
        && !props.title.trim().toLowerCase().startsWith(props.eyebrow.trim().toLowerCase())
        ? props.eyebrow.trim()
        : null;
    const subject = props.subject ?? null;
    const facts = (
        <>
            {subject ? (
                <Text testID={`${props.testID}-subject`} variant="meta" numberOfLines={1} style={styles.subject}>
                    {subject.text}
                    {subject.additions !== null ? <Text variant="meta" style={styles.added}>{` +${subject.additions}`}</Text> : null}
                    {subject.deletions !== null ? <Text variant="meta" style={styles.subject}>{` −${subject.deletions}`}</Text> : null}
                </Text>
            ) : null}
            {props.body ? (
                <Text variant="meta" numberOfLines={3} style={styles.body}>
                    {props.body}
                </Text>
            ) : null}
        </>
    );
    const badge = props.badgeText ? (
        <View
            style={[
                styles.badge,
                createDesktopActivityOverlayInteriorSurfaceStyle(theme, {
                    visualMode: props.visualMode,
                    kind: 'badge',
                }),
            ]}
        >
            <Text variant="micro" emphasis="semiBold" style={styles.badgeText}>
                {props.badgeText}
            </Text>
        </View>
    ) : null;

    if (props.ask) {
        return (
            <HappierApprovalPromptChrome
                testID={props.testID}
                chrome="compact"
                tone="attention"
                eyebrow={eyebrow}
                title={props.title}
                titleNumberOfLines={2}
                icon={<View testID={`${props.testID}-attention`} style={styles.dot} />}
                headerAccessory={badge}
                cardRadius={theme.borderRadius.lg}
                spacing={ASK_SPACING}
                typography={null}
                renderText={renderAskText}
                surfaceStyle={createDesktopActivityOverlayInteriorSurfaceStyle(theme, { visualMode: props.visualMode, kind: 'ask' })}
                colors={{
                    border: theme.colors.border.default,
                    surface: theme.colors.surface.elevated,
                    title: theme.colors.text.primary,
                    subtitle: theme.colors.text.secondary,
                    status: projectWorkColors(theme),
                }}
                footer={props.children}
            >
                {subject || props.body ? facts : null}
            </HappierApprovalPromptChrome>
        );
    }

    return (
        <View testID={props.testID} style={styles.container}>
            <View style={styles.header}>
                <View style={styles.titleWrap}>
                    {eyebrow ? (
                        <Text variant="meta" numberOfLines={1} style={styles.eyebrow}>
                            {eyebrow}
                        </Text>
                    ) : null}
                    <Text variant="body" emphasis="semiBold" numberOfLines={2} style={styles.title}>
                        {props.title}
                    </Text>
                </View>
                {badge}
            </View>
            {facts}
            {props.children}
        </View>
    );
}

/** The island's inset (lab `ntask` C): 10 px beside the ask's parts, 8 px above and below them. */
const ASK_SPACING = { small: 8, medium: 10 } as const;

/** The notch's own text steps; the shared card owns where they sit. */
const renderAskText: HappierApprovalPromptTextRender = (input) => input.role === 'title'
    ? <Text variant="body" numberOfLines={input.numberOfLines} style={styles.title}>{input.text}</Text>
    : <Text variant="meta" numberOfLines={input.numberOfLines} style={styles.eyebrow}>{input.text}</Text>;

const styles = StyleSheet.create((theme) => ({
    container: {
        gap: theme.space.s8,
        paddingHorizontal: theme.space.s4,
        paddingVertical: theme.space.s4,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    // The lab's 6 px attention mark.
    dot: {
        width: theme.space.s6,
        height: theme.space.s6,
        borderRadius: theme.space.s6 / 2,
        backgroundColor: theme.colors.state.attention.foreground,
        flexShrink: 0,
    },
    titleWrap: {
        flex: 1,
        minWidth: 0,
        gap: theme.space.s2,
    },
    eyebrow: {
        color: theme.colors.text.secondary,
    },
    title: {
        color: theme.colors.text.primary,
    },
    subject: {
        ...Typography.mono(),
        color: theme.colors.text.secondary,
    },
    added: {
        ...Typography.mono(),
        color: theme.colors.state.success.textForeground,
    },
    body: {
        color: theme.colors.text.secondary,
    },
    badge: {
        minWidth: theme.space.s20,
        paddingHorizontal: theme.space.s6,
        alignItems: 'center',
        justifyContent: 'center',
    },
    badgeText: {
        color: theme.colors.text.secondary,
        fontVariant: ['tabular-nums'],
    },
}));
