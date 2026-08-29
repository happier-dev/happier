import * as React from 'react';
import type { PluginUiHostApi, RenderContext, RenderSurface } from '@happier-dev/plugin-sdk/ui';
import {
    Banner,
    Button,
    EmptyState,
    ErrorState,
    List,
    Row,
    Stack,
    Status,
    TextField,
    defineUiSurface,
    usePluginTranslation,
    usePluginUiFocusTarget,
    useComposerView,
    type ComposerHandle,
    type ComposerRefV1,
} from '@happier-dev/plugin-ui';

import { TRIAGE_DISPLAY_NAME } from '../displayName.js';
import { isHostCancellation } from '../hostCancellation.js';
import type { TriageRefreshPacingReasonV1 } from '../refresh/refreshEligibility.js';
import { useTriageListWindow } from '../ui/window/useTriageListWindow.js';
import { selectTriageAttachedEntries, type TriageAttachedEntryV1 } from './attachedEntries.js';
import { applyTriageEntryMutation } from './applyEntryMutation.js';
import { readTriageComposerPickerMount } from './composerMount.js';
import { openTriageEntryDetails } from './openEntryDetails.js';
import { projectTriagePickerCorpusFacts } from './pickerFacts.js';
import {
    buildTriagePickerView,
    requestTriagePickerRefresh,
    type TriagePickerRowV1,
    type TriagePickerStateV1,
} from './pickerModel.js';
import { describeTriageRowActions } from './rowActions.js';
import {
    TRIAGE_ROW_INTERACTION_INITIAL_STATE_V1,
    reduceTriageRowInteraction,
} from './rowActionState.js';
import { useTriageBoundComposer } from './useBoundComposer.js';

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
function TriagePickerRow(props: Readonly<{
    row: TriagePickerRowV1;
    handle: ComposerHandle | null;
    hostApi: Pick<PluginUiHostApi, 'openSurface'>;
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
            dispatch({ kind: 'failed', action: 'attachment', reason: outcome.reason });
        } else {
            dispatch({ kind: 'settled', action: 'attachment' });
        }
        // The draft is the authority for what is attached, so the picker
        // re-reads it rather than predicting the row's next state.
        await onSettled();
    }, [handle, onSettled, row]);

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
        <List.Item
            title={row.title}
            subtitle={row.scopeLabel}
            {...(status === null
                ? {}
                : failure === null
                    ? { detail: status }
                    : { detail: status, tone: 'danger' as const })}
            // `core/COMPOSER.md` §2: the row is a labelled GROUP, so it names
            // the entry once and describes the rest. Without a name of its own
            // the platform composes one from the row's text descendants, and a
            // reader hears "Fix the parser crashacme/webAttached" — the same
            // run-together announcement the shell list already had to fix. The
            // status is part of the description rather than the name because it
            // changes while the reader is on the row, and a name that changes
            // is a name nothing can be pointed at.
            accessibilityLabel={row.title}
            accessibilityHint={status === null
                ? row.scopeLabel
                : `${row.scopeLabel}, ${status}`}
            // The picker's own list is virtualized too, and its rows are the
            // same measured-average estimate the shell's are.
            titleNumberOfLines={2}
            subtitleNumberOfLines={1}
            detailNumberOfLines={2}
            // Two real controls, not a trailing affordance. At 320 pt, at the
            // reader's largest type size, or with a long localization they take
            // their own line under the title rather than squeezing it out, and
            // stack one per line when even that will not hold both. Order is
            // always Attach/Remove then View details; RTL mirrors where the
            // line sits and nothing else.
            accessoryWraps
            accessoryOutsidePressable
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
    const window = useTriageListWindow();
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
    // barred, because the coordinator re-checks the same deadline.
    const nowMs = Date.now();
    const view = buildTriagePickerView({
        facts: projectTriagePickerCorpusFacts({ snapshot: window.snapshot, nowMs }),
        query,
        attached,
    });

    const refresh = React.useCallback(async () => {
        await window.refresh('manual');
    }, [window]);

    const settle = React.useCallback(async () => {
        await composerView.refresh();
    }, [composerView]);

    const originComposer = mount.status === 'bound' ? mount.composer : undefined;
    const renderRow = React.useCallback((row: TriagePickerRowV1): React.ReactElement => (
        <TriagePickerRow
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
    const refreshControl = (
        <Button
            title={text('plugins.triage.surface.refresh', 'Refresh')}
            variant="secondary"
            disabled={!refreshable}
            busy={view.refresh.kind === 'running'}
            onPress={refresh}
        />
    );
    const pacingNotice = view.refresh.kind !== 'blockedUntil' ? null : (
        <Banner
            tone="info"
            title={text('plugins.triage.surface.waiting', 'Waiting before the next read')}
            description={resolvePacingReasonDescription(text, view.refresh.reason)}
        />
    );

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
                {pacingNotice}
            </Stack>
        );
    }

    return (
        <Stack gap="small">
            <TextField
                label={text('plugins.triage.picker.search', `Search ${TRIAGE_DISPLAY_NAME}`)}
                value={query}
                onChange={setQuery}
                placeholder={text('plugins.triage.picker.filter', 'Filter by title or scope')}
            />

            <Row justify="space-between" align="center">
                <Status
                    tone={view.state.kind === 'refreshing'
                        ? 'info'
                        : view.state.kind === 'ready' ? 'success' : 'muted'}
                    pulsing={view.state.kind === 'refreshing'}
                    label={resolvePickerStateLabel(text, view.state.kind)}
                />
                {refreshControl}
            </Row>

            {pacingNotice}

            {view.health.length === 0 ? null : (
                <Banner
                    tone="warning"
                    title={text('plugins.triage.surface.failure.some', 'Some sources could not be read')}
                    description={view.health.map((entry) => entry.displayName).join(', ')}
                />
            )}

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
    failureBackoff: {
        key: 'plugins.triage.surface.waiting.backoff',
        fallback: 'A source could not be read, so the next attempt waits a moment.',
    },
    minimumInterval: {
        key: 'plugins.triage.surface.waiting.recent',
        fallback: 'These sources were read a moment ago.',
    },
});

function resolvePacingReasonDescription(
    text: (key: string, fallback?: string) => string,
    reason: TriageRefreshPacingReasonV1,
): string {
    const copy = PACING_REASON_COPY[reason];
    return text(copy.key, copy.fallback);
}

function resolvePickerStateLabel(
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
