import { HappierPageSheetGroup, HAPPIER_WORK_PANE_METRICS, happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { WorkSection } from '@/components/sessions/work/WorkSection';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { CollectionListGroupLabel } from '@/components/ui/lists/collection/CollectionList';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

/**
 * Dev-only specimen of the Work tab's configuration sections (unified-work lab `convo-W9` / `P9`),
 * drawn through the real section frame (`WorkSection anatomy="page"`), the shared sheet groups and
 * the group label, so the lab can be compared side by side before FIN's Triggers and U2's Roles and
 * Notes sections are mounted. The rows and copy are the lab's illustration, not product data.
 */
const styles = StyleSheet.create((theme) => ({
    root: { flex: 1, backgroundColor: theme.colors.surface.inset },
    content: { padding: theme.space.s24, gap: theme.space.s24, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start' },
    pane: {
        width: 360,
        backgroundColor: theme.colors.surface.base,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        borderRadius: 12,
        overflow: 'hidden',
    },
    paneWide: { width: 500 },
    paneBody: {
        paddingHorizontal: HAPPIER_WORK_PANE_METRICS.contentInsetPx,
        paddingTop: theme.space.s8,
        paddingBottom: theme.space.s16,
        gap: 18,
    },
    failed: { color: theme.colors.state.danger.textForeground },
    subtitleLine: { ...happierPageTextMetrics('rowDescription'), color: theme.colors.text.tertiary },
    roleName: { ...Typography.variant('label'), color: theme.colors.text.primary },
    notes: {
        ...Typography.default(),
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.text.primary,
        paddingHorizontal: HAPPIER_WORK_PANE_METRICS.rowInsetPx,
    },
    more: {
        ...Typography.variant('body', 'semiBold'),
        color: theme.colors.text.secondary,
        paddingHorizontal: HAPPIER_WORK_PANE_METRICS.rowInsetPx,
        paddingTop: theme.space.s4,
    },
    marker: {  ...Typography.variant('body'), color: theme.colors.text.tertiary },
    roleTitle: { flexDirection: 'row', alignItems: 'baseline', gap: theme.space.s8 },
}));

const noop = () => {};

type SpecimenTrigger = Readonly<{ id: string; title: string; line: string; failed?: string; off?: boolean }>;
type SpecimenEvent = Readonly<{ id: string; glyph: React.ComponentProps<typeof Icon>['name']; title: string; triggers: readonly SpecimenTrigger[] }>;

const EVENTS: readonly SpecimenEvent[] = [
    {
        id: 'turn-end',
        glyph: 'arrows-clockwise',
        title: 'When a turn ends',
        triggers: [
            { id: 'review', title: 'Review & converge', line: 'Files changed · converged 20m ago' },
            { id: 'notify', title: 'Notify me → Discord', line: 'When it needs you · sent 12m ago' },
        ],
    },
    {
        id: 'start',
        glyph: 'play',
        title: 'When the session starts',
        triggers: [{ id: 'prepare', title: 'Prepare workspace', line: 'Pull, install, start · ', failed: 'Failed 2h ago' }],
    },
    {
        id: 'comment',
        glyph: 'git-pull-request',
        title: 'On a comment on #2490',
        triggers: [{ id: 'wake', title: 'Wake this session with it', line: 'Off · not your own comments', off: true }],
    },
    {
        id: 'daily',
        glyph: 'clock',
        title: 'Every day at 09:00',
        triggers: [{ id: 'digest', title: 'Summarize overnight CI', line: 'Ran today at 09:00' }],
    },
    {
        id: 'archive',
        glyph: 'archive',
        title: 'When the session is archived',
        triggers: [{ id: 'summary', title: 'Post a summary to #2490', line: 'What changed and what is left' }],
    },
];

const ROLES: ReadonlyArray<Readonly<{ id: string; name: string; marker: string; engine: string }>> = [
    { id: 'builder', name: 'Builder', marker: 'changed', engine: 'GPT-6 Sol' },
    { id: 'reviewer', name: 'Reviewer', marker: 'changed', engine: 'Sonnet 5' },
    { id: 'research', name: 'Research', marker: 'this session', engine: 'Haiku 4.5' },
    { id: 'ui', name: 'UI work', marker: 'this session', engine: 'Opus 5.5' },
];

function SpecimenSections() {
    const { theme } = useUnistyles();
    const [on, setOn] = React.useState<Record<string, boolean>>({ wake: false });
    return (
        <>
            <WorkSection
                testID="specimen-triggers"
                anatomy="page"
                title="Triggers"
                count="5 on"
                info="Triggers run something when this session reaches an event. Saved ones live in your library."
                action={<IconButton iconName="plus" variant="plain" accessibilityLabel="Add a trigger" onPress={noop} />}
            >
                {EVENTS.map((event) => (
                    <HappierPageSheetGroup
                        key={event.id}
                        header={(
                            <CollectionListGroupLabel
                                title={event.title}
                                count={event.triggers.length > 1 ? event.triggers.length : undefined}
                                mark={<Icon name={event.glyph} size={16} color={theme.colors.text.secondary} />}
                            />
                        )}
                    >
                        {event.triggers.map((trigger) => (
                            <Item
                                key={trigger.id}
                                title={trigger.title}
                                subtitle={trigger.failed
                                    ? <Text style={styles.subtitleLine}>{trigger.line}<Text style={styles.failed}>{trigger.failed}</Text></Text>
                                    : trigger.line}
                                disabled={trigger.off}
                                onPress={noop}
                                showChevron={false}
                                rightElementOutsidePressable
                                rightElement={(
                                    <Switch
                                        value={on[trigger.id] ?? !trigger.off}
                                        onValueChange={(value) => setOn((current) => ({ ...current, [trigger.id]: value }))}
                                    />
                                )}
                            />
                        ))}
                    </HappierPageSheetGroup>
                ))}
            </WorkSection>
            <WorkSection
                testID="specimen-roles"
                anatomy="page"
                title="Roles"
                count="2 changed · 2 added"
                info="Roles apply to this session and the sessions under it."
                action={<IconButton iconName="plus" variant="plain" accessibilityLabel="Add a role" onPress={noop} />}
            >
                {ROLES.map((role) => (
                    <Item
                        key={role.id}
                        title={<View style={styles.roleTitle}><Text style={styles.roleName}>{role.name}</Text><Text style={styles.marker}>{role.marker}</Text></View>}
                        detail={role.engine}
                        onPress={noop}
                        showChevron={false}
                    />
                ))}
                <Item title="All roles" detail="9 in use" onPress={noop} />
            </WorkSection>
            <WorkSection
                testID="specimen-notes"
                anatomy="page"
                title="Notes"
                count=""
                action={<IconButton iconName="pencil-simple" variant="plain" accessibilityLabel="Edit notes" onPress={noop} />}
            >
                <Text numberOfLines={3} style={styles.notes}>
                    Use Opus 5.5 for all UI work. Run searches as background runs. Keep the ledger backfill inside the
                    API session; it needs the replica and a resume point before the review.
                </Text>
                <Text style={styles.more}>More</Text>
            </WorkSection>
        </>
    );
}

export function WorkSectionsSpecimen() {
    return (
        <ScrollView style={styles.root} contentContainerStyle={styles.content}>
            <View style={styles.pane}>
                <View style={styles.paneBody}><SpecimenSections /></View>
            </View>
            <View style={[styles.pane, styles.paneWide]}>
                <View style={styles.paneBody}><SpecimenSections /></View>
            </View>
        </ScrollView>
    );
}
