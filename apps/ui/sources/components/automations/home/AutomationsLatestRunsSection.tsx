import * as React from 'react';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { useShallow } from 'zustand/react/shallow';

import { formatAutomationRunStateLabel } from '@/components/automations/list/automationListFormatting';
import { SurfaceAsOfLabel } from '@/components/ui/surfaces/SurfaceAsOfLabel';
import type { HubSectionProps } from '@/components/hub/hubSectionProps';
import { HOME_WIDGET_BODY_ROWS, WidgetFrame, type WidgetFrameBody, type WidgetFrameFooter } from '@/components/widgets/frame/WidgetFrame';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { workStatusGlyphColor } from '@/components/work/status/workStatusTreatment';
import { useAutomationsSupport } from '@/hooks/server/useAutomationsSupport';
import type { AutomationDefinitionRun } from '@/sync/domains/automations/automationTypes';
import { storage } from '@/sync/domains/state/storageStore';
import { useAutomations } from '@/sync/domains/state/storage';
import { createAutomationRunDetailRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { resolveAutomationRunProjections } from '@/sync/store/domains/workflowRuns';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { formatShortRelativeTime } from '@/utils/time/formatShortRelativeTime';

import {
    automationRunStatusTone,
    projectLatestAutomationRuns,
    selectLatestRunAutomationIds,
    type LatestAutomationRunRow,
    type LatestAutomationRunTone,
} from './latestAutomationRuns';

const AUTOMATIONS_ROUTE = '/automations';
const NO_RUN_IDS: readonly string[] = Object.freeze([]);

type ReadState = Readonly<{
    reading: boolean;
    failed: boolean;
    /** When this section last read the Account's Automations and their newest Runs. */
    readAt: number | null;
}>;

/**
 * The first Run page of each given Automation this device has not read yet. A page already being
 * read is joined, not asked again. Pages already read stay current through the Automation sync
 * owner's own invalidation.
 */
function readMissingRunPages(ids: readonly string[], inFlight: Map<string, Promise<unknown>>): Promise<unknown> {
    const windows = storage.getState().automationRunIdsByAutomationId;
    return Promise.all(ids.filter((id) => windows[id] === undefined).map((id) => {
        const pending = inFlight.get(id);
        if (pending) return pending;
        const read = sync.fetchAutomationRuns(id).finally(() => { inFlight.delete(id); });
        inFlight.set(id, read);
        return read;
    }));
}

/**
 * **Automations · Latest runs**, a built-in widget on Home in the host widget frame: the newest Runs
 * across the Account's Automations — how each went, which Automation, when — with "As of" and one way
 * to Automations. It reads on mount only; the Automation sync owner keeps what it read current.
 */
export const AutomationsLatestRunsSection = React.memo(function AutomationsLatestRunsSection(props: HubSectionProps) {
    const support = useAutomationsSupport();
    if (!support.enabled) return null;
    return <AutomationsLatestRunsWidget menu={props.menu} />;
});

function AutomationsLatestRunsWidget(props: HubSectionProps) {
    const router = useRouter();
    const automations = useAutomations();
    const ids = React.useMemo(() => selectLatestRunAutomationIds(automations, HOME_WIDGET_BODY_ROWS), [automations]);
    const runs = storage(useShallow((state) => {
        const found: AutomationDefinitionRun[] = [];
        for (const id of ids) {
            found.push(...resolveAutomationRunProjections(state.workflowRunsById, state.automationRunIdsByAutomationId[id] ?? NO_RUN_IDS));
        }
        return found;
    }));
    const rows = React.useMemo(
        () => projectLatestAutomationRuns({ automations, runs, count: HOME_WIDGET_BODY_ROWS }),
        [automations, runs],
    );
    // A Run page the rows need and this device has not read yet.
    const awaitingRunPages = storage((state) => ids.some((id) => state.automationRunIdsByAutomationId[id] === undefined));

    const [read, setRead] = React.useState<ReadState>({ reading: true, failed: false, readAt: null });
    const mountedRef = React.useRef(true);
    React.useEffect(() => () => { mountedRef.current = false; }, []);
    const inFlightRef = React.useRef(new Map<string, Promise<unknown>>());
    const refresh = React.useCallback(async () => {
        setRead((current) => ({ ...current, reading: true }));
        try {
            // The Account's Automations, then the Run pages the newest Runs can come from.
            await sync.refreshAutomations();
            const automationsNow = Object.values(storage.getState().automations);
            await readMissingRunPages(selectLatestRunAutomationIds(automationsNow, HOME_WIDGET_BODY_ROWS), inFlightRef.current);
            if (mountedRef.current) setRead({ reading: false, failed: false, readAt: Date.now() });
        } catch {
            if (mountedRef.current) setRead((current) => ({ reading: false, failed: true, readAt: current.readAt }));
        }
    }, []);
    React.useEffect(() => {
        void refresh();
    }, [refresh]);

    // An Automation that newly counts among the latest (another one ran) has its first page read once;
    // one whose page this device already holds asks nothing.
    React.useEffect(() => {
        readMissingRunPages(ids, inFlightRef.current).catch(() => {
            if (mountedRef.current) setRead((current) => ({ ...current, failed: true }));
        });
    }, [ids]);

    const openAutomations = React.useCallback(() => {
        router.push(AUTOMATIONS_ROUTE as never);
    }, [router]);
    const openRun = React.useCallback((row: LatestAutomationRunRow) => {
        router.push(createAutomationRunDetailRoute({
            automationId: row.run.automationId,
            runId: row.run.id,
            targetType: row.targetType,
        }) as never);
    }, [router]);

    const hasRows = rows.length > 0;
    let body: WidgetFrameBody;
    if (hasRows) {
        body = {
            kind: 'content',
            children: rows.map((row) => <LatestRunRow key={row.run.id} row={row} onOpen={openRun} />),
        };
    } else if (read.failed) {
        body = {
            kind: 'error',
            title: t('homeWidgets.latestRunsErrorTitle'),
            reason: t('homeWidgets.latestRunsErrorReason'),
            action: { label: t('common.retry'), onPress: refresh },
            diagnosticCode: 'home_automations_read_failed',
        };
    } else if (awaitingRunPages || (read.reading && automations.length === 0)) {
        // First load only. Automations this device already knows answer "nothing ran yet" at once;
        // the refresh behind them never puts a known answer back into a skeleton.
        body = { kind: 'loading', accessibilityLabel: t('homeWidgets.latestRunsLoading') };
    } else {
        body = {
            kind: 'empty',
            iconName: 'timer',
            scene: 'noAutomations',
            title: t('homeWidgets.latestRunsEmptyTitle'),
            reason: t('homeWidgets.latestRunsEmptyReason'),
        };
    }
    const destination = t('navigation.automations');
    const footer: WidgetFrameFooter = hasRows && read.failed
        ? { kind: 'refreshFailed', reason: t('homeWidgets.refreshFailed'), onRetry: refresh }
        : { kind: 'open', label: t('homeWidgets.open', { destination }), onPress: openAutomations };

    return (
        <WidgetFrame
            testID="home-automations"
            frameStyle={props.frameStyle ?? 'card'}
            placement="home"
            fill
            mark="timer"
            title={t('homeWidgets.latestRunsTitle')}
            source={destination}
            meta={hasRows && read.readAt !== null ? <SurfaceAsOfLabel testID="home-automations.asOf" at={read.readAt} /> : null}
            menu={props.menu}
            body={body}
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
            title={row.automationName}
            titleLines={1}
            subtitle={formatAutomationRunStateLabel(row.run.state)}
            subtitleLines={1}
            // When it ran is the row's meta: the shared right-aligned tabular column.
            detail={formatShortRelativeTime(row.at)}
            {...(statusTone !== 'neutral' ? { subtitleStyle: { color: toneColor } } : {})}
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
