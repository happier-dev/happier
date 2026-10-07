import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import { useWidgetPresentation } from '@happier-dev/plugin-ui';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { useDestinationPaneScopeId } from '@/components/appShell/workspace/DestinationInstanceHost';
import { useMachinePresenceSummary } from '@/components/sessions/model/useMachinePresenceSummary';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { createSessionScmReviewDetailsTab, type SessionScmReviewTarget } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { buildSessionScmSummary } from '@/components/sessions/sourceControl/status/statusSummary';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { SurfaceAsOfLabel } from '@/components/ui/surfaces/SurfaceAsOfLabel';
import { Text } from '@/components/ui/text/Text';
import { WidgetFrame, type WidgetFrameBody, type WidgetFrameStyle } from '@/components/widgets/frame/WidgetFrame';
import { Typography } from '@/constants/Typography';
import { useSessionProjectScmSnapshot } from '@/sync/store/hooks';
import { t } from '@/text';

import { resolveChangesGlanceFiles, type ChangesGlanceState } from './glanceModels';

const stylesheet = StyleSheet.create((theme) => ({
    branch: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4, minWidth: 0 },
    branchName: { ...Typography.default('medium'), ...happierPageTextMetrics('meta'), color: theme.colors.text.primary, flexShrink: 1 },
    quiet: { ...Typography.default(), ...happierPageTextMetrics('meta'), color: theme.colors.text.secondary },
    dot: { ...Typography.default(), ...happierPageTextMetrics('meta'), color: theme.colors.text.tertiary },
    added: { ...Typography.default(), ...Typography.tabular(), ...happierPageTextMetrics('meta'), color: theme.colors.versionControl.added.foreground },
    removed: { ...Typography.default(), ...Typography.tabular(), ...happierPageTextMetrics('meta'), color: theme.colors.versionControl.removed.foreground },
    file: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 28, minWidth: 0 },
    letter: { ...Typography.default('bold'), width: 14, textAlign: 'center', fontSize: 11, color: theme.colors.text.tertiary },
    letterAdded: { color: theme.colors.versionControl.added.foreground },
    path: { ...Typography.default(), ...happierPageTextMetrics('rowDescription'), color: theme.colors.text.primary, flex: 1, minWidth: 0 },
    directory: { color: theme.colors.text.tertiary },
    delta: { flexDirection: 'row', gap: 4, flexShrink: 0 },
    more: { ...Typography.default(), ...happierPageTextMetrics('meta'), color: theme.colors.text.tertiary, paddingTop: 2, paddingLeft: 22 },
}));

/**
 * The Changes glance (lab WC, C1): the branch, how many files changed and by how much, the first
 * few files and one way into the review. Static props only — the data-subscribing wrapper is
 * {@link ChangesGlance}, so the gallery preview and the dev specimen can render it inert.
 */
export const ChangesGlanceView = React.memo(function ChangesGlanceView(props: Readonly<{
    state: ChangesGlanceState;
    frameStyle: WidgetFrameStyle;
    presentation?: 'frame' | 'body';
    menu?: React.ReactNode;
    /** Last-known while the machine is away: the snapshot's own time ("as of 10:42"). */
    asOf?: number | null;
    onReviewChanges?: () => void;
    onWalkThrough?: () => void;
    testID: string;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const widgetPresentation = useWidgetPresentation();
    const state = props.state;
    let body: WidgetFrameBody;
    if (state.kind === 'loading') {
        body = { kind: 'loading', accessibilityLabel: t('widgetGlances.changesLoading') };
    } else if (state.kind === 'notRepo') {
        body = { kind: 'content', children: <Text style={styles.quiet}>{t('widgetGlances.notARepo')}</Text> };
    } else if (!state.summary.hasAnyChanges) {
        body = { kind: 'content', children: <Text style={styles.quiet}>{t('widgetGlances.noChanges')}</Text> };
    } else {
        const summary = state.summary;
        // A compact glance names the first change; a tall viewport can retain every file.
        // The source total and the remainder remain truthful, and Review always opens the full set.
        const files = resolveChangesGlanceFiles(summary, widgetPresentation?.footprint.height === 'compact' ? 1
            : widgetPresentation?.footprint.height === 'tall' ? summary.files.length : undefined);
        body = {
            kind: 'content',
            children: (
                <>
                    <View style={styles.branch}>
                        <Icon name="git-branch" size={ICON_SIZE.xs} color={theme.colors.text.tertiary} />
                        {summary.branch ? <Text style={styles.branchName} numberOfLines={1}>{summary.branch}</Text> : null}
                        {summary.branch ? <Text style={styles.dot}>·</Text> : null}
                        <Text style={styles.quiet}>{t('widgetGlances.changedCount', { count: summary.changedFiles })}</Text>
                        {summary.hasLineChanges ? (
                            <>
                                <Text style={styles.dot}>·</Text>
                                <Text style={styles.added}>+{summary.linesAdded}</Text>
                                <Text style={styles.removed}>−{summary.linesRemoved}</Text>
                            </>
                        ) : null}
                    </View>
                    {files.rows.map((file) => (
                        <View key={file.key} style={styles.file} testID={`${props.testID}.file`}>
                            <Text style={[styles.letter, file.added ? styles.letterAdded : null]}>{file.letter}</Text>
                            <Text style={styles.path} numberOfLines={1}>
                                {file.directory ? <Text style={styles.directory}>{file.directory}</Text> : null}
                                {file.name}
                            </Text>
                            <View style={styles.delta}>
                                {file.linesAdded > 0 ? <Text style={styles.added}>+{file.linesAdded}</Text> : null}
                                {file.linesRemoved > 0 ? <Text style={styles.removed}>−{file.linesRemoved}</Text> : null}
                            </View>
                        </View>
                    ))}
                    {files.remaining > 0 ? (
                        <Text testID={`${props.testID}.more`} style={styles.more}>
                            {t('widgetGlances.moreFiles', { count: files.remaining })}
                        </Text>
                    ) : null}
                </>
            ),
        };
    }
    const canReview = state.kind === 'ready' && state.summary.hasAnyChanges && props.onReviewChanges !== undefined;
    return (
        <WidgetFrame
            presentation={props.presentation}
            testID={props.testID}
            frameStyle={props.frameStyle}
            placement="companion"
            mark="git-branch"
            title={t('widgetGlances.changesTitle')}
            source={t('widgetGlances.changesSource')}
            meta={props.asOf ? <SurfaceAsOfLabel at={props.asOf} testID={`${props.testID}.asOf`} /> : null}
            menu={props.menu}
            body={body}
            footer={canReview ? { kind: 'open', label: t('widgetGlances.reviewChanges'), onPress: props.onReviewChanges!,
                ...(props.onWalkThrough ? { secondary: { label: t('turnChanges.card.walkThrough'), onPress: props.onWalkThrough } } : {}) } : null}
        />
    );
});

/**
 * The live Changes glance: the session's project snapshot (already kept fresh by the Session's SCM
 * owner — this glance issues no request of its own), summarized by `buildSessionScmSummary`.
 * "Review changes" opens the Review tab in Details.
 */
export function ChangesGlance(props: Readonly<{
    sessionId: string;
    serverId: string | null;
    frameStyle: WidgetFrameStyle;
    presentation?: 'frame' | 'body';
    /** Configured copies open their exact Session's existing full destination. */
    onOpenReview?: (target: SessionScmReviewTarget) => void;
    menu?: React.ReactNode;
    measurementOnly: boolean;
    testID: string;
}>) {
    const snapshot = useSessionProjectScmSnapshot(props.sessionId, props.serverId);
    const machineTarget = useSessionMachineTarget(props.sessionId, props.serverId);
    const machine = useMachinePresenceSummary(props.serverId, machineTarget?.machineId ?? null);
    const pane = useAppPaneScope(useDestinationPaneScopeId(createSessionPaneScopeId(props.sessionId, props.serverId)));
    const openDetailsTab = pane.openDetailsTab;
    const state = React.useMemo<ChangesGlanceState>(() => {
        if (!snapshot) return { kind: 'loading' };
        const summary = buildSessionScmSummary(snapshot);
        return summary ? { kind: 'ready', summary } : { kind: 'notRepo' };
    }, [snapshot]);
    const review = React.useCallback(() => {
        if (props.onOpenReview) props.onOpenReview({});
        else openDetailsTab(createSessionScmReviewDetailsTab(), { intent: 'pinned' });
    }, [openDetailsTab, props.onOpenReview]);
    const walkThrough = React.useCallback(() => {
        const target = { comparison: { kind: 'workingTree' as const }, view: 'walkthrough' as const };
        if (props.onOpenReview) props.onOpenReview(target);
        else openDetailsTab(createSessionScmReviewDetailsTab(target), { intent: 'pinned' });
    }, [openDetailsTab, props.onOpenReview]);
    const away = machine.reachability === 'unreachable';
    return (
        <ChangesGlanceView
            presentation={props.presentation}
            testID={props.testID}
            state={state}
            frameStyle={props.frameStyle}
            menu={props.menu}
            asOf={away && snapshot ? snapshot.fetchedAt : null}
            {...(props.measurementOnly ? {} : { onReviewChanges: review, onWalkThrough: walkThrough })}
        />
    );
}
