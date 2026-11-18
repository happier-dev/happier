import * as React from 'react';
import type { PluginUiHostApi, RenderContext, RenderSurface } from '@happier-dev/plugin-sdk/ui';
import { TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1 } from '@happier-dev/triage-protocol/v1';
import {
    Button,
    EmptyState,
    ErrorState,
    FreshnessLine,
    Icon,
    List,
    Row,
    Stack,
    Status,
    TextField,
    defineUiSurface,
    usePluginTheme,
    usePluginTranslation,
    usePluginUiFocusTarget,
    useComposerView,
    useSurfaceContext,
    usePluginUiEphemeralSharedScope,
    usePluginSurfaceActivity,
    type ComposerHandle,
    type ComposerRefV1,
} from '@happier-dev/plugin-ui';

import { TRIAGE_DISPLAY_NAME } from '../displayName.js';
import { readTriageSourceDescriptorV1 } from '../ui/detail/sourceSurface.js';
import { readTriageEntryRowContextV1 } from '../ui/window/entryDisplay.js';
import { isHostCancellation } from '../hostCancellation.js';
import type { TriageRefreshPacingReasonV1 } from '../refresh/refreshEligibility.js';
import { useTriageRefreshEligibilityNowV1 } from '../ui/window/refreshEligibilityClock.js';
import { useTriageListWindow } from '../ui/window/useTriageListWindow.js';
import { selectTriageAttachedEntries, type TriageAttachedEntryV1 } from './attachedEntries.js';
import { applyTriageEntryMutation, describeTriageMutationRefusal } from './applyEntryMutation.js';
import { readTriageComposerPickerMount } from './composerMount.js';
import { openTriageEntryDetails } from './openEntryDetails.js';
import { projectTriagePickerCorpusFacts } from './pickerFacts.js';
import {
    buildTriagePickerView,
    requestTriagePickerRefresh,
    type TriagePickerRowV1,
    type TriagePickerStateV1,
    type TriagePickerViewV1,
} from './pickerModel.js';
import { describeTriageRowActions } from './rowActions.js';
import {
    TRIAGE_ROW_INTERACTION_INITIAL_STATE_V1,
    reduceTriageRowInteraction,
} from './rowActionState.js';
import { useTriageBoundComposer } from './useBoundComposer.js';
import { deriveTriageComposerEntryAttachmentKey } from './attachmentValue.js';
import { bindTriageMountedUiActions } from '../ui/mountedActions.js';
import { useTriageCurrentUiContextPublication } from '../ui/currentContextPublication.js';
import { TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1, type TriageMountedUiOperationV1, type TriageMountedUiResultV1 } from '../actions/mountedUiProtocol.js';
import { TriageSourceMark } from '../ui/list/sourceMark.js';
import { projectTriageSourceHealthFailureV1, readTriageListFailureLine } from '../ui/shell/windowState.js';

/**
 * The Composer entry picker.
 *
 * It is the second consumer of the ONE mounted window, and it reaches the same
 * rows through the same store the shell list reads: opening it over a fresh
 * window issues no provider call at all, and over a cold or stale one it says
 * so and offers **Refresh** rather than showing an empty list (`REQ-14`).
 *
 * It writes to exactly one draft: the one the host stamped on this mount. That
 * address comes from the mount input rather than from "the composer that is
 * open", because two drafts can be live at once and attaching to the wrong one
 * is discovered only after sending.
 *
 * It holds no selected set. Which entries are attached is derived from the
 * canonical composer snapshot on every build, so a host badge removal, an undo
 * or a closed scope settles here without a picker cache re-creating it.
 *
 * Search is local to this picker and never reaches a provider: it filters rows
 * the shared window already holds, and it deliberately does not re-lens the
 * shared window, because narrowing the list behind the reader's back while they
 * type in a popover would be a surprising second effect.
 *
 * Every row is a labelled group with two independent controls. The row itself
 * does nothing when pressed: only Attach/Remove and View details
 * commit an effect, they never fire each other, and their pending and failure
 * state never merge — a navigation refusal must not clear a mutation failure
 * the reader has not seen yet.
 */

const NO_ATTACHMENTS: readonly TriageAttachedEntryV1[] = Object.freeze([]);

/** One search/refresh head for every consumer of the Composer entry picker. */
export function TriagePickerHead(props: Readonly<{
    view: TriagePickerViewV1;
    query: string;
    onQueryChange: (query: string) => void;
    onRefresh: () => void | Promise<void>;
    searchLabel: string;
    children?: React.ReactNode;
}>): React.ReactElement {
    const text = usePluginTranslation();
    const { spacing } = usePluginTheme();
    return <Stack gap="small" style={{ paddingHorizontal: spacing.large, paddingVertical: spacing.small }}>
        <Row gap="small" align="center">
            <Stack grow>
                <TextField label={props.searchLabel} presentation="field" value={props.query}
                    onChange={props.onQueryChange}
                    placeholder={text('plugins.triage.picker.filter', 'Search by title, number or repository')} />
            </Stack>
            <Button accessibilityLabel={text('plugins.triage.surface.refresh', 'Refresh')}
                variant="plain" size="small" icon={<Icon name="refresh" size="small" tone="secondary" />}
                disabled={requestTriagePickerRefresh(props.view).status !== 'invoke'}
                busy={props.view.refresh.kind === 'running'} onPress={props.onRefresh} />
        </Row>
        {props.children}
    </Stack>;
}

/** Shared entry identity and row anatomy; the caller supplies its selection controls. */
export function TriagePickerRow(props: Readonly<{
    row: TriagePickerRowV1;
    detail?: string;
    tone?: 'danger';
    selected?: boolean;
    onPress?: () => void;
    accessory?: React.ReactNode;
}>): React.ReactElement {
    const surface = useSurfaceContext();
    const context = readTriageEntryRowContextV1({
        kindId: props.row.entryRef.kindId,
        scopeLabel: props.row.scopeLabel,
        identifierLabel: props.row.identifierLabel,
        lifecycleLabel: props.row.lifecycleLabel ?? null,
    }, readTriageSourceDescriptorV1(surface, props.row.entryRef.source), props.row.entryRef.source);
    return <List.Item
        title={props.row.title}
        icon={<TriageSourceMark source={props.row.entryRef.source} />}
        subtitle={context.label}
        detail={props.detail}
        tone={props.tone}
        accessibilityLabel={props.row.title}
        accessibilityHint={props.detail === undefined ? context.label : `${context.label}, ${props.detail}`}
        titleNumberOfLines={2}
        subtitleNumberOfLines={1}
        detailNumberOfLines={2}
        selected={props.selected}
        onPress={props.onPress}
        accessoryWraps
        accessoryOutsidePressable
        accessory={props.accessory}
    />;
}

/**
 * One picker row: a labelled group with two independent controls.
 *
 * Its own component because the independence is per-row state. A single
 * picker-wide `busy` flag is the obvious implementation and it is exactly
 * wrong — it disables View details while an attach settles, and it lets a
 * navigation refusal clear a mutation failure the reader has not seen.
 *
 * The row carries no `onPress`: pressing the row itself does nothing, which is
 * what keeps a stray Enter on a focused row from committing an attachment.
 */
function TriageComposerPickerRow(props: Readonly<{
    row: TriagePickerRowV1;
    handle: ComposerHandle | null;
    hostApi: Pick<PluginUiHostApi, 'openSurface' | 'openResource'>;
    /**
     * The exact scope this picker was mounted on, forwarded to View details as
     * the launch ADDRESS — never as a capability. The row already holds the
     * handle it writes through; this is the same fact spelled so the opened page
     * can find its way back, and it is absent when the picker has no mount.
     */
    originComposer: ComposerRefV1 | undefined;
    onSettled: () => Promise<void>;
}>): React.ReactElement {
    const text = usePluginTranslation();
    const { row, handle, hostApi, onSettled, originComposer } = props;
    const [state, dispatch] = React.useReducer(
        reduceTriageRowInteraction,
        TRIAGE_ROW_INTERACTION_INITIAL_STATE_V1,
    );
    const attachmentFocus = usePluginUiFocusTarget();
    const viewDetailsFocus = usePluginUiFocusTarget();
    const [attachmentAction, viewDetailsAction] = describeTriageRowActions(row);

    // Focus follows the reducer, never the press: a refusal keeps the reader on
    // the control they invoked instead of dropping them at the list root.
    React.useEffect(() => {
        if (state.focus === 'attachment') attachmentFocus.focus();
        if (state.focus === 'viewDetails') viewDetailsFocus.focus();
    }, [attachmentFocus, state.focus, viewDetailsFocus]);

    const mutate = React.useCallback(async () => {
        if (row.mutation.kind === 'unavailable' || handle === null) return;
        dispatch({ kind: 'invoked', action: 'attachment' });
        let outcome: Awaited<ReturnType<typeof applyTriageEntryMutation>>;
        try {
            outcome = row.mutation.kind === 'remove'
                ? await applyTriageEntryMutation({ handle, intent: 'remove', entryRef: row.entryRef })
                : await applyTriageEntryMutation({
                    handle,
                    intent: 'attach',
                    entryRef: row.entryRef,
                    sourceInstance: row.mutation.sourceInstance,
                    presentation: row.mutation.presentation,
                    ...(row.mutation.lastKnownLocator === undefined
                        ? {}
                        : { lastKnownLocator: row.mutation.lastKnownLocator }),
                });
        } catch (error) {
            // Cancellation states no outcome about the draft. Return this
            // control to idle/focused so it can be retried; the canonical
            // snapshot remains the only answer to whether anything landed.
            if (isHostCancellation(error, undefined)) {
                dispatch({ kind: 'cancelled', action: 'attachment' });
                await onSettled();
                return;
            }
            throw error;
        }
        if (outcome.kind === 'refused') {
            dispatch({ kind: 'failed', action: 'attachment', reason: describeTriageMutationRefusal(text, outcome.refusal) });
        } else {
            dispatch({ kind: 'settled', action: 'attachment' });
        }
        // The draft is the authority for what is attached, so the picker
        // re-reads it rather than predicting the row's next state.
        await onSettled();
    }, [handle, onSettled, row, text]);

    const openDetails = React.useCallback(async () => {
        if (row.viewDetails.kind !== 'open') return;
        dispatch({ kind: 'invoked', action: 'viewDetails' });
        const outcome = await openTriageEntryDetails({
            hostApi,
            entryRef: row.entryRef,
            sourceInstance: row.viewDetails.sourceInstance,
            originComposer,
        });
        switch (outcome.kind) {
            case 'opened':
                // Focus, dismissal and Back now belong to the generic
                // navigation owner that replaced this transient picker.
                dispatch({ kind: 'settled', action: 'viewDetails' });
                return;
            case 'cancelled':
                dispatch({ kind: 'cancelled', action: 'viewDetails' });
                return;
            case 'refused':
                dispatch({
                    kind: 'failed',
                    action: 'viewDetails',
                    reason: text(
                        'plugins.triage.picker.openFailed',
                        'This entry could not be opened.',
                    ),
                });
        }
    }, [hostApi, originComposer, row]);

    const attachedNow = row.attachment.kind === 'attached';
    const attachmentLabel = attachedNow
        ? text('plugins.triage.picker.remove', 'Remove')
        : text('plugins.triage.picker.attach', 'Attach');
    const attachmentAccessibilityLabel = attachedNow
        ? text(
            'plugins.triage.picker.removeEntryLabel',
            'Remove {title}',
            { title: row.title },
        )
        : text(
            'plugins.triage.picker.attachEntryLabel',
            'Attach {title}',
            { title: row.title },
        );
    const viewDetailsLabel = text('plugins.triage.picker.viewDetails', 'View details');
    const viewDetailsAccessibilityLabel = text(
        'plugins.triage.picker.viewDetailsEntryLabel',
        'View details {title}',
        { title: row.title },
    );
    const failure = state.attachment.kind === 'failed'
        ? state.attachment.reason
        : state.viewDetails.kind === 'failed' ? state.viewDetails.reason : null;

    const status = failure === null
        ? attachedNow ? text('plugins.triage.picker.attached', 'Attached') : null
        : failure;

    return (
        <TriagePickerRow
            row={row}
            {...(status === null
                ? {}
                : failure === null
                    ? { detail: status }
                    : { detail: status, tone: 'danger' as const })}
            // Two real controls, not a trailing affordance. At 320 pt, at the
            // reader's largest type size, or with a long localization they take
            // their own line under the title rather than squeezing it out, and
            // stack one per line when even that will not hold both. Order is
            // always Attach/Remove then View details; RTL mirrors where the
            // line sits and nothing else.
            accessory={(
                <Row gap="small" align="center" wrap>
                    <Button
                        title={attachmentLabel}
                        variant="plain"
                        disabled={!attachmentAction.enabled || handle === null}
                        busy={state.attachment.kind === 'pending'}
                        focusTarget={attachmentFocus}
                        // A list of identical "Attach" controls is unusable by
                        // name alone, so each one names its own entry.
                        accessibilityLabel={attachmentAccessibilityLabel}
                        onPress={mutate}
                    />
                    <Button
                        title={viewDetailsLabel}
                        variant="plain"
                        disabled={!viewDetailsAction.enabled}
                        busy={state.viewDetails.kind === 'pending'}
                        focusTarget={viewDetailsFocus}
                        accessibilityLabel={viewDetailsAccessibilityLabel}
                        onPress={openDetails}
                    />
                </Row>
            )}
        />
    );
}

export function TriageEntryPicker(context: RenderContext): React.ReactElement {
    const text = usePluginTranslation();
    const surface = useSurfaceContext();
    // The host's list shell hands this surface its whole width and leaves insets to the content (the
    // rows below carry their own), so the controls above the list take the page gutter themselves.
    const { spacing } = usePluginTheme();
    const gutter = { paddingHorizontal: spacing.large, paddingVertical: spacing.small } as const;
    const window = useTriageListWindow();
    const sharedScope = usePluginUiEphemeralSharedScope();
    const surfaceActivity = usePluginSurfaceActivity();
    const mountId = React.useId();
    // The exact scope this picker was opened from, and the only one it writes.
    const mount = readTriageComposerPickerMount(context.launchInput);
    const handle = useTriageBoundComposer(mount.status === 'bound' ? mount.composer : null);
    const composerView = useComposerView(handle);
    const [query, setQuery] = React.useState('');

    const attached = React.useMemo<readonly TriageAttachedEntryV1[]>(() => {
        const result = composerView.result;
        return result?.status === 'ready'
            ? selectTriageAttachedEntries(result.snapshot.attachments)
            : NO_ATTACHMENTS;
    }, [composerView.result]);

    // Read once per render, and used only to decide whether a source-stated
    // retry deadline has passed. A slightly old value keeps **Refresh**
    // disabled a moment longer; it can never enable a refresh that is still
    // barred, because the coordinator re-checks the same deadline. The one
    // shared eligibility clock also observes the deadline this surface prints
    // arriving, so a picker left open past it offers the press again instead of
    // waiting for unrelated state activity.
    const nowMs = useTriageRefreshEligibilityNowV1(window.snapshot.refreshBlocked);
    const facts = projectTriagePickerCorpusFacts({ snapshot: window.snapshot, nowMs });
    const view = buildTriagePickerView({
        facts,
        query,
        attached,
    });

    const refresh = React.useCallback(async () => {
        await window.refresh('manual');
    }, [window]);

    const settle = React.useCallback(async () => {
        await composerView.refresh();
    }, [composerView]);

    const runMountedOperation = async (operation: TriageMountedUiOperationV1, signal: AbortSignal): Promise<TriageMountedUiResultV1> => {
        if (signal.aborted) return { status: 'unavailable' };
        if (operation.kind === 'setPickerQuery') {
            setQuery(operation.query);
            return { status: 'applied' };
        }
        if (operation.kind === 'refresh') {
            if (requestTriagePickerRefresh(view).status !== 'invoke') return { status: 'unavailable' };
            await refresh();
            return { status: 'applied' };
        }
        if (operation.kind !== 'attachEntry' && operation.kind !== 'removeEntry' && operation.kind !== 'openDetail') return { status: 'unavailable' };
        const key = deriveTriageComposerEntryAttachmentKey(operation.entryRef);
        const row = view.rows.find((row) => row.id === key);
        if (row === undefined) return { status: 'unavailable' };
        if (operation.kind === 'openDetail') {
            if (row.viewDetails.kind !== 'open') return { status: 'unavailable' };
            const outcome = await openTriageEntryDetails({ hostApi: context.hostApi,
                entryRef: row.entryRef, sourceInstance: row.viewDetails.sourceInstance,
                originComposer: mount.status === 'bound' ? mount.composer : undefined, signal });
            return { status: outcome.kind === 'opened' ? 'applied' : 'unavailable' };
        }
        if (handle === null) return { status: 'unavailable' };
        // The same picker model supplies attach data even when the current
        // snapshot already holds the entry. The mutation owner re-reads and
        // plans against the actual draft, rather than trusting stale row state.
        const mutation = operation.kind === 'attachEntry'
            ? buildTriagePickerView({ facts, query, attached: NO_ATTACHMENTS }).rows.find((row) => row.id === key)?.mutation
            : null;
        if (operation.kind === 'attachEntry' && mutation?.kind !== 'attach') return { status: 'unavailable' };
        const outcome = await applyTriageEntryMutation(mutation?.kind === 'attach'
            ? { handle, intent: 'attach', entryRef: operation.entryRef, sourceInstance: mutation.sourceInstance,
                presentation: mutation.presentation,
                ...(mutation.lastKnownLocator === undefined ? {} : { lastKnownLocator: mutation.lastKnownLocator }), options: { signal } }
            : { handle, intent: 'remove', entryRef: operation.entryRef, options: { signal } });
        await settle();
        return { status: outcome.kind === 'refused' ? 'rejected' : 'applied' };
    };
    const mountedOperationRef = React.useRef(runMountedOperation);
    React.useLayoutEffect(() => { mountedOperationRef.current = runMountedOperation; });
    React.useLayoutEffect(() => sharedScope === null || !surfaceActivity.active ? undefined : bindTriageMountedUiActions(
        sharedScope, mountId, (operation, signal) => mountedOperationRef.current(operation, signal),
    ), [mountId, sharedScope, surfaceActivity.active]);
    const currentUiContext = React.useMemo(() => ({
        detail: {
            view: 'attachment-picker',
            mountedAction: { action: { pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, localId: TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1 }, mountId },
        },
        commands: view.rows.filter((row) => row.viewDetails.kind === 'open').map((row) => ({
            title: text('plugins.triage.picker.viewDetailsEntryLabel', 'View details {title}', { title: row.title }),
            command: { kind: 'executeAction' as const, action: TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1,
                input: { mountId, operation: { kind: 'openDetail', entryRef: row.entryRef } } },
        })),
    }), [mountId, text, view.rows]);
    useTriageCurrentUiContextPublication(context.hostApi, currentUiContext);

    const originComposer = mount.status === 'bound' ? mount.composer : undefined;
    const renderRow = React.useCallback((row: TriagePickerRowV1): React.ReactElement => (
        <TriageComposerPickerRow
            row={row}
            handle={handle}
            hostApi={context.hostApi}
            originComposer={originComposer}
            onSettled={settle}
        />
    ), [context.hostApi, handle, originComposer, settle]);

    /**
     * The ONE Refresh control of this surface, and the one sentence that says
     * why it cannot read yet.
     *
     * Both are built here rather than at each arm below because the pacing
     * model is a property of the surface, not of whichever headline state it is
     * in: the `sourcesUnavailable` arm rendered its own always-enabled Refresh
     * and no waiting notice, so the one state in which every connection had
     * just stated a retry deadline was also the one state that offered a press
     * the coordinator was already refusing, silently. A second control is a
     * second answer to "may this read now", and this surface only has one.
     */
    const refreshable = requestTriagePickerRefresh(view).status === 'invoke';
    const refreshLabel = text('plugins.triage.surface.refresh', 'Refresh');
    const refreshControl = (
        <Button
            title={refreshLabel}
            variant="secondary"
            size="small"
            disabled={!refreshable}
            busy={view.refresh.kind === 'running'}
            onPress={refresh}
        />
    );
    const pacingReason = view.refresh.kind !== 'blockedUntil'
        ? null
        : resolvePacingReasonDescription(text, view.refresh.reason);
    const pacingNotice = pacingReason === null ? null : <FreshnessLine reason={pacingReason} />;

    if (view.state.kind === 'configureSources') {
        return (
            <EmptyState
                title={text('plugins.triage.picker.noSources.title', 'No sources are configured')}
                description={text(
                    'plugins.triage.picker.noSources.description',
                    `Connect a source in Settings to attach ${TRIAGE_DISPLAY_NAME} to a message.`,
                )}
            />
        );
    }

    if (view.state.kind === 'sourcesUnavailable') {
        return (
            <Stack gap="small">
                <ErrorState
                    title={text('plugins.triage.picker.sourcesUnavailable', 'No source could be read')}
                    description={view.health.map((entry) => entry.displayName).join(', ')}
                    action={refreshControl}
                />
                {pacingNotice === null ? null : <Stack style={gutter}>{pacingNotice}</Stack>}
            </Stack>
        );
    }

    // The host gives this picker a bounded body (`layout: 'content'`); the
    // search stays put and the List takes the rest and scrolls itself.
    return (
        <Stack gap="small" grow>
            <TriagePickerHead view={view} query={query} onQueryChange={setQuery} onRefresh={refresh}
                searchLabel={text('plugins.triage.picker.search', `Search ${TRIAGE_DISPLAY_NAME}`)}>

                {/*
                  Healthy says nothing. One quiet line speaks only when the list is
                  behind, being read, or waiting to be read; never a green "Up to date".
                */}
                {pacingNotice ?? (view.state.kind === 'stale' ? (
                    <FreshnessLine
                        asOf={view.state.lastMaterializedAtMs}
                        reason={resolvePickerStateLabel(text, view.state.kind)}
                        busy={view.refresh.kind === 'running'}
                    />
                ) : view.state.kind === 'refreshing' && view.rows.length > 0 ? (
                    <FreshnessLine reason={resolvePickerStateLabel(text, view.state.kind)} busy />
                ) : null)}

                {/* A list says its condition in one quiet line on the rows' edge, in the same words as the page's own
                    line; the head's Refresh is its recovery. */}
                {view.health.length === 0 ? null : (
                    <Status tone="warning" label={readTriageListFailureLine({ kind: 'sources',
                        sources: view.health.map(projectTriageSourceHealthFailureV1) }, text, surface.locale).label} />
                )}
            </TriagePickerHead>

            <List<TriagePickerRowV1>
                accessibilityLabel={TRIAGE_DISPLAY_NAME}
                density="compact"
                items={view.rows}
                keyForItem={(row) => row.id}
                renderItem={renderRow}
                empty={(
                    <EmptyState
                        title={resolvePickerStateLabel(text, view.state.kind)}
                        // An empty body that only restates the headline leaves
                        // the reader nothing to do. When a read is actually
                        // available — which is exactly the cold and stale
                        // cases — the body names it instead.
                        {...(refreshable ? {
                            description: text(
                                'plugins.triage.picker.refreshRemedy',
                                'Refresh to read your connected sources.',
                            ),
                        } : {})}
                    />
                )}
            />
        </Stack>
    );
}

/**
 * One label per headline state. `noMatchYet` and `noMatch` are deliberately
 * different words: a bounded window that is still walking has not concluded
 * absence, and saying it has would be the false-empty this surface exists to
 * avoid. `boundedWindow` is that same unfinished walk with nothing typed, so it
 * reuses the shell's own translated sentence for it rather than telling a reader
 * who filtered nothing that nothing matches yet.
 *
 * The map is keyed by the state union rather than by `string`, so a new arm
 * without copy is a compile error instead of a headline that renders its own
 * enum name on every locale.
 */
const PICKER_STATE_COPY: Readonly<Record<
    TriagePickerStateV1['kind'],
    Readonly<{ key: string; fallback: string }>
>> = Object.freeze({
    configureSources: { key: 'plugins.triage.picker.noSources.title', fallback: 'No sources are configured' },
    refreshing: { key: 'plugins.triage.surface.refreshing', fallback: 'Refreshing' },
    neverSynchronized: { key: 'plugins.triage.picker.notSynchronized', fallback: 'Not synchronized yet' },
    stale: { key: 'plugins.triage.surface.lastKnown', fallback: 'Showing the last known list' },
    sourcesUnavailable: { key: 'plugins.triage.picker.sourcesUnavailable', fallback: 'No source could be read' },
    noMatchYet: { key: 'plugins.triage.picker.noMatchYet', fallback: 'No match yet — still reading' },
    boundedWindow: {
        key: 'plugins.triage.surface.empty.incomplete.title',
        fallback: 'This list is not complete yet',
    },
    noMatch: { key: 'plugins.triage.picker.noMatch', fallback: 'No match' },
    empty: { key: 'plugins.triage.picker.empty', fallback: 'Nothing to attach' },
    ready: { key: 'plugins.triage.surface.upToDate', fallback: 'Up to date' },
});

/**
 * Why a Refresh cannot read yet, in the reader's words.
 *
 * A disabled control with no sentence beside it is the same silence as a control
 * that does nothing: the reader presses it, nothing happens, and nothing says
 * why. Each arm is the coordinator's own reason, so the sentence cannot claim a
 * different cause than the one that actually refused (`core/CORPUS.md` §4.2).
 */
const PACING_REASON_COPY: Readonly<Record<TriageRefreshPacingReasonV1, Readonly<{
    key: string;
    fallback: string;
}>>> = Object.freeze({
    sourceRetryDeadline: {
        key: 'plugins.triage.surface.waiting.source',
        fallback: 'A source asked us to wait before reading it again.',
    },
});

export function resolvePacingReasonDescription(
    text: (key: string, fallback?: string) => string,
    reason: TriageRefreshPacingReasonV1,
): string {
    const copy = PACING_REASON_COPY[reason];
    return text(copy.key, copy.fallback);
}

export function resolvePickerStateLabel(
    text: (key: string, fallback?: string) => string,
    state: TriagePickerStateV1['kind'],
): string {
    const copy = PICKER_STATE_COPY[state];
    return text(copy.key, copy.fallback);
}

/**
 * The picker artifact entry the declared attachment renderer mounts. It adds no
 * mount seam of its own: the same provider wrapper the app page uses installs
 * the theme, locale and accessibility facts, and the rows come from the window
 * the page already shares with it.
 */
export const renderSurface: RenderSurface = defineUiSurface(TriageEntryPicker);
