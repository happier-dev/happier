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
    usePluginUiFocusTarget,
    useComposerView,
    type ComposerHandle,
} from '@happier-dev/plugin-ui';

import { TRIAGE_DISPLAY_NAME } from '../manifest.js';
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
    onSettled: () => Promise<void>;
}>): React.ReactElement {
    const { row, handle, hostApi, onSettled } = props;
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
        const outcome = row.mutation.kind === 'remove'
            ? await applyTriageEntryMutation({ handle, intent: 'remove', entryRef: row.entryRef })
            : await applyTriageEntryMutation({
                handle,
                intent: 'attach',
                entryRef: row.entryRef,
                sourceInstance: row.mutation.sourceInstance,
                presentation: row.mutation.presentation,
            });
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
                    reason: 'This entry could not be opened.',
                });
        }
    }, [hostApi, row]);

    const attachedNow = row.attachment.kind === 'attached';
    const attachmentLabel = attachedNow ? 'Remove' : 'Attach';
    const failure = state.attachment.kind === 'failed'
        ? state.attachment.reason
        : state.viewDetails.kind === 'failed' ? state.viewDetails.reason : null;

    return (
        <List.Item
            title={row.title}
            subtitle={row.scopeLabel}
            {...(failure === null
                ? attachedNow ? { detail: 'Attached' } : {}
                : { detail: failure, tone: 'danger' as const })}
            accessory={(
                <Row gap="small" align="center">
                    <Button
                        title={attachmentLabel}
                        variant="plain"
                        disabled={!attachmentAction.enabled || handle === null}
                        busy={state.attachment.kind === 'pending'}
                        focusTarget={attachmentFocus}
                        // A list of identical "Attach" controls is unusable by
                        // name alone, so each one names its own entry.
                        accessibilityLabel={`${attachmentLabel} ${row.title}`}
                        onPress={mutate}
                    />
                    <Button
                        title="View details"
                        variant="plain"
                        disabled={!viewDetailsAction.enabled}
                        busy={state.viewDetails.kind === 'pending'}
                        focusTarget={viewDetailsFocus}
                        accessibilityLabel={`View details ${row.title}`}
                        onPress={openDetails}
                    />
                </Row>
            )}
        />
    );
}

export function TriageEntryPicker(context: RenderContext): React.ReactElement {
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

    const renderRow = React.useCallback((row: TriagePickerRowV1): React.ReactElement => (
        <TriagePickerRow
            row={row}
            handle={handle}
            hostApi={context.hostApi}
            onSettled={settle}
        />
    ), [context.hostApi, handle, settle]);

    if (view.state.kind === 'configureSources') {
        return (
            <EmptyState
                title="No sources are configured"
                description={`Connect a source in Settings to attach ${TRIAGE_DISPLAY_NAME} to a message.`}
            />
        );
    }

    if (view.state.kind === 'sourcesUnavailable') {
        return (
            <ErrorState
                title="No source could be read"
                description={view.health.map((entry) => entry.displayName).join(', ')}
                action={<Button title="Refresh" variant="secondary" onPress={refresh} />}
            />
        );
    }

    const refreshable = requestTriagePickerRefresh(view).status === 'invoke';

    return (
        <Stack gap="small">
            <TextField
                label={`Search ${TRIAGE_DISPLAY_NAME}`}
                value={query}
                onChange={setQuery}
                placeholder="Filter by title or scope"
            />

            <Row justify="space-between" align="center">
                <Status
                    tone={view.state.kind === 'refreshing'
                        ? 'info'
                        : view.state.kind === 'ready' ? 'success' : 'muted'}
                    pulsing={view.state.kind === 'refreshing'}
                    label={PICKER_STATE_LABELS[view.state.kind]}
                />
                <Button
                    title="Refresh"
                    variant="secondary"
                    disabled={!refreshable}
                    busy={view.refresh.kind === 'running'}
                    onPress={refresh}
                />
            </Row>

            {view.health.length === 0 ? null : (
                <Banner
                    tone="warning"
                    title="Some sources could not be read"
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
                        title={PICKER_STATE_LABELS[view.state.kind]}
                        // An empty body that only restates the headline leaves
                        // the reader nothing to do. When a read is actually
                        // available — which is exactly the cold and stale
                        // cases — the body names it instead.
                        {...(refreshable ? { description: PICKER_REFRESH_REMEDY } : {})}
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
 * avoid.
 */
const PICKER_REFRESH_REMEDY = 'Refresh to read your connected sources.';

const PICKER_STATE_LABELS: Readonly<Record<string, string>> = Object.freeze({
    configureSources: 'No sources are configured',
    refreshing: 'Refreshing',
    neverSynchronized: 'Not synchronized yet',
    stale: 'Showing the last known list',
    sourcesUnavailable: 'No source could be read',
    noMatchYet: 'No match yet — still reading',
    noMatch: 'No match',
    empty: 'Nothing to attach',
    ready: 'Up to date',
});

/**
 * The picker artifact entry the declared attachment renderer mounts. It adds no
 * mount seam of its own: the same provider wrapper the app page uses installs
 * the theme, locale and accessibility facts, and the rows come from the window
 * the page already shares with it.
 */
export const renderSurface: RenderSurface = defineUiSurface(TriageEntryPicker);
