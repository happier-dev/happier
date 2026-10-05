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
import { TriageDetailInstance, TriageDetailPanel, TriageDetailStory, TriageDetailActivity, useTriageEvidenceDisclosure } from '@happier-dev/triage-sources/ui';
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
    Stack,
    Status,
    Tabs,
    Text,
    defineUiSurface,
    useExecutePluginAction,
    usePluginTranslation,
    useSurfaceContext,
    useTabPanelActivity,
    type MetadataEntry,
    type PluginTranslate,
} from '@happier-dev/plugin-ui';
import {
    TriageDetailSurfaceInputV1Schema,
    type TriageDetailSurfaceInputV1,
    type TriageSourceFailureV1,
} from '@happier-dev/triage-protocol/v1';
// The presentation rules used below are projections of the Triage contract's own
// closed fact and failure vocabularies, so they are consumed from the one published
// owner rather than re-spelled here: six copies is how one declared `compact` number
// could start meaning two things in one list. They are aliased to this file's local
// vocabulary so the call sites read as the panel language they already are.
import {
  formatTriageTimestampV1 as formatTimestamp,
  projectTriageDetailFieldTextV1 as fieldValueText,
} from '@happier-dev/triage-protocol/v1';

import { POSTHOG_ACTION_IDS, POSTHOG_PLUGIN_ID } from '../posthogContracts.js';
import { PosthogNativeOverviewResultV1Schema } from '../source/detail/nativeOverviewContract.js';
import { createPosthogEvidenceCandidate } from '../composer/candidate.js';
import {
    projectPosthogDetailSurface,
    type PosthogDetailFieldV1,
    type PosthogDetailLiveReadV1,
    type PosthogDetailReadV1,
    type PosthogDetailSurfaceModelV1,
} from './detail/model.js';
import {
    usePosthogActivityController,
    type PosthogActivityControllerV1,
} from './detail/activityController.js';
import {
    usePosthogDetailRequest,
    usePosthogOccurrenceController,
    type PosthogOccurrenceControllerV1,
} from './detail/occurrenceController.js';
import { usePosthogCodeVariablesController } from './detail/codeVariablesController.js';
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

const LIVE_READ_REFUSED: TriageSourceFailureV1 = Object.freeze({
    class: 'unsupportedContract',
    code: 'posthog/detail-get-refused',
});

const LIVE_RESULT_UNREADABLE: TriageSourceFailureV1 = Object.freeze({
    class: 'unsupportedContract',
    code: 'posthog/detail-get-unreadable',
});

/**
 * Materializes the mounted entry through the native projection of canonical `get`.
 *
 * The applied observation is a bounded list projection that may already be stale, so the
 * detail body always asks the source for the current entry. It runs once per exact
 * instance/entry, pausing unfinished work with the root interval: a late result cannot replace the body
 * of a detail the reader has already left. A read that did not answer names itself, in
 * the same typed vocabulary the sampled panels use.
 */
function useLiveEntry(
    input: TriageDetailSurfaceInputV1,
    signal: AbortSignal,
): PosthogDetailLiveReadV1 {
    const action = React.useMemo(
        () => ({ pluginId: POSTHOG_PLUGIN_ID, localId: POSTHOG_ACTION_IDS.nativeOverview }),
        [],
    );
    const { execute } = useExecutePluginAction(action);
    const [live, setLive] = React.useState<PosthogDetailLiveReadV1>({ kind: 'pending' });
    const { overview: request } = usePosthogDetailRequest(input);
    const { active, activeSignal } = useTabPanelActivity();
    const previousRequest = React.useRef(request);
    const settledRequest = React.useRef<typeof request | null>(null);
    if (previousRequest.current !== request) {
        previousRequest.current = request;
        setLive({ kind: 'pending' });
    }

    React.useEffect(() => {
        if (!active || activeSignal.aborted || signal.aborted || settledRequest.current === request) return undefined;
        if (request.kind !== 'ready') {
            setLive({ kind: 'failed', failure: LIVE_READ_REFUSED });
            return undefined;
        }
        const controller = new AbortController();
        const abort = (): void => {
            controller.abort();
        };
        signal.addEventListener('abort', abort);
        activeSignal.addEventListener('abort', abort);
        void (async () => {
            const execution = await execute(request.input, { signal: controller.signal });
            if (controller.signal.aborted) return;
            settledRequest.current = request;
            if (execution.status !== 'success') {
                setLive({
                    kind: 'failed',
                    failure: {
                        class: execution.status === 'error' ? 'transient' : 'unknown',
                        code: execution.status === 'idle' || execution.status === 'pending'
                            ? 'posthog/detail-get-not-dispatched'
                            : execution.code,
                    },
                });
                return;
            }
            const parsed = PosthogNativeOverviewResultV1Schema.safeParse(execution.result);
            setLive(parsed.success
                ? { kind: 'settled', ...parsed.data }
                : { kind: 'failed', failure: LIVE_RESULT_UNREADABLE });
        })();
        return () => {
            signal.removeEventListener('abort', abort);
            activeSignal.removeEventListener('abort', abort);
            controller.abort();
        };
    }, [active, activeSignal, execute, request, signal]);

    return live;
}

function posthogFactLabel(field: PosthogDetailFieldV1, text: PluginTranslate): string {
    switch (field.id) {
        case 'posthog/occurrences': return text('plugins.posthog.ui.fact.occurrences', field.label);
        case 'posthog/last-seen': return text('plugins.posthog.ui.fact.last-seen', field.label);
        case 'posthog/function': return text('plugins.posthog.ui.fact.function', field.label);
        case 'posthog/top-frame': return text('plugins.posthog.ui.fact.top-frame', field.label);
        case 'posthog/release': return text('plugins.posthog.ui.fact.release', field.label);
        case 'posthog/users': return text('plugins.posthog.ui.fact.users', field.label);
        case 'posthog/sessions': return text('plugins.posthog.ui.fact.sessions', field.label);
        case 'posthog/source': return text('plugins.posthog.ui.fact.source', field.label);
        case 'posthog/library': return text('plugins.posthog.ui.fact.library', field.label);
        case 'posthog/first-seen': return text('plugins.posthog.ui.fact.first-seen', field.label);
        case 'posthog/severity': return text('plugins.posthog.ui.fact.severity', field.label);
        default: return field.label;
    }
}

/**
 * Why the facts on screen are the last observation rather than a confirmed read.
 *
 * A live read carries a typed code and names it; a refused one has no provider outcome
 * to name and states the standing sentence alone.
 */
function lastObservationDescription(
    read: Extract<PosthogDetailReadV1, { kind: 'unavailable' | 'refused' }>,
    text: PluginTranslate,
): string {
    const sentence = text(
        'plugins.posthog.ui.lastObservation.description',
        'PostHog could not be read just now, so these facts are the ones this issue was last observed with.',
    );
    return read.kind === 'unavailable' ? `${sentence} (${read.failure.code})` : sentence;
}

function OverviewPanel({
    model,
    locale,
    nowMs,
    story = false,
}: Readonly<{
    model: PosthogDetailSurfaceModelV1;
    locale: string;
    nowMs: number;
    story?: boolean;
}>): React.ReactElement {
    const text = usePluginTranslation();
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
            return value === null ? [] : [{ label: posthogFactLabel(field, text), value }];
        });
        const disclosures = model.body.fields.flatMap(
            (field) => (field.kind === 'number' && field.disclosure !== null
                ? [{ id: field.id, label: posthogFactLabel(field, text), disclosure: field.disclosure }]
                : []),
        );
        return { statusFields, pendingFields, entries, disclosures };
    }, [locale, model, nowMs]);

    return (
            <TriageDetailStory kind={story ? 'report' : undefined}>
                {/*
                    Anything but a settled live read leaves these facts unconfirmed, and
                    a body that says nothing presents them as current. `unavailable`
                    names the typed reason it carries; a refused read has none to name
                    and states the standing sentence alone.
                */}
                {model.read.kind === 'unavailable' || model.read.kind === 'refused'
                    ? (
                        <Banner
                            tone="warning"
                            title="Showing the last observation"
                            titleKey="plugins.posthog.ui.lastObservation"
                            description={lastObservationDescription(model.read, text)}
                        />
                    )
                    : null}
                {model.read.kind === 'materialized' && model.read.enrichmentFailure !== undefined
                    ? <Banner
                        tone="warning"
                        title="Query enrichment is unavailable"
                        titleKey="plugins.posthog.ui.enrichmentUnavailable"
                        description={model.read.enrichmentFailure.code}
                    />
                    : null}
                {model.nativeStateNow === null
                    ? null
                    : (
                        <Banner
                            tone="info"
                            title="PostHog reports a different status"
                            titleKey="plugins.posthog.ui.differentStatus"
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
                                    label={`${posthogFactLabel(field, text)}: ${field.value}`}
                                />
                            ))}
                        </Row>
                    )}
                {projected.entries.length === 0
                    ? (
                        <EmptyState
                            title="No projected facts"
                            titleKey="plugins.posthog.ui.noFacts"
                            description="This observation carried no displayable facts."
                            descriptionKey="plugins.posthog.ui.noFacts.description"
                        />
                    )
                    : <Metadata title="Facts" titleKey="plugins.posthog.ui.facts" entries={projected.entries} />}
                {projected.disclosures.map((disclosure) => (
                    <Text key={disclosure.id} variant="caption" tone="neutral">
                        {`${disclosure.label}: ${disclosure.disclosure}`}
                    </Text>
                ))}
                {projected.pendingFields.length === 0
                    ? null
                    : (
                        <Stack gap="small">
                            <Text
                                variant="caption"
                                tone="neutral"
                                valueKey="plugins.posthog.ui.detailOnly"
                                fallback="Read only in the detail plane:"
                            />
                            <Row gap="small">
                                {projected.pendingFields.map((field) => (
                                    <Badge key={field.id} value={posthogFactLabel(field, text)} />
                                ))}
                            </Row>
                        </Stack>
                    )}
                {model.body.projectionTruncated
                    ? (
                        <Banner
                            tone="neutral"
                            title="Some details were shortened"
                            titleKey="plugins.posthog.ui.shortened"
                            description="Open the issue in PostHog to read the complete text."
                            descriptionKey="plugins.posthog.ui.shortened.description"
                        />
                    )
                    : null}
                <Divider />
                <Metadata
                    title="Observation"
                    titleKey="plugins.posthog.ui.observation"
                    entries={[
                        {
                            label: text('plugins.posthog.ui.metadata.observed', 'Observed'),
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
                                label: text('plugins.posthog.ui.metadata.lastSaw', 'PostHog last saw'),
                                value: formatTimestamp(
                                    locale,
                                    model.body.sourceUpdatedAtMs,
                                    'relative',
                                    nowMs,
                                ),
                            }]),
                    ]}
                />
            </TriageDetailStory>
    );
}

/** The one sentence every sampled view owes its reader. */
const SAMPLE_DISCLOSURE
    = 'PostHog returns a sample of this issue’s exceptions, never all of them.';

/**
 * The one screen the three sampled consumers show when the read itself did not answer.
 *
 * Occurrences, Stack Trace and Affected Sessions read one controller, so a failed sample
 * is one fact with three readers rather than three panel-local conclusions. Without it, a
 * failure reaches a reader as "no frames" or "no sessions in this sample" — statements
 * about the issue that the read never established.
 */
function SampledUnavailable({
    failure,
}: Readonly<{ failure: TriageSourceFailureV1 | null }>): React.ReactElement {
    const text = usePluginTranslation();
    return (
        <ErrorState
            title="Sampled occurrences are unavailable"
            titleKey="plugins.posthog.ui.samplesUnavailable"
            description={failure === null
                ? text('plugins.posthog.ui.readFailed', 'PostHog could not complete this read.')
                : failure.code}
        />
    );
}

/**
 * The failure that arrived after rows were already visible.
 *
 * The shared paged rule keeps those rows, which is right — and leaves a list that has
 * silently stopped offering more. That shape is indistinguishable from an exhausted
 * sample, so the failure is stated beside the rows it did not take away.
 */
function SampledFailureNotice({
    failure,
}: Readonly<{ failure: TriageSourceFailureV1 }>): React.ReactElement {
    return (
        <Banner
            tone="warning"
            title="Showing the sample read so far"
            titleKey="plugins.posthog.ui.partialSample"
            description={failure.code}
        />
    );
}

function SampleFooter({
    controller,
}: Readonly<{ controller: PosthogOccurrenceControllerV1 }>): React.ReactElement {
    return (
        <Stack gap="small">
            <Text
                variant="caption"
                tone="neutral"
                valueKey={controller.state.omittedRowCount === 0
                    ? 'plugins.posthog.ui.sampleDisclosure'
                    : 'plugins.posthog.ui.sampleDisclosureUnreadable'}
                fallback={controller.state.omittedRowCount === 0
                    ? SAMPLE_DISCLOSURE
                    : `${SAMPLE_DISCLOSURE} {count} row(s) in this sample could not be read.`}
                values={{ count: controller.state.omittedRowCount }}
            />
            {/*
                The sample disclosure above says PostHog returns a sample, which is
                always true. This says something else: PostHog offered MORE of that
                sample and this build would not page to it. Without it the missing
                Load more reads as the end of what was offered.
            */}
            {controller.state.incomplete === null
                ? null
                : (
                    <Text
                        variant="caption"
                        tone="warning"
                        valueKey="plugins.posthog.ui.sampleStoppedShort"
                        fallback="PostHog offered more of this sample than this build could page, so it stops here."
                    />
                )}
            {controller.state.canLoadMore
                ? (
                    <Button
                        title="Load more sampled occurrences"
                        titleKey="plugins.posthog.ui.loadMoreSamples"
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
        () => posthogOccurrenceRows(controller.state.rows),
        [controller.state.rows],
    );

    if (controller.state.kind === 'loading') {
        return <LoadingState title="Reading sampled occurrences" titleKey="plugins.posthog.ui.readingSamples" />;
    }
    if (controller.state.kind === 'unavailable') {
        return <SampledUnavailable failure={controller.state.failure} />;
    }

    return (
        <List
            accessibilityLabel="Sampled occurrences of this PostHog issue"
            accessibilityLabelKey="plugins.posthog.ui.samplesLabel"
            items={rows}
            keyForItem={(row) => row.uuid}
            selection={{
                selectedKey: controller.state.selectedUuid,
                onSelectedKeyChange: controller.select,
            }}
            {...(controller.state.failure === null
                ? {}
                : { header: <SampledFailureNotice failure={controller.state.failure} /> })}
            empty={(
                <EmptyState
                    title="No sampled occurrences"
                    titleKey="plugins.posthog.ui.noSamples"
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

function SelectedEvidenceDisclosure({
    input,
    controller,
}: Readonly<{
    input: TriageDetailSurfaceInputV1;
    controller: PosthogOccurrenceControllerV1;
}>): React.ReactElement | null {
    const disclosure = useTriageEvidenceDisclosure();
    const selected = controller.selectedEvent;
    const frozenRequest = controller.selectedFrozenRequest;
    const selectedAbsoluteOffset = controller.selectedAbsoluteOffset;

    // The parent owns availability and the exact Composer transaction. A source only
    // shows this affordance when it can form one opaque, provider-owned candidate.
    if (!disclosure.available
        || selected === undefined
        || frozenRequest === undefined
        || selectedAbsoluteOffset === undefined) {
        return null;
    }

    return (
        <Button
            title="Add selected occurrence to message"
            titleKey="plugins.posthog.ui.addSelectedOccurrence"
            variant="secondary"
            onPress={() => {
                void disclosure.disclose(async (signal) => {
                    if (signal.aborted) return null;
                    return createPosthogEvidenceCandidate({
                        instance: input.instance,
                        localRef: {
                            kindId: input.observation.entryRef.kindId,
                            collisionScope: input.observation.entryRef.collisionScope,
                            entryId: input.observation.entryRef.entryId,
                        },
                        selected,
                        frozenRequest,
                        selectedAbsoluteOffset,
                    });
                });
            }}
        />
    );
}

function StackTracePanel({
    input,
    controller,
}: Readonly<{
    input: TriageDetailSurfaceInputV1;
    controller: PosthogOccurrenceControllerV1;
}>): React.ReactElement {
    const codeVariables = usePosthogCodeVariablesController(input, controller);
    const trace = useActiveDerivation(
        () => posthogStackTrace(controller.selectedEvent),
        [controller.selectedEvent],
    );

    if (controller.state.kind === 'loading') {
        return <LoadingState title="Reading the sampled stack" titleKey="plugins.posthog.ui.readingStack" />;
    }
    // The frames come from the same sample. A read that never answered has no selected
    // occurrence to have carried no frames.
    if (controller.state.kind === 'unavailable') {
        return <SampledUnavailable failure={controller.state.failure} />;
    }

    return (
        <List
            accessibilityLabel="Frames of the selected sampled occurrence"
            accessibilityLabelKey="plugins.posthog.ui.framesLabel"
            items={trace.frames}
            keyForItem={(frame) => frame.id}
            header={(
                <Stack gap="small">
                    {controller.state.failure === null
                        ? null
                        : <SampledFailureNotice failure={controller.state.failure} />}
                    {trace.exceptionLabel === null
                        ? (
                            <Text
                                variant="caption"
                                tone="neutral"
                                valueKey="plugins.posthog.ui.selectSampleForStack"
                                fallback="Select a sampled occurrence to read its stack."
                            />
                        )
                        : <Text variant="caption" tone="neutral" value={trace.exceptionLabel} />}
                    <Text
                        variant="caption"
                        tone="neutral"
                        valueKey="plugins.posthog.ui.sampleStackCounts"
                        fallback="This stack belongs to one sampled occurrence, not to the latest one. {application} application frame(s), {other} other frame(s)."
                        values={{ application: trace.appFrameCount, other: trace.otherFrameCount }}
                    />
                    <SelectedEvidenceDisclosure input={input} controller={controller} />
                    {!codeVariables.available
                        ? null
                        : codeVariables.state.kind === 'confirming'
                            ? (
                                <Stack gap="small">
                                    <Banner
                                        tone="warning"
                                        title="Reveal sensitive captured variables?"
                                        titleKey="plugins.posthog.ui.codeVariables.confirmTitle"
                                        description="Captured local variables can contain credentials, tokens, personal data, and request bodies. They stay in this Stack trace panel and are discarded when you leave it."
                                        descriptionKey="plugins.posthog.ui.codeVariables.confirmDescription"
                                    />
                                    <Row gap="small">
                                        <Button
                                            title="Reveal captured variables"
                                            titleKey="plugins.posthog.ui.codeVariables.reveal"
                                            variant="primary"
                                            onPress={codeVariables.confirm}
                                        />
                                        <Button
                                            title="Cancel"
                                            titleKey="plugins.posthog.ui.settings.cancel"
                                            variant="secondary"
                                            onPress={codeVariables.cancel}
                                        />
                                    </Row>
                                </Stack>
                            )
                            : codeVariables.state.kind === 'loading'
                                ? (
                                    <Button
                                        title="Revealing captured variables"
                                        titleKey="plugins.posthog.ui.codeVariables.loading"
                                        variant="secondary"
                                        busy
                                        onPress={() => {}}
                                    />
                                )
                                : codeVariables.state.kind === 'revealed'
                                    ? (
                                        <Stack gap="small">
                                            <Banner
                                                tone="warning"
                                                title="Captured variables"
                                                titleKey="plugins.posthog.ui.codeVariables.title"
                                                description={codeVariables.state.truncated
                                                    ? 'The provider response exceeded the Action envelope, so the visible value was shortened.'
                                                    : 'These values are visible only in this Stack trace panel and are discarded when you leave it.'}
                                                descriptionKey={codeVariables.state.truncated
                                                    ? 'plugins.posthog.ui.codeVariables.truncated'
                                                    : 'plugins.posthog.ui.codeVariables.discardNotice'}
                                            />
                                            <Text value={codeVariables.state.variablesText} />
                                        </Stack>
                                    )
                                    : codeVariables.state.kind === 'unavailable'
                                        ? (
                                            <ErrorState
                                                title="Captured variables are unavailable"
                                                titleKey="plugins.posthog.ui.codeVariables.unavailable"
                                                description={codeVariables.state.failure.code}
                                            />
                                        )
                                        : (
                                            <Button
                                                title="Reveal captured variables"
                                                titleKey="plugins.posthog.ui.codeVariables.reveal"
                                                variant="secondary"
                                                onPress={codeVariables.requestReveal}
                                            />
                                        )}
                </Stack>
            )}
            empty={(
                <EmptyState
                    title="No frames in this sample"
                    titleKey="plugins.posthog.ui.noFrames"
                    description="The selected sampled occurrence carried no readable stack frames."
                    descriptionKey="plugins.posthog.ui.noFrames.description"
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
}: Readonly<{
    controller: PosthogOccurrenceControllerV1;
}>): React.ReactElement {
    const text = usePluginTranslation();
    const { active } = useTabPanelActivity();
    const rows = React.useMemo(
        () => active ? posthogAffectedSessionRows(controller.state.rows) : [],
        [active, controller.state.rows],
    );
    // Only anonymous row geometry survives leave. Keeping the List and its row count
    // preserves its window/anchor without retaining session correlations or URLs.
    const retainedGeometry = React.useRef<readonly boolean[]>([]);
    if (active) retainedGeometry.current = rows.map((row) => row.url !== null);
    const items: ReadonlyArray<{
        key: string;
        row: (typeof rows)[number] | null;
        hasSubtitle: boolean;
    }> = active
        ? rows.map((row, index) => ({ key: String(index), row, hasSubtitle: row.url !== null }))
        : retainedGeometry.current.map((hasSubtitle, index) => ({ key: String(index), row: null, hasSubtitle }));

    if (controller.state.kind === 'loading') {
        return <LoadingState title="Deriving affected sessions" titleKey="plugins.posthog.ui.derivingSessions" />;
    }
    // These rows are derived from the sample, so an unanswered read is not a sample that
    // named no session.
    if (controller.state.kind === 'unavailable') {
        return <SampledUnavailable failure={controller.state.failure} />;
    }

    return (
        <List
            accessibilityLabel="PostHog sessions this sample named"
            accessibilityLabelKey="plugins.posthog.ui.sessionsLabel"
            items={items}
            keyForItem={(item) => item.key}
            header={(
                <Stack gap="small">
                    {controller.state.failure === null
                        ? null
                        : <SampledFailureNotice failure={controller.state.failure} />}
                    <Text
                        variant="caption"
                        tone="neutral"
                        valueKey="plugins.posthog.ui.sampledSessions.description"
                        fallback="These are the PostHog sessions the sampled occurrences named. A session here is not a claim that a recording exists."
                    />
                    {/*
                        The replay disposition is stated, not implied by the absence of a
                        control. This source has no characterized PostHog replay permalink
                        producer, so no candidate can be opened — and a row that simply
                        does nothing reads as a recording nobody bothered to link.
                        Constructing a URL, or probing for a recording to find out, is
                        exactly what this refuses to do.
                    */}
                    <Text
                        variant="caption"
                        tone="warning"
                        valueKey="plugins.posthog.ui.sampledSessions.replayUnavailable"
                        fallback="This build cannot open a PostHog session replay, and a sampled session is not a recording."
                    />
                </Stack>
            )}
            empty={(
                <EmptyState
                    title="No sessions in this sample"
                    titleKey="plugins.posthog.ui.noSessions"
                    description="None of the sampled occurrences carried a PostHog session id."
                    descriptionKey="plugins.posthog.ui.noSessions.description"
                />
            )}
            renderItem={({ row, hasSubtitle }) => (
                <Item
                    title={text('plugins.posthog.ui.sampledSession', 'Sampled session')}
                    {...(hasSubtitle ? { subtitle: row?.url ?? '\u00a0' } : {})}
                    detail={row === null ? '\u00a0' : text(
                        'plugins.posthog.ui.sampledOccurrences',
                        '{count} sampled occurrence(s)',
                        { count: row.occurrenceCount },
                    )}
                    // Every candidate carries its own outcome, so a reader scanning rows
                    // never has to infer availability from a missing affordance.
                    accessory={(
                        <Badge
                            value={text(
                                'plugins.posthog.ui.replayUnavailable',
                                'Replay unavailable',
                            )}
                        />
                    )}
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
    const covered = state.rows.length;
    return (
        <Stack gap="small">
            <Text
                variant="caption"
                tone="neutral"
                valueKey={state.totalCount === null
                    ? 'plugins.posthog.ui.activityRecordsRead'
                    : 'plugins.posthog.ui.activityRecordsReadOfTotal'}
                fallback={state.totalCount === null
                    ? '{covered} activity record(s) read.'
                    : '{covered} of {total} activity record(s) read.'}
                values={{ covered, total: state.totalCount ?? covered }}
            />
            {state.omittedRowCount === 0
                ? null
                : (
                    <Text
                        variant="caption"
                        tone="neutral"
                        valueKey="plugins.posthog.ui.recordsUnreadable"
                        fallback="{count} record(s) on the pages read could not be understood."
                        values={{ count: state.omittedRowCount }}
                    />
                )}
            {/*
                A walk that stopped short has exactly the shape of an exhausted one —
                no continuation, so no Load more — and the opposite meaning. Without
                this line the count above reads as the whole of what PostHog recorded.
            */}
            {state.incomplete === null
                ? null
                : (
                    <Text
                        variant="caption"
                        tone="warning"
                        valueKey="plugins.posthog.ui.activityStoppedShort"
                        fallback="PostHog recorded more activity than this list could read, so it stops here."
                    />
                )}
            {state.canLoadMore
                ? (
                    <Button
                        title="Load more activity"
                        titleKey="plugins.posthog.ui.loadMoreActivity"
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
    const text = usePluginTranslation();
    const { state } = controller;

    if (state.kind === 'idle' || state.kind === 'loading') {
        return <LoadingState title="Reading this issue’s activity" titleKey="plugins.posthog.ui.readingActivity" />;
    }
    if (state.kind === 'unavailable') {
        return (
            <ErrorState
                title="Activity is unavailable"
                titleKey="plugins.posthog.ui.activityUnavailable"
                description={state.failure === null
                    ? text('plugins.posthog.ui.readFailed', 'PostHog could not complete this read.')
                    : state.failure.code}
            />
        );
    }

    return (
        <List
            accessibilityLabel="Recorded activity for this PostHog issue"
            accessibilityLabelKey="plugins.posthog.ui.activityLabel"
            items={state.rows}
            keyForItem={(row) => row.id}
            {...(state.failure === null
                ? {}
                : {
                    header: (
                        <Banner
                            tone="warning"
                            title="Showing the activity read so far"
                            titleKey="plugins.posthog.ui.partialActivity"
                            description={state.failure.code}
                        />
                    ),
                })}
            empty={state.omittedRowCount === 0 && state.incomplete === null
                ? (
                    <EmptyState
                        title="No recorded activity"
                        titleKey="plugins.posthog.ui.noActivity"
                        description="PostHog has recorded no changes to this issue."
                        descriptionKey="plugins.posthog.ui.noActivity.description"
                    />
                )
                : (
                    // Rows the page consumed but could not read, or a walk that stopped
                    // before the end, are not "PostHog has recorded no changes": that
                    // sentence is a claim about the provider that this read cannot make.
                    <EmptyState
                        title="No readable activity"
                        titleKey="plugins.posthog.ui.noReadableActivity"
                        description="PostHog answered for this issue, but none of the records on the pages read could be shown here."
                        descriptionKey="plugins.posthog.ui.noReadableActivity.description"
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
    const text = usePluginTranslation();
    const [tab, setTab] = React.useState<PosthogDetailTabIdV1>('overview');
    // One render-time read, passed down as data, so no child owns a hidden clock.
    const nowMs = Date.now();

    const live = useLiveEntry(input, signal);
    const controller = usePosthogOccurrenceController(input, signal);
    const model = React.useMemo(
        () => projectPosthogDetailSurface(input, live),
        [input, live],
    );

    const panels: Readonly<Record<PosthogDetailTabIdV1, React.ReactNode>> = {
        overview: <OverviewPanel model={model} locale={locale} nowMs={nowMs} story={input.panel !== undefined} />,
        occurrences: (
            <OccurrencesPanel controller={controller} locale={locale} nowMs={nowMs} />
        ),
        'stack-trace': <StackTracePanel input={input} controller={controller} />,
        'affected-sessions': <AffectedSessionsPanel controller={controller} />,
        // The Activity controller is created inside its own panel: its lifetime is the
        // panel's active interval, so hoisting it here would outlive the leave the
        // declaration promises.
        activity: <ActivityTab input={input} locale={locale} nowMs={nowMs} />,
    };

    // The Triage detail asked for one panel (r0.42): its frame draws the tabs.
    // Stack trace, occurrences and affected sessions are this source's own
    // tabs, declared after the shared ones.
    if (input.panel !== undefined) {
        return (
            <Screen safeArea>
                <TriageDetailPanel
                    panel={input.panel}
                    retention={Object.fromEntries(POSTHOG_DETAIL_TABS_V1.map(
                        (declaration) => [declaration.id, declaration.retention] as const,
                    ))}
                    ariaLabel={text('plugins.posthog.ui.tabsLabel', 'PostHog issue detail')}
                    panels={{ ...panels, activity: <TriageDetailActivity>{panels.activity}</TriageDetailActivity> }}
                />
            </Screen>
        );
    }

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
                ariaLabel={text('plugins.posthog.ui.tabsLabel', 'PostHog issue detail')}
            >
                {POSTHOG_DETAIL_TABS_V1.map((declaration) => (
                    <Tabs.Item
                        key={declaration.id}
                        value={declaration.id}
                        title={text(declaration.titleKey, declaration.title)}
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
                    titleKey="plugins.posthog.ui.invalidInput"
                    description="Triage supplied a detail input this PostHog build does not accept."
                    descriptionKey="plugins.posthog.ui.invalidInput.description"
                />
            </Screen>
        );
    }

    return <TriageDetailInstance><PosthogDetailBody input={admitted.input} signal={context.signal} /></TriageDetailInstance>;
}

/** The manifest names this exact universal CommonJS export. */
export const renderSurface = defineUiSurface(PosthogDetailSurface);
