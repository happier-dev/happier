import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';

import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { parseSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import type { SelectionListStep } from '@/components/ui/selectionList';
import { selectLocalServiceLaunchTargets, useLocalServiceLauncherState } from '@/sync/domains/local/services/launch';
import { getStorage } from '@/sync/domains/state/storage';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { t } from '@/text';
import { getSessionName } from '@/utils/sessions/sessionUtils';

import { useSessionTerminalDescribeContext, useSessionTerminalTabDescriptors } from '../presentation/useSessionTerminalPresentation';
import { resolveSessionTerminalIdentity } from '../sessionTerminalMode';
import { readSessionTerminalWorkspaceForScope, subscribeSessionTerminalWorkspace } from '../sessionTerminalWorkspaceRuntime';
import { useTerminalSurfaceSummaries } from '../terminalSurfaceSummary';
import { buildTerminalJumpModel, readOtherSessionTerminals, selectOtherSessionTerminals, type OtherSessionTerminals } from './terminalJumpSections';
import type { TerminalJumpTarget } from './terminalJumpTarget';

export type TerminalJumpStep = Readonly<{
    step: SelectionListStep;
    /** Run the row's Action through the canonical front door; false when it did not succeed. */
    activate: (optionId: string, placement?: 'bottom' | 'details') => Promise<boolean>;
    hasOption: (optionId: string) => boolean;
}>;

const EMPTY_WORKSPACE = { v: 1 as const, tabs: [], activeTabId: null, showList: false };
const EMPTY_SET: ReadonlySet<string> = new Set();

function basename(path: string): string {
    const trimmed = path.replace(/[\\/]+$/, '');
    const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
    return index >= 0 ? trimmed.slice(index + 1) || trimmed : trimmed;
}

/**
 * The live data behind the palette's Terminals scope (terminal lab B4): the mounted pane's layout,
 * each terminal's last-known summary, the daemon's list of other sessions' PTYs (read once per
 * Jump) and, once something is typed, the session's package scripts. Inactive (`target: null`) it
 * subscribes to nothing session-specific and issues no machine RPC.
 */
export function useTerminalJumpStep(input: Readonly<{ target: TerminalJumpTarget | null; query: string }>): TerminalJumpStep | null {
    const scopeId = input.target?.scopeId ?? '';
    const parsed = scopeId ? parseSessionPaneScopeId(scopeId) : null;
    const sessionId = parsed?.sessionId ?? '';
    const serverId = parsed?.address?.serverId ?? null;
    const active = Boolean(input.target && sessionId);

    const readWorkspace = React.useCallback(() => (scopeId ? readSessionTerminalWorkspaceForScope(scopeId) : null), [scopeId]);
    const workspace = React.useSyncExternalStore(subscribeSessionTerminalWorkspace, readWorkspace, readWorkspace) ?? EMPTY_WORKSPACE;
    const context = useSessionTerminalDescribeContext(sessionId, serverId);
    const tabs = useSessionTerminalTabDescriptors({ sessionId, scopeId, workspace, context });
    const machineTarget = useSessionMachineTarget(sessionId || null, serverId);
    const machineId = machineTarget?.machineId ?? null;

    const [others, setOthers] = React.useState<OtherSessionTerminals>({ status: 'idle' });
    React.useEffect(() => {
        if (!active || !machineId) {
            setOthers({ status: 'idle' });
            return;
        }
        const controller = new AbortController();
        setOthers({ status: 'loading' });
        void readOtherSessionTerminals(machineId, serverId, controller.signal).then((next) => {
            if (!controller.signal.aborted) setOthers(next);
        });
        return () => controller.abort();
    }, [active, machineId, serverId]);

    const ownTerminalKeys = React.useMemo(() => (workspace.tabs.length === 0 ? EMPTY_SET : new Set(workspace.tabs.flatMap((tab) => tab.terminals.map((terminal) => (
        resolveSessionTerminalIdentity({ sessionId, scopeId, terminal }).terminalKey
    ))))), [scopeId, sessionId, workspace.tabs]);
    const foreign = React.useMemo(() => selectOtherSessionTerminals({ others, sessionId, ownTerminalKeys }), [others, ownTerminalKeys, sessionId]);
    const foreignKeys = React.useMemo(() => foreign.map((entry) => entry.terminalKey), [foreign]);
    const foreignSummaries = useTerminalSurfaceSummaries(foreignKeys);
    const foreignSessionIds = React.useMemo(() => [...new Set(foreign.map((entry) => entry.sessionId!))], [foreign]);
    const sessionNames: Record<string, string> = getStorage()(useShallow((state): Record<string, string> => Object.fromEntries(foreignSessionIds.map((id) => {
        const session = (state.sessions as Record<string, Parameters<typeof getSessionName>[0] | undefined>)[id];
        return [id, session ? getSessionName(session, serverId) : t('sessionsList.sessionFallbackLabel')];
    }))));

    // Package scripts are offered only for a typed query, so an empty Jump never reads the launcher.
    const wantsScripts = active && input.query.trim().length > 0;
    const launcherState = useLocalServiceLauncherState({
        machineId, serverId, sessionId: sessionId || null, scope: 'workspace',
        workspaceRoot: machineTarget?.basePath ?? null, enabled: wantsScripts,
    });
    const scripts = React.useMemo(() => (wantsScripts ? selectLocalServiceLaunchTargets(launcherState) : []), [launcherState, wantsScripts]);

    const model = React.useMemo(() => {
        const summaryByKey = new Map(foreignKeys.map((key, index) => [key, foreignSummaries[index] ?? null]));
        return buildTerminalJumpModel({
            tabs,
            workspaceTabs: workspace.tabs,
            activeTabId: workspace.activeTabId,
            sessionId,
            ownTerminalKeys,
            machineId,
            machineName: context.sessionMachineName,
            folderName: machineTarget?.basePath ? basename(machineTarget.basePath) : null,
            others,
            readSummary: (key) => summaryByKey.get(key) ?? null,
            readSessionName: (id) => sessionNames[id] ?? t('sessionsList.sessionFallbackLabel'),
            scripts,
        }, input.query);
    }, [context.sessionMachineName, foreignKeys, foreignSummaries, input.query, machineId, machineTarget?.basePath, others, ownTerminalKeys, scripts, sessionId, sessionNames, tabs, workspace.activeTabId, workspace.tabs]);

    const actionExecute = React.useMemo(() => createFrontDoorActionExecute(), []);
    const activate = React.useCallback(async (optionId: string, placement: 'bottom' | 'details' = 'bottom') => {
        const activation = model.activations.get(optionId);
        if (!activation) return false;
        const result = await actionExecute(activation.actionId, { ...activation.input, scopeId }, {
            surface: 'ui', defaultSessionId: sessionId, ...(serverId ? { serverId } : {}),
        });
        if (!result.ok) return false;
        const output = result.result;
        if (output && typeof output === 'object' && 'ok' in output && output.ok === false) return false;
        if (placement === 'details') {
            const terminalId = typeof activation.input.terminalId === 'string'
                ? activation.input.terminalId
                : output && typeof output === 'object' && 'terminalId' in output && typeof output.terminalId === 'string'
                    ? output.terminalId : null;
            if (!terminalId) return false;
            const docked = await actionExecute('session.terminals.open_in_details', { scopeId, terminalId }, {
                surface: 'ui', defaultSessionId: sessionId, ...(serverId ? { serverId } : {}),
            });
            if (!docked.ok || (docked.result && typeof docked.result === 'object' && 'ok' in docked.result && docked.result.ok === false)) return false;
        }
        return true;
    }, [actionExecute, model.activations, scopeId, serverId, sessionId]);
    const hasOption = React.useCallback((optionId: string) => model.activations.has(optionId), [model.activations]);

    return React.useMemo(() => (active ? { step: model.step, activate, hasOption } : null), [activate, active, hasOption, model.step]);
}
