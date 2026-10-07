import { happierPageTextMetrics, HAPPIER_WORK_PANE_METRICS } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { type LayoutChangeEvent, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { readSessionRolesV1 } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';

import { settleSessionRoleWrite } from '@/components/roles/session/sessionRole';
import { WorkSection } from '@/components/sessions/work/WorkSection';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Item } from '@/components/ui/lists/Item';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useSessionMetadata } from '@/sync/domains/state/storage';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { roleActions } from '@/sync/ops/roles/roleActions';
import { t } from '@/text';

/** The notes read in three lines; "More" shows the rest in place. */
const COLLAPSED_LINES = 3;

/**
 * Work › Notes (lab `convo-W9`): the session's orchestration notes (snapshotted into workers at
 * spawn), as a flat page section of the Work pane. Plain text on the Work rows' inset, clamped to
 * three lines with More when they run longer; ✎ edits in place and saves through
 * `session.notes.set`. With no notes, one row starts them. Mounted after the Roles section.
 */
type SessionNotesSectionProps = Readonly<{
    sessionId: string;
    serverId?: string | null;
}>;

export const SessionNotesSection = React.memo(function SessionNotesSection(props: SessionNotesSectionProps) {
    return <SessionNotesContent key={sessionAddressKey({ sessionId: props.sessionId, serverId: props.serverId ?? '' })} {...props} />;
});

function SessionNotesContent(props: SessionNotesSectionProps) {
    const metadata = useSessionMetadata(props.sessionId, props.serverId);
    const notes = React.useMemo(() => readSessionRolesV1(metadata)?.notes ?? '', [metadata]);
    const [editing, setEditing] = React.useState(false);
    const [draft, setDraft] = React.useState(notes);

    const startEditing = React.useCallback(() => {
        setDraft(notes);
        setEditing(true);
    }, [notes]);
    // The editor closes only once the notes are saved; a refusal keeps the draft for retry.
    const save = async () => {
        if (draft !== notes && !await settleSessionRoleWrite(await roleActions.setSessionNotes(props.sessionId, draft, { serverId: props.serverId }))) return;
        setEditing(false);
    };

    // Unknown exact-Home content is not an empty note that can be overwritten.
    if (!metadata) return null;

    return (
        <WorkSection
            testID="session-work-notes"
            anatomy="page"
            title={t('roles.session.notesTitle')}
            count=""
            action={editing || !notes ? null : (
                <IconButton
                    testID="session-work-notes.edit"
                    iconName="pencil-simple"
                    variant="plain"
                    accessibilityLabel={t('roles.session.editNotes')}
                    tooltip={t('roles.session.editNotes')}
                    onPress={startEditing}
                />
            )}
        >
            {editing ? (
                <View style={styles.inset}>
                    <FieldTextInput
                        testID="session-work-notes.field"
                        value={draft}
                        onChangeText={setDraft}
                        accessibilityLabel={t('roles.session.notesTitle')}
                        placeholder={t('roles.session.notesPlaceholder')}
                        multiline
                        minLines={4}
                        autoFocus
                    />
                    <View style={styles.actions}>
                        <RoundButton size="small" display="secondary" title={t('common.cancel')} onPress={() => setEditing(false)} />
                        <RoundButton testID="session-work-notes.save" size="small" title={t('common.save')} onPress={() => { void save(); }} />
                    </View>
                </View>
            ) : notes ? (
                <ClampedNotes notes={notes} />
            ) : (
                <Item
                    testID="session-work-notes.add"
                    title={t('roles.session.addNotes')}
                    showChevron={false}
                    onPress={startEditing}
                />
            )}
        </WorkSection>
    );
}

/**
 * Three lines, then More. Whether the notes overflow is measured, not guessed: an invisible,
 * unclamped copy lays out at the same width, and More appears only when it is taller than the
 * clamped text (`onTextLayout` line counts are not reported on web).
 */
function ClampedNotes(props: Readonly<{ notes: string }>) {
    const [expanded, setExpanded] = React.useState(false);
    const [clampedHeight, setClampedHeight] = React.useState(0);
    const [fullHeight, setFullHeight] = React.useState(0);
    const overflows = !expanded && fullHeight > clampedHeight + 1;
    const onClampedLayout = React.useCallback((event: LayoutChangeEvent) => {
        setClampedHeight(event.nativeEvent.layout.height);
    }, []);
    const onFullLayout = React.useCallback((event: LayoutChangeEvent) => {
        setFullHeight(event.nativeEvent.layout.height);
    }, []);
    return (
        <View style={styles.inset}>
            <View>
                <Text
                    testID="session-work-notes.text"
                    style={styles.text}
                    numberOfLines={expanded ? undefined : COLLAPSED_LINES}
                    onLayout={onClampedLayout}
                >
                    {props.notes}
                </Text>
                {expanded ? null : (
                    <Text
                        testID="session-work-notes.measure"
                        style={[styles.text, styles.measure]}
                        onLayout={onFullLayout}
                        aria-hidden
                        accessibilityElementsHidden
                        importantForAccessibility="no-hide-descendants"
                    >
                        {props.notes}
                    </Text>
                )}
            </View>
            {overflows ? (
                <Text
                    testID="session-work-notes.more"
                    accessibilityRole="button"
                    style={styles.more}
                    onPress={() => setExpanded(true)}
                >
                    {t('roles.session.more')}
                </Text>
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    // Text is not an `Item`, so it takes the Work rows' text edge itself.
    inset: {
        paddingHorizontal: HAPPIER_WORK_PANE_METRICS.rowInsetPx,
        gap: 4,
    },
    text: {
        ...Typography.default(),
        ...happierPageTextMetrics('pageDescription'),
        color: theme.colors.text.primary,
    },
    measure: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        opacity: 0,
        pointerEvents: 'none',
    },
    more: {
        ...Typography.default('semiBold'),
        ...happierPageTextMetrics('meta'),
        color: theme.colors.text.secondary,
        alignSelf: 'flex-start',
    },
    actions: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: 8,
        paddingTop: 4,
    },
}));
