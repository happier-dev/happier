import * as React from 'react';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { formatAutomationRunStateLabel } from '@/components/automations/list/automationListFormatting';
import { SurfaceAsOfLabel } from '@/components/ui/surfaces/SurfaceAsOfLabel';
import type { HubSectionProps } from '@/components/hub/hubSectionProps';
import { HOME_WIDGET_BODY_ROWS, WidgetFrame, type WidgetFrameBody, type WidgetFrameFooter } from '@/components/widgets/frame/WidgetFrame';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { workStatusGlyphColor, workStatusWordStyle } from '@/components/work/status/workStatusTreatment';
import { WORKFLOWS_NEW_ROUTE } from '@/components/workflows/workflowsRoutes';
import { useAutomationsSupport } from '@/hooks/server/useAutomationsSupport';
import { useAutomations } from '@/sync/domains/state/storage';
import { useWorkflowRunWindow } from '@/components/workflows/library/workflowLibraryReads';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { formatShortRelativeTime } from '@/utils/time/formatShortRelativeTime';

import {
    automationRunStatusTone,
    projectLatestAutomationRuns,
    type LatestAutomationRunRow,
    type LatestAutomationRunTone,
} from './latestAutomationRuns';

const AUTOMATIONS_ROUTE = '/automations';

/**
 * Nothing has run yet: the scene, what will appear, and, before any workflow exists, the one way to make
 * the first. No size: the widget frame's state step sizes and centres it. The `/dev/home` showcase draws it too.
 */
export function latestRunsEmptyBody(onNewWorkflow?: () => void): WidgetFrameBody {
    return {
        kind: 'empty',
        scene: 'noAutomations',
        title: t('homeWidgets.latestRunsEmptyTitle'),
        reason: t('homeWidgets.latestRunsEmptyReason'),
        ...(onNewWorkflow ? { action: { label: t('workflows.newWorkflow'), onPress: onNewWorkflow } } : {}),
    };
}

export const AutomationsLatestRunsSection = React.memo(function AutomationsLatestRunsSection(props: HubSectionProps) {
    const support = useAutomationsSupport();
    if (!support.enabled) return null;
    return <AutomationsLatestRunsWidget {...props} />;
});

function AutomationsLatestRunsWidget(props: HubSectionProps) {
    const router = useRouter();
    const presented = useLayoutPresentationActive();
    const automations = useAutomations();
    const runWindow = useWorkflowRunWindow('automationLatest', { demanded: presented });
    const rows = React.useMemo(() => projectLatestAutomationRuns({
        automations,
        runs: runWindow.rows.flatMap(row => row.automation ? [row.automation] : []),
        count: HOME_WIDGET_BODY_ROWS,
    }), [automations, runWindow.rows]);

    const [definitions, setDefinitions] = React.useState<'loading' | 'loaded' | 'failed'>('loading');
    const [retryRevision, retryDefinitions] = React.useReducer((revision: number) => revision + 1, 0);
    React.useEffect(() => {
        if (!presented) return;
        let current = true;
        void (retryRevision === 0 ? sync.ensureAutomationsRead() : sync.refreshAutomations()).then(
            () => { if (current) setDefinitions('loaded'); },
            () => { if (current) setDefinitions('failed'); },
        );
        return () => { current = false; };
    }, [presented, retryRevision]);
    const refresh = () => {
        retryDefinitions();
        runWindow.retry();
    };
    const failed = definitions === 'failed' || runWindow.status === 'failed';

    const openAutomations = React.useCallback(() => {
        router.push(AUTOMATIONS_ROUTE as never);
    }, [router]);
    const openNewWorkflow = React.useCallback(() => {
        router.push(WORKFLOWS_NEW_ROUTE as never);
    }, [router]);
    const openRun = React.useCallback((row: LatestAutomationRunRow) => {
        router.push(createWorkflowRunRoute({
            kind: 'occurrence',
            automationId: row.run.automationId,
            runId: row.run.id,
        }, getActiveServerAccountScope()?.serverId) as never);
    }, [router]);

    const hasRows = rows.length > 0;
    // Before the first workflow there is nothing to open: the card's one action is making one.
    const noWorkflows = automations.length === 0 && !hasRows;
    let body: WidgetFrameBody;
    if (hasRows) {
        body = {
            kind: 'content',
            children: rows.map((row) => <LatestRunRow key={row.run.id} row={row} onOpen={openRun} />),
        };
    } else if (failed) {
        body = {
            kind: 'error',
            title: t('homeWidgets.latestRunsErrorTitle'),
            reason: t('homeWidgets.latestRunsErrorReason'),
            action: { label: t('common.retry'), onPress: refresh },
            diagnosticCode: 'home_automations_read_failed',
        };
    } else if (runWindow.knownAt === null || (definitions === 'loading' && automations.length === 0)) {
        // First load only. Automations this device already knows, or an answered read that found none,
        // answer at once; the refresh behind them (each return to Home) never puts a known answer back into a skeleton.
        body = { kind: 'loading', accessibilityLabel: t('homeWidgets.latestRunsLoading') };
    } else {
        body = latestRunsEmptyBody(noWorkflows ? openNewWorkflow : undefined);
    }
    const destination = t('navigation.automations');
    const footer: WidgetFrameFooter | null = hasRows && failed
        ? { kind: 'refreshFailed', reason: t('homeWidgets.refreshFailed'), onRetry: refresh }
        : noWorkflows ? null
        : { kind: 'open', label: t('homeWidgets.open', { destination }), onPress: openAutomations };

    return (
        <WidgetFrame
            testID="home-automations"
            frameStyle={props.frameStyle ?? 'card'}
            placement="home"
            fill
            mark="timer"
            // Title only, so it shares one header height with the cards beside it; once there are runs the
            // footer's Open Workflows names where they come from.
            title={t('homeWidgets.latestRunsTitle')}
            meta={hasRows && runWindow.knownAt !== null ? <SurfaceAsOfLabel testID="home-automations.asOf" at={runWindow.knownAt} /> : null}
            menu={props.menu}
            body={body}
            // On Home the card holds its declared room, as the widgets beside it do (owner 24(2)). Unplaced, the
            // Runs it has size it; the four-row room is held only until the first answer.
            {...(props.widgetPresentation ? { widgetPresentation: props.widgetPresentation } : {})}
            {...(hasRows ? { rows: rows.length } : {})}
            footer={footer}
        />
    );
}

const TONE_ICON: Readonly<Record<Exclude<LatestAutomationRunTone, 'active'>, IconName>> = Object.freeze({
    succeeded: 'check-circle',
    failed: 'x-circle',
    attention: 'warning-circle',
    neutral: 'minus-circle',
});

/** One run row (status glyph in its work status tone, a failed or to-look-at line in that tone, when it ran in the meta column); the `/dev/home` fixture draws it too. */
export const LatestRunRow = React.memo(function LatestRunRow(props: Readonly<{
    row: LatestAutomationRunRow;
    onOpen: (row: LatestAutomationRunRow) => void;
}>) {
    const { theme } = useUnistyles();
    const { row, onOpen } = props;
    // The shared status vocabulary: done is quiet ink, failure rose, a Run to look at the attention amber.
    const statusTone = automationRunStatusTone(row.tone);
    const toneColor = workStatusGlyphColor(theme.colors, statusTone);
    return (
        <Item
            testID={`home-automations.run.${row.run.id}`}
            title={row.automationName ?? t('common.unavailable')}
            titleLines={1}
            subtitle={formatAutomationRunStateLabel(row.run)}
            subtitleLines={1}
            // When it ran is the row's meta: the shared right-aligned tabular column.
            detail={formatShortRelativeTime(row.at)}
            {...(statusTone !== 'neutral' ? { subtitleStyle: workStatusWordStyle(statusTone) } : {})}
            icon={row.tone === 'active'
                ? <ActivitySpinner size={ICON_SIZE.sm} color={toneColor} />
                : <Icon name={TONE_ICON[row.tone]} size={ICON_SIZE.sm} color={toneColor} />}
            // A widget's rows are a compact list's rows.
            density="compact"
            showChevron={false}
            onPress={() => onOpen(row)}
        />
    );
});
