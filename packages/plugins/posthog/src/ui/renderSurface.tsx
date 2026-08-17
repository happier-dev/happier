/**
 * The PostHog Triage detail surface artifact entry.
 *
 * Triage mounts this renderer inside its own detail pane and hands it exactly one value:
 * the published `TriageDetailSurfaceInputV1` launch input. This file admits that value
 * through the published closed schema rather than casting it — a mount that hands over
 * something else is a contract break the surface reports, not one it renders around.
 *
 * What it deliberately does NOT render is the common chrome. Title, presentation state,
 * scope, attention and the linked Happier Sessions belong to the aggregate detail shell,
 * which renders and opens them for every source alike. The bounded target-stamped
 * `linkedSessions` are accepted here and never projected: a second rendering of them
 * would be a second owner of a relationship this source does not own. The provider-native
 * "Affected sessions" tab below is PostHog's own session/replay concept and is not the
 * same thing.
 *
 * PostHog-derived Triage data is not an authoritative persisted corpus. The applied
 * observation paints immediately and is replaced by the live materialization only when
 * that read returns the same exact entry; a failed live read leaves the reader with what
 * they already had rather than blanking the body.
 */

import * as React from 'react';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import {
    Badge,
    Banner,
    Button,
    Divider,
    EmptyState,
    ErrorState,
    Item,
    List,
    LoadingState,
    Metadata,
    Row,
    Screen,
    ScrollArea,
    Stack,
    Status,
    Tabs,
    Text,
    defineUiSurface,
    useExecutePluginAction,
    useSurfaceContext,
    useTabPanelActivity,
    type MetadataEntry,
} from '@happier-dev/plugin-ui';
import {
    TriageDetailSurfaceInputV1Schema,
    TriageSourceObservationV1Schema,
    type TriageDetailSurfaceInputV1,
    type TriageSourceObservationV1,
} from '@happier-dev/triage-protocol/v1';

import { POSTHOG_ACTION_IDS, POSTHOG_PLUGIN_ID } from '../posthogContracts.js';
import {
    buildPosthogDetailGetRequest,
    projectPosthogDetailSurface,
    type PosthogDetailFieldV1,
    type PosthogDetailSurfaceModelV1,
} from './detail/model.js';
import {
    usePosthogActivityController,
    type PosthogActivityControllerV1,
} from './detail/activityController.js';
import {
    usePosthogOccurrenceController,
    type PosthogOccurrenceControllerV1,
} from './detail/occurrenceController.js';
import {
    posthogAffectedSessionRows,
    posthogOccurrenceRows,
    posthogStackTrace,
} from './detail/sampledViews.js';
import type { PosthogProjectedActivityRecord } from './detail/activityProjection.js';
import {
    POSTHOG_DETAIL_TABS_V1,
    type PosthogDetailTabIdV1,
} from './detail/tabDeclarations.js';

const RELATIVE_UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = Object.freeze([
    ['year', 365 * 24 * 60 * 60 * 1000],
    ['month', 30 * 24 * 60 * 60 * 1000],
    ['day', 24 * 60 * 60 * 1000],
    ['hour', 60 * 60 * 1000],
    ['minute', 60 * 1000],
] as const);

/**
 * `relative` is relative to the reader's present, which is what a triage reader means by
 * "last seen 4 minutes ago". `nowMs` is passed in rather than read here so the value is a
 * render input and not a hidden clock read.
 */
function formatTimestamp(
    locale: string,
    atMs: number,
    format: 'relative' | 'absolute',
    nowMs: number,
): string {
    if (format === 'absolute') {
        return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' })
            .format(new Date(atMs));
    }
    const deltaMs = atMs - nowMs;
    const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    for (const [unit, unitMs] of RELATIVE_UNITS) {
        if (Math.abs(deltaMs) >= unitMs) return relative.format(Math.round(deltaMs / unitMs), unit);
    }
    return relative.format(Math.round(deltaMs / 1000), 'second');
}

function formatNumber(locale: string, value: number, format: 'compact' | 'plain'): string {
    return new Intl.NumberFormat(
        locale,
        format === 'compact' ? { notation: 'compact', maximumFractionDigits: 1 } : {},
    ).format(value);
}

function fieldValueText(
    field: PosthogDetailFieldV1,
    locale: string,
    nowMs: number,
): string | null {
    switch (field.kind) {
        case 'text':
        case 'status':
            return field.value;
        case 'number': {
            const formatted = formatNumber(locale, field.value, field.format);
            // PostHog counts users and sessions approximately, and counts occurrences
            // exactly only for what it ingested. Presenting either as a bare total would
            // state a figure the provider never promised.
            return field.approximate ? `~${formatted}` : formatted;
        }
        case 'timestamp':
            return formatTimestamp(locale, field.atMs, field.format, nowMs);
        case 'pending':
            return null;
        default:
            return null;
    }
}

/**
 * Recomputes a panel-owned derivation only while its tab is the active one.
 *
 * Every tab here declares `retain`, so a left panel keeps its subtree mounted and would
 * otherwise keep deriving rows nobody is looking at — and would publish that derivation
 * over the state a reader left behind. While the panel is inactive this returns the last
 * value it computed, which is exactly what the reader last saw.
 */
function useActiveDerivation<T>(compute: () => T, deps: React.DependencyList): T {
    const { active } = useTabPanelActivity();
    const retained = React.useRef<Readonly<{ value: T }> | null>(null);
    const next = React.useMemo(
        // A first render always computes, even when the panel mounts inactive: a retained
        // panel with nothing retained yet has nothing to show.
        () => (active || retained.current === null
            ? { value: compute() }
            : retained.current),
        // eslint-disable-next-line react-hooks/exhaustive-deps -- the caller owns its deps.
        [active, ...deps],
    );
    retained.current = next;
    return next.value;
}

type LiveEntry =
    | Readonly<{ status: 'pending' }>
    | Readonly<{ status: 'settled'; observation: TriageSourceObservationV1 }>
    | Readonly<{ status: 'failed' }>;

/**
 * Materializes the mounted entry through this source's own `get`.
 *
 * The applied observation is a bounded list projection that may already be stale, so the
 * detail body always asks the source for the current entry. It runs once per exact
 * instance/entry and is aborted with the surface: a late result cannot replace the body
 * of a detail the reader has already left.
 */
function useLiveEntry(input: TriageDetailSurfaceInputV1, signal: AbortSignal): LiveEntry {
    const action = React.useMemo(
        () => ({ pluginId: POSTHOG_PLUGIN_ID, localId: POSTHOG_ACTION_IDS.get }),
        [],
    );
    const { execute } = useExecutePluginAction(action);
    const [live, setLive] = React.useState<LiveEntry>({ status: 'pending' });
    const request = React.useMemo(() => buildPosthogDetailGetRequest(input), [input]);

    React.useEffect(() => {
        if (request.kind !== 'ready') {
            setLive({ status: 'failed' });
            return undefined;
        }
        const controller = new AbortController();
        const abort = (): void => {
            controller.abort();
        };
        signal.addEventListener('abort', abort);
        void (async () => {
            const execution = await execute(request.input, { signal: controller.signal });
            if (controller.signal.aborted) return;
            if (execution.status !== 'success') {
                setLive({ status: 'failed' });
                return;
            }
            const parsed = TriageSourceObservationV1Schema.safeParse(execution.result);
            setLive(parsed.success
                ? { status: 'settled', observation: parsed.data }
                : { status: 'failed' });
        })();
        return () => {
            signal.removeEventListener('abort', abort);
            controller.abort();
        };
    }, [execute, request, signal]);

    return live;
}

function OverviewPanel({
    model,
    locale,
    nowMs,
}: Readonly<{
    model: PosthogDetailSurfaceModelV1;
    locale: string;
    nowMs: number;
}>): React.ReactElement {
    const projected = useActiveDerivation(() => {
        const statusFields = model.body.fields.filter(
            (field): field is Extract<PosthogDetailFieldV1, { kind: 'status' }> => (
                field.kind === 'status'
            ),
        );
        const pendingFields = model.body.fields.filter((field) => field.kind === 'pending');
        const entries: readonly MetadataEntry[] = model.body.fields.flatMap((field) => {
            if (field.kind === 'pending' || field.kind === 'status') return [];
            const value = fieldValueText(field, locale, nowMs);
            return value === null ? [] : [{ label: field.label, value }];
        });
        const disclosures = model.body.fields.flatMap(
            (field) => (field.kind === 'number' && field.disclosure !== null
                ? [{ id: field.id, label: field.label, disclosure: field.disclosure }]
                : []),
        );
        return { statusFields, pendingFields, entries, disclosures };
    }, [locale, model, nowMs]);

    return (
        <ScrollArea>
            <Stack gap="large">
                {model.read.kind === 'unavailable'
                    ? (
                        <Banner
                            tone="warning"
                            title="Showing the last observation"
                            description="PostHog could not be read just now, so these facts are the ones this issue was last observed with."
                        />
                    )
                    : null}
                {model.nativeStateNow === null
                    ? null
                    : (
                        <Banner
                            tone="info"
                            title="PostHog reports a different status"
                            description={model.nativeStateNow.nativeLabel
                                ?? model.nativeStateNow.presentation}
                        />
                    )}
                {projected.statusFields.length === 0
                    ? null
                    : (
                        <Row gap="small">
                            {projected.statusFields.map((field) => (
                                <Status
                                    key={field.id}
                                    tone={field.tone}
                                    label={`${field.label}: ${field.value}`}
                                />
                            ))}
                        </Row>
                    )}
                {projected.entries.length === 0
                    ? (
                        <EmptyState
                            title="No projected facts"
                            description="This observation carried no displayable facts."
                        />
                    )
                    : <Metadata title="Facts" entries={projected.entries} />}
                {projected.disclosures.map((disclosure) => (
                    <Text key={disclosure.id} variant="caption" tone="neutral">
                        {`${disclosure.label}: ${disclosure.disclosure}`}
                    </Text>
                ))}
                {projected.pendingFields.length === 0
                    ? null
                    : (
                        <Stack gap="small">
                            <Text variant="caption" tone="neutral">
                                {'Read only in the detail plane:'}
                            </Text>
                            <Row gap="small">
                                {projected.pendingFields.map((field) => (
                                    <Badge key={field.id} value={field.label} />
                                ))}
                            </Row>
                        </Stack>
                    )}
                {model.body.projectionTruncated
                    ? (
                        <Banner
                            tone="neutral"
                            title="Some details were shortened"
                            description="Open the issue in PostHog to read the complete text."
                        />
                    )
                    : null}
                <Divider />
                <Metadata
                    title="Observation"
                    entries={[
                        {
                            label: 'Observed',
                            value: formatTimestamp(
                                locale,
                                model.body.appliedObservedAtMs,
                                'relative',
                                nowMs,
                            ),
                        },
                        ...(model.body.sourceUpdatedAtMs === null
                            ? []
                            : [{
                                label: 'PostHog last saw',
                                value: formatTimestamp(
                                    locale,
                                    model.body.sourceUpdatedAtMs,
                                    'relative',
                                    nowMs,
                                ),
                            }]),
                    ]}
                />
            </Stack>
        </ScrollArea>
    );
}

/** The one sentence every sampled view owes its reader. */
const SAMPLE_DISCLOSURE
    = 'PostHog returns a sample of this issue’s exceptions, never all of them.';

function SampleFooter({
    controller,
}: Readonly<{ controller: PosthogOccurrenceControllerV1 }>): React.ReactElement {
    return (
        <Stack gap="small">
            <Text variant="caption" tone="neutral">
                {controller.state.omittedRowCount === 0
                    ? SAMPLE_DISCLOSURE
                    : `${SAMPLE_DISCLOSURE} ${String(controller.state.omittedRowCount)} row(s) in this sample could not be read.`}
            </Text>
            {controller.state.canLoadMore
                ? (
                    <Button
                        title="Load more sampled occurrences"
                        variant="secondary"
                        busy={controller.state.pending}
                        onPress={controller.loadMore}
                    />
                )
                : null}
        </Stack>
    );
}

function OccurrencesPanel({
    controller,
    locale,
    nowMs,
}: Readonly<{
    controller: PosthogOccurrenceControllerV1;
    locale: string;
    nowMs: number;
}>): React.ReactElement {
    const rows = useActiveDerivation(
        () => posthogOccurrenceRows(controller.state.events),
        [controller.state.events],
    );

    if (controller.state.kind === 'loading') {
        return <LoadingState title="Reading sampled occurrences" />;
    }
    if (controller.state.kind === 'unavailable') {
        return (
            <ErrorState
                title="Sampled occurrences are unavailable"
                description={controller.state.failure === null
                    ? 'PostHog did not return this sample.'
                    : controller.state.failure.code}
            />
        );
    }

    return (
        <List
            accessibilityLabel="Sampled occurrences of this PostHog issue"
            items={rows}
            keyForItem={(row) => row.uuid}
            selection={{
                selectedKey: controller.state.selectedUuid,
                onSelectedKeyChange: controller.select,
            }}
            empty={(
                <EmptyState
                    title="No sampled occurrences"
                    description={SAMPLE_DISCLOSURE}
                />
            )}
            footer={<SampleFooter controller={controller} />}
            renderItem={(row) => (
                <Item
                    title={row.headline}
                    {...(row.detail === null ? {} : { subtitle: row.detail })}
                    {...(row.atMs === null
                        ? {}
                        : { detail: formatTimestamp(locale, row.atMs, 'relative', nowMs) })}
                    accessibilityRole="option"
                />
            )}
        />
    );
}

function StackTracePanel({
    controller,
}: Readonly<{ controller: PosthogOccurrenceControllerV1 }>): React.ReactElement {
    const trace = useActiveDerivation(
        () => posthogStackTrace(controller.selectedEvent),
        [controller.selectedEvent],
    );

    if (controller.state.kind === 'loading') {
        return <LoadingState title="Reading the sampled stack" />;
    }

    return (
        <List
            accessibilityLabel="Frames of the selected sampled occurrence"
            items={trace.frames}
            keyForItem={(frame) => frame.id}
            header={(
                <Stack gap="small">
                    <Text variant="caption" tone="neutral">
                        {trace.exceptionLabel
                            ?? 'Select a sampled occurrence to read its stack.'}
                    </Text>
                    <Text variant="caption" tone="neutral">
                        {`This stack belongs to one sampled occurrence, not to the latest one. ${String(trace.appFrameCount)} application frame(s), ${String(trace.otherFrameCount)} other frame(s).`}
                    </Text>
                    {trace.truncated
                        ? (
                            <Banner
                                tone="neutral"
                                title="This stack was shortened"
                                description="Open the occurrence in PostHog to read every frame."
                            />
                        )
                        : null}
                </Stack>
            )}
            empty={(
                <EmptyState
                    title="No frames in this sample"
                    description="The selected sampled occurrence carried no readable stack frames."
                />
            )}
            renderItem={(frame) => (
                <Item
                    title={frame.label}
                    {...(frame.location === null ? {} : { subtitle: frame.location })}
                    {...(frame.inApp ? { accessory: <Badge value="app" tone="info" /> } : {})}
                />
            )}
        />
    );
}

function AffectedSessionsPanel({
    controller,
    input,
}: Readonly<{
    controller: PosthogOccurrenceControllerV1;
    input: TriageDetailSurfaceInputV1;
}>): React.ReactElement {
    const rows = useActiveDerivation(
        () => posthogAffectedSessionRows(controller.state.events, {
            issueWebUrl: input.observation.locator.webUrl ?? null,
        }),
        [controller.state.events, input.observation.locator.webUrl],
    );

    if (controller.state.kind === 'loading') {
        return <LoadingState title="Deriving affected sessions" />;
    }

    return (
        <List
            accessibilityLabel="PostHog sessions this sample named"
            items={rows}
            keyForItem={(row) => row.sessionId}
            header={(
                <Text variant="caption" tone="neutral">
                    {'These are the PostHog sessions the sampled occurrences named. A session here is not a claim that a recording exists.'}
                </Text>
            )}
            empty={(
                <EmptyState
                    title="No sessions in this sample"
                    description="None of the sampled occurrences carried a PostHog session id."
                />
            )}
            renderItem={(row) => (
                <Item
                    title={row.sessionId}
                    {...(row.url === null ? {} : { subtitle: row.url })}
                    detail={`${String(row.occurrenceCount)} sampled occurrence(s)`}
                    accessory={row.replay.kind === 'candidate'
                        ? <Badge value="Replay link" tone="info" />
                        : <Badge value="No replay link" />}
                />
            )}
        />
    );
}


/**
 * Who a record says acted.
 *
 * A system entry names PostHog rather than a person, and a record whose account carried
 * no readable identity names nobody at all instead of inventing one.
 */
function activityActorLabel(row: PosthogProjectedActivityRecord): string | null {
    if (row.isSystem) return 'PostHog';
    return row.actor ?? null;
}

/** What one activity record says happened, without saying what it changed to. */
function activityHeadline(row: PosthogProjectedActivityRecord): string {
    return row.changedFields.length === 0
        ? row.activity
        : `${row.activity}: ${row.changedFields.join(', ')}`;
}

function ActivityFooter({
    controller,
}: Readonly<{ controller: PosthogActivityControllerV1 }>): React.ReactElement {
    const { state } = controller;
    const covered = state.records.length;
    return (
        <Stack gap="small">
            <Text variant="caption" tone="neutral">
                {state.totalCount === null
                    ? `${String(covered)} activity record(s) read.`
                    : `${String(covered)} of ${String(state.totalCount)} activity record(s) read.`}
            </Text>
            {state.omittedRowCount === 0
                ? null
                : (
                    <Text variant="caption" tone="neutral">
                        {`${String(state.omittedRowCount)} record(s) on the pages read could not be understood.`}
                    </Text>
                )}
            {state.canLoadMore
                ? (
                    <Button
                        title="Load more activity"
                        variant="secondary"
                        busy={state.pending}
                        onPress={controller.loadMore}
                    />
                )
                : null}
        </Stack>
    );
}

/**
 * The Activity plane.
 *
 * It is the only panel here that reads its own route, and the only one that keeps
 * nothing: the controller's lifetime is this panel's active interval, so a leave aborts
 * the page and discards the rows rather than leaving a reader looking at records nobody
 * is reading any more.
 *
 * Its three settled outcomes are deliberately distinct on screen. An issue with no
 * recorded activity says so; a read that failed says that instead, keeping whatever rows
 * were already visible; and a permission failure names itself, because this is the one
 * read in this source that needs `activity_log:read` and no stable missing-scope
 * discriminator has been characterized.
 */
function ActivityPanel({
    controller,
    locale,
    nowMs,
}: Readonly<{
    controller: PosthogActivityControllerV1;
    locale: string;
    nowMs: number;
}>): React.ReactElement {
    const { state } = controller;

    if (state.kind === 'idle' || state.kind === 'loading') {
        return <LoadingState title="Reading this issue’s activity" />;
    }
    if (state.kind === 'unavailable') {
        return (
            <ErrorState
                title="Activity is unavailable"
                description={state.failure === null
                    ? 'PostHog did not return this issue’s activity.'
                    : `${state.failure.code}. Reading activity needs the activity_log:read scope on this PostHog account.`}
            />
        );
    }

    return (
        <List
            accessibilityLabel="Recorded activity for this PostHog issue"
            items={state.records}
            keyForItem={(row) => row.id}
            {...(state.failure === null
                ? {}
                : {
                    header: (
                        <Banner
                            tone="warning"
                            title="Showing the activity read so far"
                            description={state.failure.code}
                        />
                    ),
                })}
            empty={(
                <EmptyState
                    title="No recorded activity"
                    description="PostHog has recorded no changes to this issue."
                />
            )}
            footer={<ActivityFooter controller={controller} />}
            renderItem={(row) => (
                <Item
                    title={activityHeadline(row)}
                    {...(activityActorLabel(row) === null
                        ? {}
                        : { subtitle: activityActorLabel(row) ?? '' })}
                    {...(row.atMs === undefined
                        ? {}
                        : { detail: formatTimestamp(locale, row.atMs, 'relative', nowMs) })}
                />
            )}
        />
    );
}

/**
 * The Activity panel's own mount point.
 *
 * `usePosthogActivityController` reads the enclosing panel's active interval, which only
 * exists inside a mounted panel. Keeping the hook here rather than in the detail body is
 * what makes "leaving discards it" a structural fact instead of a convention.
 */
function ActivityTab({
    input,
    locale,
    nowMs,
}: Readonly<{
    input: TriageDetailSurfaceInputV1;
    locale: string;
    nowMs: number;
}>): React.ReactElement {
    const controller = usePosthogActivityController(input);
    return <ActivityPanel controller={controller} locale={locale} nowMs={nowMs} />;
}

function PosthogDetailBody({
    input,
    signal,
}: Readonly<{ input: TriageDetailSurfaceInputV1; signal: AbortSignal }>): React.ReactElement {
    const { locale } = useSurfaceContext();
    const [tab, setTab] = React.useState<PosthogDetailTabIdV1>('overview');
    // One render-time read, passed down as data, so no child owns a hidden clock.
    const nowMs = Date.now();

    const live = useLiveEntry(input, signal);
    const controller = usePosthogOccurrenceController(input, signal);
    const model = React.useMemo(
        () => projectPosthogDetailSurface(
            input,
            live.status === 'settled' ? live.observation : null,
        ),
        [input, live],
    );

    const panels: Readonly<Record<PosthogDetailTabIdV1, React.ReactNode>> = {
        overview: <OverviewPanel model={model} locale={locale} nowMs={nowMs} />,
        occurrences: (
            <OccurrencesPanel controller={controller} locale={locale} nowMs={nowMs} />
        ),
        'stack-trace': <StackTracePanel controller={controller} />,
        'affected-sessions': <AffectedSessionsPanel controller={controller} input={input} />,
        // The Activity controller is created inside its own panel: its lifetime is the
        // panel's active interval, so hoisting it here would outlive the leave the
        // declaration promises.
        activity: <ActivityTab input={input} locale={locale} nowMs={nowMs} />,
    };

    return (
        <Screen safeArea>
            <Tabs
                value={tab}
                onValueChange={(next) => {
                    // The declarations are the only tab identities this body renders, so
                    // a value that is not one of them selects nothing rather than
                    // becoming a tab id by assertion.
                    const declared = POSTHOG_DETAIL_TABS_V1
                        .find((candidate) => candidate.id === next);
                    if (declared !== undefined) setTab(declared.id);
                }}
                ariaLabel="PostHog issue detail"
            >
                {POSTHOG_DETAIL_TABS_V1.map((declaration) => (
                    <Tabs.Item
                        key={declaration.id}
                        value={declaration.id}
                        title={declaration.title}
                        // Stated, never inherited: the shared primitive would otherwise
                        // discard a panel this source means to keep.
                        retention={declaration.retention}
                    >
                        {panels[declaration.id]}
                    </Tabs.Item>
                ))}
            </Tabs>
        </Screen>
    );
}

function PosthogDetailSurface(context: RenderContext): React.ReactElement {
    const admitted = React.useMemo(() => {
        const parsed = TriageDetailSurfaceInputV1Schema.safeParse(context.launchInput);
        return parsed.success
            ? { ok: true as const, input: parsed.data }
            : { ok: false as const };
    }, [context.launchInput]);

    if (!admitted.ok) {
        return (
            <Screen safeArea>
                <ErrorState
                    title="This issue cannot be shown"
                    description="Triage supplied a detail input this PostHog build does not accept."
                />
            </Screen>
        );
    }

    return <PosthogDetailBody input={admitted.input} signal={context.signal} />;
}

/**
 * The exact export name the build target's Module Federation identity names. Renaming it
 * breaks the native artifact contract, not just this file.
 */
export const renderSurface = defineUiSurface(PosthogDetailSurface);
