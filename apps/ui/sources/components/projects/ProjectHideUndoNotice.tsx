import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

import type { ProjectsListModel } from './useProjectsListModel';

/**
 * How long "Project hidden · Undo" stays (lab p-projects HIDE). A presentation lifetime only: Undo
 * stays reachable afterwards as Show in the Hidden group, and the Hide itself is already saved.
 */
const PROJECT_HIDE_UNDO_VISIBLE_MS = 5_000;

/**
 * The one line after a Hide (plan 10 §2 Auto/hide): "Project hidden" with Undo, drawn by the shared
 * line state (the same "done · Undo" anatomy as a discarded commit proposal). It leaves on its own,
 * on Undo, or when the receipt it would undo is no longer current.
 */
export const ProjectHideUndoNotice = React.memo(function ProjectHideUndoNotice(props: Readonly<{
    testID?: string;
    undo: ProjectsListModel['projectHideUndo'];
    onDismiss: () => void;
}>) {
    const { undo, onDismiss } = props;
    // The lifetime belongs to this receipt: a host passing a fresh dismiss callback each render must
    // not restart it.
    const dismissRef = React.useRef(onDismiss);
    dismissRef.current = onDismiss;
    React.useEffect(() => {
        if (!undo) return;
        const timer = setTimeout(() => dismissRef.current(), PROJECT_HIDE_UNDO_VISIBLE_MS);
        return () => clearTimeout(timer);
    }, [undo]);
    if (!undo || !undo.isCurrent()) return null;
    return (
        <View style={styles.container}>
            <SurfaceStateCard
                testID={props.testID ?? 'projects-hide-undo'}
                size="line"
                kind="success"
                title={t('projects.identity.hidden')}
                accessibilitySemantics="status"
                action={{
                    label: t('projects.identity.undoHide'),
                    onPress: () => {
                        onDismiss();
                        void undo.undo();
                    },
                }}
            />
        </View>
    );
});

const styles = StyleSheet.create(() => ({
    container: {
        paddingHorizontal: 12,
        paddingVertical: 8,
    },
}));
