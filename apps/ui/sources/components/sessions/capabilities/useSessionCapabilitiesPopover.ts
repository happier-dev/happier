import * as React from 'react';
import type { CurrentUiContextCommandInvocation } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { useNewSessionCapabilities } from '@/sync/domains/capabilities/session/useNewSessionCapabilities';
import { useSessionCapabilities } from '@/sync/domains/capabilities/session/useSessionCapabilities';
import { buildSessionCapabilitiesModel, type SessionCapabilitiesModelInput } from './sessionCapabilitiesModel';
import { readSessionCapabilityApplyChange, type SessionCapabilityChange } from './sessionCapabilityApplyNotice';
import { readCapabilitySelectionApplyV1 } from '@happier-dev/protocol/reach/sessionCapabilityMetadataV1';
import { readSessionCapabilityOverrideV1, setSessionCapabilitySelectionItemV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';

export type NewSessionCapabilitiesDraft = Parameters<typeof useNewSessionCapabilities>[0] & Readonly<{
    itemEditing?: Readonly<{
        bulk: NonNullable<SessionCapabilitiesModelInput['bulk']>;
        setItem: (kind: SessionCapabilityChange['kind'], id: string, state: SessionCapabilityChange['state']) => void;
    }>;
}>;
export type SessionCapabilitiesTarget = Readonly<{ kind: 'draft'; draft: NewSessionCapabilitiesDraft }>
    | Readonly<{ kind: 'session'; sessionId: string; serverId: string | null; readOnly: boolean }>;
/** The person's last own change, in the words of the sheet's in-place Undo line ("pdf added · Undo"). */
export type SessionCapabilityUndoReceipt = Readonly<{ kind: SessionCapabilityChange['kind']; title: string; change: 'added' | 'removed' }>;
export type SessionCapabilitiesPresentation = Omit<SessionCapabilitiesModelInput, 'view' | 'selection' | 'state' | 'readOnly' | 'change'>;

/** Detail hooks belong inside the open popover/sheet leaf; P2 remains the only selection store. */
export function useExistingSessionCapabilitiesPopover(target: Extract<SessionCapabilitiesTarget, { kind: 'session' }>, presentation: SessionCapabilitiesPresentation) {
    const state = useSessionCapabilities(target.sessionId, undefined, { serverId: target.serverId });
    const [change, setChange] = React.useState<SessionCapabilityChange | null>(null);
    // Undo resends the `previous` override the Action returned (IR-77), so the receipt keeps it beside the words.
    const [undoOffer, setUndoOffer] = React.useState<Readonly<{ id: string; written: SessionCapabilityChange['state']; receipt: SessionCapabilityUndoReceipt;
        previous: SessionCapabilityChange['state'] }> | null>(null);
    const key = state.scopeKey;
    const receiptKey = React.useRef(key);
    const metadataChange = React.useMemo(() => readSessionCapabilityApplyChange(state.metadata, (kind, id) => {
        if (kind === 'native_skill') return id;
        const item = (kind === 'mcp_server' ? state.preview?.mcp.items : state.preview?.skills.items)?.find(item => item.id === id);
        return item ? item.title ?? item.name : null;
    }), [state.metadata, state.preview]);
    const changeForTarget = React.useMemo(() => {
        const localChange = receiptKey.current === key ? change : null;
        const applyRecord = localChange ? readCapabilitySelectionApplyV1(state.metadata)[localChange.kind === 'mcp_server' ? 'mcp' : 'skills'] : null;
        return metadataChange ?? (localChange ? { ...localChange, ...applyRecord } : null);
    }, [metadataChange, key, change, state.metadata]);
    React.useEffect(() => { receiptKey.current = key; setChange(null); setUndoOffer(null); }, [key]);
    React.useEffect(() => {
        if (metadataChange && 'source' in metadataChange) setChange(null);
    }, [metadataChange]);
    const setItem = React.useCallback(async (kind: SessionCapabilityChange['kind'], id: string, value: SessionCapabilityChange['state'], suppliedTitle?: string,
        invocation?: CurrentUiContextCommandInvocation) => {
        if (target.readOnly) return { ok: false as const, message: 'read_only' };
        const item = (kind === 'mcp_server' ? state.preview?.mcp.items : state.preview?.skills.items)?.find(item => item.id === id);
        const title = suppliedTitle ?? (kind === 'native_skill' ? id : item ? item.title ?? item.name : null);
        const result = await state.setItem(kind, id, value, undefined, invocation);
        if (result.ok && title && receiptKey.current === key) {
            const written = result.state;
            setChange({ kind, title, state: written });
            // A return to the rules ("inherit") adds back what was off and removes what was added.
            const added = written === 'on' || written === 'inherit' && result.previous === 'off';
            setUndoOffer({ id, written, receipt: { kind, title, change: added ? 'added' : 'removed' }, previous: result.previous });
        } else if (!result.ok) setUndoOffer(null);
        return result;
    }, [target.readOnly, state.setItem, state.preview, key]);
    const modelInput = React.useMemo(() => ({
        view: state.preview ? { ...state.preview, pendingApply: state.pendingApply } : null, selection: state.selection,
        applyState: { pendingApply: state.pendingApply, applyTiming: state.applyTiming },
        // A check that failed while the session's machine is offline is the machine being away, not a failure.
        // Presence can remain unknown independently of a settled capability read.
        // Only the read's lifecycle decides whether the sheet is still resolving.
        state: state.status === 'ready' ? 'ready' as const : state.status === 'unavailable'
            ? presentation.machineOnline === false ? 'machine_unreachable' as const : 'error' as const : 'resolving' as const,
        readOnly: target.readOnly, change: changeForTarget }), [state.preview, state.pendingApply, state.applyTiming, state.selection, state.status,
        presentation.machineOnline, target.readOnly, changeForTarget]);
    const model = React.useMemo(() => buildSessionCapabilitiesModel({ ...presentation, ...modelInput }), [presentation, modelInput]);
    const dismissNotice = React.useCallback(() => setChange(null), []);
    // Undo stays offered while the item still holds what this change wrote (native skills hold only off/inherit); a newer write by any device retires it.
    const undoCurrent = undoOffer && readSessionCapabilityOverrideV1(state.selection, undoOffer.receipt.kind, undoOffer.id)
        === readSessionCapabilityOverrideV1(setSessionCapabilitySelectionItemV1({}, undoOffer.receipt.kind, undoOffer.id, undoOffer.written), undoOffer.receipt.kind, undoOffer.id) ? undoOffer : null;
    const undoLast = React.useCallback(async (invocation?: CurrentUiContextCommandInvocation) => {
        if (target.readOnly) return { ok: false as const, message: 'read_only' };
        const offered = undoCurrent;
        setUndoOffer(null);
        const result = await state.undoLast(invocation);
        // The undone change is itself the latest one the composer's apply line should describe.
        if (result.ok && offered && receiptKey.current === key) setChange({ kind: offered.receipt.kind, title: offered.receipt.title, state: offered.previous });
        return result;
    }, [target.readOnly, state.undoLast, undoCurrent, key]);
    return { model, modelInput, setItem, metadata: state.metadata, selection: state.selection, pendingApply: state.pendingApply, applyTiming: state.applyTiming,
        undoReceipt: undoCurrent?.receipt ?? null, undoLast, demandPreview: state.demandPreview, refresh: state.refresh, error: state.error, dismissNotice };
}

/** Draft/Workflow/Trigger edits reuse the same P2 draft owner and never write an existing Session. */
export function useNewSessionCapabilitiesPopover(draft: NewSessionCapabilitiesDraft, presentation: SessionCapabilitiesPresentation) {
    const state = useNewSessionCapabilities(draft);
    const bulk = draft.itemEditing?.bulk;
    const modelInput = React.useMemo(() => ({ view: state.preview, selection: state.selection,
        ...(bulk ? { bulk } : {}),
        // REACH's presence decides "offline" too: a failed check against a machine that is away is not a failure.
        state: state.previewStatus === 'ready' ? 'ready' as const
            : state.previewStatus === 'unreachable' || (state.previewStatus === 'error' && presentation.machineOnline === false) ? 'machine_unreachable' as const
            : state.previewStatus === 'error' ? 'error' as const : 'resolving' as const, readOnly: false }),
        [state.preview, state.selection, state.previewStatus, presentation.machineOnline, bulk]);
    const model = React.useMemo(() => buildSessionCapabilitiesModel({ ...presentation, ...modelInput }), [presentation, modelInput]);
    return { model, modelInput, setItem: draft.itemEditing?.setItem ?? state.setItem,
        demandPreview: state.demandPreview, refresh: state.refresh, error: state.error };
}
