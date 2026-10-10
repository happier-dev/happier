import * as React from 'react';
import type { ComputerAccessV1, ComputerSelectedTargetResponseV1 } from '@happier-dev/protocol/computer/v1';
import { computerTargetKeyV1 } from '@happier-dev/protocol/computer/v1';

import { createComputerControlClient, type ComputerActionExecute, type ComputerSessionScope } from '@/sync/domains/computer/computerControlClient';
import { needsComputerPermission, resolveComputerRecovery, resolveSuggestedTargetKey, type ComputerTargetEntry, type ComputerTargetPickerState } from '@/sync/domains/computer/targets';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

export type ComputerTargetPickerInput = Readonly<{
    scope: ComputerSessionScope;
    execute: ComputerActionExecute;
    accountLifetime?: ServerAccountScopeLifetime | null;
    currentTargetKey: string | null;
    access?: ComputerAccessV1;
    requestedTarget?: string | null;
    refusalCode?: string;
    onChosen?: (entry: ComputerTargetEntry, access: ComputerAccessV1) => void;
    onSelected: (selection: ComputerSelectedTargetResponseV1) => void;
    onStoppedSharing?: () => void;
    onClose: () => void;
}>;

/** The picker has one data owner; each intent uses the ordinary Machine's Computer Actions. */
export function useComputerTargetPicker(input: ComputerTargetPickerInput) {
    const { execute, onChosen, onClose, onSelected, onStoppedSharing } = input;
    const { serverId, sessionId, machineId } = input.scope;
    const accountLifetime = input.accountLifetime;
    const client = React.useMemo(() => createComputerControlClient({ serverId, sessionId, machineId }, execute, accountLifetime),
        [accountLifetime, execute, machineId, serverId, sessionId]);
    const [state, setState] = React.useState<ComputerTargetPickerState>(
        input.refusalCode ? { kind: 'failed', code: input.refusalCode } : { kind: 'loading' });
    const [selectedKey, setSelectedKey] = React.useState<string | null>(input.currentTargetKey);
    const [access, setAccess] = React.useState<ComputerAccessV1>(input.access ?? 'use');
    const [suggestedKey, setSuggestedKey] = React.useState<string | null>(null);
    const [sharing, setSharing] = React.useState(false);
    const [noticeCode, setNoticeCode] = React.useState<string | null>(null);
    const [openSettings, setOpenSettings] = React.useState<'idle' | 'opening' | 'opened' | 'failed'>('idle');
    const [attempt, setAttempt] = React.useState(0);
    const refusalCode = input.refusalCode;
    const requestedTarget = input.requestedTarget ?? null;
    const currentClient = React.useRef<typeof client | null>(client);
    currentClient.current = client;
    const choiceResolved = React.useRef(false);
    React.useEffect(() => {
        currentClient.current = client;
        choiceResolved.current = false;
        setSelectedKey(input.currentTargetKey);
        setAccess(input.access ?? 'use');
        setSuggestedKey(null);
        setSharing(false);
        setNoticeCode(null);
        setOpenSettings('idle');
        setState(refusalCode ? { kind: 'failed', code: refusalCode } : { kind: 'loading' });
        return () => { if (currentClient.current === client) currentClient.current = null; };
        // This state belongs to the Machine scope, not later callback or initial-choice props.
    }, [client]);
    React.useEffect(() => accountLifetime?.onRetire(() => {
        if (currentClient.current !== client) return;
        setState({ kind: 'failed', code: 'action_account_scope_changed' });
        setSharing(false);
        setSelectedKey(null);
        setSuggestedKey(null);
    }).dispose, [accountLifetime, client]);
    React.useEffect(() => {
        if (refusalCode) return undefined;
        if (!client.isCurrent()) {
            setState({ kind: 'failed', code: 'action_account_scope_changed' });
            return undefined;
        }
        let current = true;
        setState(previous => previous.kind === 'ready' ? previous : { kind: 'loading' });
        void client.listTargets().then(result => {
            if (!current || !client.isCurrent()) return;
            setState(result.ok ? { kind: 'ready', targets: result.value.targets, grants: result.value.grants, displays: result.value.displays }
                : { kind: 'failed', code: result.code });
            if (result.ok) {
                const suggested = resolveSuggestedTargetKey(result.value.targets, requestedTarget);
                setSuggestedKey(suggested);
                const initialSuggestion = !choiceResolved.current ? suggested : null;
                choiceResolved.current = true;
                setSelectedKey(current => {
                    if (current && result.value.targets.some(entry => computerTargetKeyV1(entry.target) === current)) return current;
                    // Never replace a source that disappeared with a guessed suggestion.
                    return current ? null : initialSuggestion;
                });
            }
        });
        return () => { current = false; };
    }, [attempt, client, refusalCode, requestedTarget]);
    const retry = React.useCallback(() => setAttempt(value => value + 1), []);
    const share = React.useCallback((choice?: Readonly<{ key: string; access: ComputerAccessV1 }>) => {
        // The leaf may decide the target and its access at the press (a switcher row, the display consent).
        const shareKey = choice?.key ?? selectedKey;
        const shareAccess = choice?.access ?? access;
        if (currentClient.current !== client || !client.isCurrent() || state.kind !== 'ready' || needsComputerPermission(state.grants, shareAccess)) return;
        const chosen = state.targets.find(entry => computerTargetKeyV1(entry.target) === shareKey);
        if (!chosen) return;
        if (onChosen) { onChosen(chosen, shareAccess); onClose(); return; }
        setSharing(true);
        setNoticeCode(null);
        void client.selectTarget(chosen.target, shareAccess).then(result => {
            if (currentClient.current !== client || !client.isCurrent()) return;
            setSharing(false);
            if (result.ok) { onSelected(result.value); onClose(); return; }
            setNoticeCode(result.code);
            if (result.code === 'computer_target_not_available') retry();
        });
    }, [access, client, onChosen, onClose, onSelected, retry, selectedKey, state]);
    const stopSharing = React.useCallback(() => {
        if (currentClient.current !== client || !client.isCurrent()) return;
        void client.stopSharing().then(result => {
            if (currentClient.current !== client || !client.isCurrent()) return;
            if (result.ok && result.value.status === 'dispatched') { onStoppedSharing?.(); onClose(); return; }
            setNoticeCode(result.ok ? result.value.status === 'failed' ? result.value.code : 'control_not_drained' : result.code);
        });
    }, [client, onClose, onStoppedSharing]);
    const requestSettings = React.useCallback((permission: 'capture' | 'input') => {
        if (currentClient.current !== client || !client.isCurrent()) return;
        setOpenSettings('opening');
        void client.openSettings(permission).then(result => {
            if (currentClient.current !== client || !client.isCurrent()) return;
            setOpenSettings(result.ok && result.value.status === 'dispatched' ? 'opened' : 'failed');
        });
    }, [client]);
    const recovery = React.useMemo(() => resolveComputerRecovery(state, access), [access, state]);
    return { state, selectedKey, setSelectedKey, access, setAccess, suggestedKey, sharing, noticeCode, openSettings, retry, share, stopSharing, requestSettings, recovery };
}
