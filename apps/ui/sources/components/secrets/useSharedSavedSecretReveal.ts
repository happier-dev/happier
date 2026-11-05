import * as React from 'react';
import { AppState } from 'react-native';
import type { SavedSecretCatalogEntryV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { SharedSavedSecretRevealOutputV1Schema, type SharedSavedSecretRevealInputV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { captureLazyActionAccountContext, type LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { runTeamAction } from '@/sync/ops/teams/teamActionClient';
import { openSavedSecretDisclosureInContext, recordSavedSecretDisclosureInContext, isSavedSecretDisclosureStorageCurrentInContext } from '@/sync/ops/settings/savedSecretResourceOperations';
import { getDeviceAnalyticsId } from '@/track/settingsAnalytics/deviceAnalyticsIdentity';
import { useClipboardWrite } from '@/hooks/ui/useClipboardWrite';

type CopyOutcome = 'succeeded' | 'refused' | 'outcome_unknown';
export type SharedSavedSecretRevealState =
    | Readonly<{ status: 'hidden' }>
    | Readonly<{ status: 'revealed'; value: string; historyEntryId: string; copyOutcome?: CopyOutcome }>
    | Readonly<{ status: 'refused'; reason: string }>;
type Custody = Readonly<{ account: LazyActionAccountContext; controller: AbortController;
    scope: ServerAccountScope; ref: string; revision: number;
    accountMode: 'plain' | 'e2ee'; resourceMode: 'plain' | 'e2ee' | null;
    historyEntryId: string; deviceId: string; retired: { dispose(): void } }>;
const hiddenState: SharedSavedSecretRevealState = { status: 'hidden' };
function foreground() {
    return AppState.currentState !== 'background' && AppState.currentState !== 'inactive'
        && (typeof document === 'undefined' || document.visibilityState !== 'hidden');
}

/** One transient data owner for the shared visual leaf; no catalog, cache, timer or display persistence. */
export function useSharedSavedSecretReveal(input: Readonly<{
    scope: ServerAccountScope; entry: SavedSecretCatalogEntryV1;
    /** The shared visual owner supplies its designed exact-resource disclosure confirmation. */
    confirmDisclosure: (entry: SavedSecretCatalogEntryV1) => Promise<boolean>;
}>) {
    const writeClipboard = useClipboardWrite(input.scope);
    const [state, setState] = React.useState<SharedSavedSecretRevealState>(hiddenState);
    const stateRef = React.useRef(state);
    stateRef.current = state;
    const current = React.useRef(input);
    current.current = input;
    const custody = React.useRef<Custody | null>(null);
    const pending = React.useRef<AbortController | null>(null);
    const mounted = React.useRef(true);
    const isCurrentCustody = React.useCallback((held: Custody) => mounted.current && custody.current === held
        && !held.controller.signal.aborted && held.account.accountLifetime.isCurrent() && foreground()
        && current.current.scope.serverId === held.scope.serverId && current.current.scope.accountId === held.scope.accountId
        && current.current.entry.ref === held.ref && current.current.entry.revision === held.revision
        && current.current.entry.encryptionMode === held.resourceMode
        && current.current.entry.capabilities.manageAccess && current.current.entry.materialStatus === 'ready', []);
    const hide = React.useCallback(() => {
        pending.current?.abort();
        pending.current = null;
        const held = custody.current;
        custody.current = null;
        held?.retired.dispose();
        held?.controller.abort();
        held?.account.dispose();
        stateRef.current = hiddenState;
        if (mounted.current) setState(previous => previous.status === 'hidden' ? previous : hiddenState);
    }, []);
    React.useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; hide(); };
    }, [hide]);
    React.useEffect(() => hide, [hide, input.scope.serverId, input.scope.accountId, input.entry.ref,
        input.entry.revision, input.entry.capabilities.manageAccess, input.entry.encryptionMode, input.entry.materialStatus]);
    React.useEffect(() => {
        const native = AppState.addEventListener('change', next => { if (next !== 'active') hide(); });
        const visibility = () => { if (!foreground()) hide(); };
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visibility);
        return () => {
            native.remove();
            if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visibility);
        };
    }, [hide]);

    /** Snapshot the mounted subject and the exactness check every later await re-asks. */
    const select = React.useCallback(() => {
        const selected = { ...current.current, scope: { ...current.current.scope }, entry: { ...current.current.entry,
            capabilities: { ...current.current.entry.capabilities } } };
        const eligible = foreground() && selected.entry.capabilities.manageAccess && selected.entry.source === 'shared_resource'
            && selected.entry.revision !== null && selected.entry.materialStatus === 'ready';
        const controller = new AbortController();
        const exact = () => mounted.current && !controller.signal.aborted && foreground()
            && current.current.scope.serverId === selected.scope.serverId && current.current.scope.accountId === selected.scope.accountId
            && current.current.entry.ref === selected.entry.ref && current.current.entry.revision === selected.entry.revision
            && current.current.entry.encryptionMode === selected.entry.encryptionMode
            && current.current.entry.capabilities.manageAccess && current.current.entry.materialStatus === 'ready';
        return { selected, eligible, controller, exact };
    }, []);
    type Selection = ReturnType<typeof select>;

    /** The reveal Action's display port: open the admitted exact resource into this leaf's custody. */
    const display = React.useCallback(async ({ selected, controller, exact }: Selection, admitted: SharedSavedSecretRevealInputV1) => {
        if (!exact() || admitted.ref !== selected.entry.ref || admitted.expectedRevision !== selected.entry.revision) {
            return { ok: false, errorCode: 'resource_changed', error: 'resource_changed' };
        }
        const account = await captureLazyActionAccountContext(selected.scope.serverId, controller.signal);
        let retained = false;
        try {
            if (account.accountId !== selected.scope.accountId || !exact()) return { ok: false, errorCode: 'resource_changed', error: 'resource_changed' };
            const deviceId = getDeviceAnalyticsId();
            if (!deviceId) return { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
            const opened = await openSavedSecretDisclosureInContext(account, admitted, deviceId, controller.signal, exact);
            if (!opened.ok || !exact()) return { ok: false, errorCode: opened.ok ? 'resource_changed' : opened.reason,
                error: opened.ok ? 'resource_changed' : opened.reason };
            const retired = account.accountLifetime.onRetire(hide);
            custody.current = { account, controller, scope: selected.scope, ref: admitted.ref, revision: admitted.expectedRevision,
                accountMode: opened.accountMode, resourceMode: selected.entry.encryptionMode,
                deviceId, historyEntryId: opened.historyEntryId, retired };
            retained = true;
            const next = { status: 'revealed' as const, value: opened.value, historyEntryId: opened.historyEntryId };
            stateRef.current = next;
            setState(next);
            return { status: 'displayed' as const, historyEntryId: opened.historyEntryId };
        } finally { if (!retained) account.dispose(); }
    }, [hide]);
    const settle = React.useCallback((controller: AbortController) => {
        if (pending.current === controller) pending.current = null;
        if (custody.current?.controller !== controller) controller.abort();
    }, []);

    const reveal = React.useCallback(async () => {
        hide();
        const selection = select();
        const { selected, controller, exact } = selection;
        const revision = selected.entry.revision;
        if (!selection.eligible || revision === null) return;
        pending.current = controller;
        try {
            if (!await selected.confirmDisclosure(selected.entry) || !exact()) return;
            const outcome = await runTeamAction({ scope: selected.scope, actionId: 'secrets.shared.reveal',
                input: { ref: selected.entry.ref, expectedRevision: revision }, approval: 'surface_confirmed', signal: controller.signal,
                parse: value => SharedSavedSecretRevealOutputV1Schema.parse(value), executorOptions: {
                    savedSecretRevealAction: async ({ input: admitted }) => await display(selection, admitted),
                } });
            if (outcome.kind === 'failed' && exact()) setState({ status: 'refused', reason: outcome.failure.code ?? 'unavailable' });
        } catch {
            if (exact()) setState({ status: 'refused', reason: 'unavailable' });
        } finally { settle(controller); }
    }, [display, hide, select, settle]);

    /**
     * An Agent or MCP request the person allowed: that Allow was the one confirmation and the approval
     * replay is already executing the reveal Action, so this is its display port, not a second Action.
     */
    const revealApproved = React.useCallback(async (admitted: SharedSavedSecretRevealInputV1) => {
        hide();
        const selection = select();
        if (!selection.eligible) return { ok: false, errorCode: 'resource_changed', error: 'resource_changed' };
        pending.current = selection.controller;
        try { return await display(selection, admitted); } finally { settle(selection.controller); }
    }, [display, hide, select, settle]);

    const copy = React.useCallback(async (): Promise<CopyOutcome> => {
        const held = custody.current;
        const displayed = stateRef.current;
        if (!held || displayed.status !== 'revealed' || !isCurrentCustody(held)) return 'refused';
        const exact = () => isCurrentCustody(held) && stateRef.current === displayed;
        const facts = { ref: held.ref, expectedRevision: held.revision,
            historyEntryId: held.historyEntryId, deviceId: held.deviceId };
        try {
            held.account.assertCurrent();
            const requested = await recordSavedSecretDisclosureInContext(held.account, { ...facts, outcome: 'requested' }, 'copy', held.controller.signal);
            if (!requested.ok || !exact()) { hide(); return 'refused'; }
            if (!await isSavedSecretDisclosureStorageCurrentInContext(held.account, held.accountMode, held.resourceMode) || !exact()) {
                hide(); return 'refused';
            }
            held.account.assertCurrent();
            // The platform write exists only in this explicit person gesture.
            const copied = await writeClipboard(displayed.value, { signal: held.controller.signal });
            const outcome = copied ? 'succeeded' as const : 'refused' as const;
            const recorded = await recordSavedSecretDisclosureInContext(held.account, { ...facts, outcome }, 'copy', held.controller.signal);
            const settled = recorded.ok ? outcome : 'outcome_unknown' as const;
            if (exact()) {
                const next = { ...displayed, copyOutcome: settled };
                stateRef.current = next;
                setState(next);
            }
            return settled;
        } catch { hide(); return 'outcome_unknown'; }
    }, [hide, isCurrentCustody, writeClipboard]);
    const held = custody.current;
    const visibleState = state.status === 'revealed' && (!held || !isCurrentCustody(held)) ? hiddenState : state;
    return { state: visibleState, reveal, revealApproved, hide, copy };
}
