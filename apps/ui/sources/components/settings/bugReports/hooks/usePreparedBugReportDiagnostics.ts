import * as React from 'react';
import { resolveBugReportLogSelection } from '@happier-dev/protocol';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { getStorage } from '@/sync/domains/state/storage';
import { loadProfile } from '@/sync/domains/state/persistence';
import { collectBugReportDiagnosticsArtifacts } from '../bugReportDiagnostics';
import { resolveBugReportAccountIdForServer } from '../bugReportSessionTarget';

type DiagnosticsResult = Awaited<ReturnType<typeof collectBugReportDiagnosticsArtifacts>>;

export function usePreparedBugReportDiagnostics(input: Parameters<typeof collectBugReportDiagnosticsArtifacts>[0]) {
    const selection = resolveBugReportLogSelection(input.logSelection);
    const kindsKey = JSON.stringify(input.acceptedKinds);
    const activeServer = getActiveServerSnapshot();
    const activeAccountId = getStorage().getState().profileScope?.accountId ?? loadProfile().id;
    const prepared = React.useMemo(() => {
        let pending: Promise<DiagnosticsResult> | null = null;
        const verifyScope = async () => {
            if (input.sessionTarget) {
                const expectedAccountId = input.sessionTarget.accountId;
                if (expectedAccountId && await resolveBugReportAccountIdForServer(input.sessionTarget.serverId) !== expectedAccountId) {
                    throw new Error('bug_report_diagnostics_scope_changed');
                }
            } else {
                const currentServer = getActiveServerSnapshot();
                const currentAccountId = getStorage().getState().profileScope?.accountId ?? loadProfile().id;
                if (currentServer.serverId !== activeServer.serverId || currentServer.generation !== activeServer.generation || currentAccountId !== activeAccountId) {
                    throw new Error('bug_report_diagnostics_scope_changed');
                }
            }
        };
        return {
            collect: async () => {
                try {
                    await verifyScope();
                    if (!pending) pending = collectBugReportDiagnosticsArtifacts(input);
                    const result = await pending;
                    await verifyScope();
                    return result;
                } catch (error) {
                    pending = null;
                    throw error;
                }
            },
        };
    }, [
        input.includeDiagnostics, kindsKey, input.maxArtifactBytes,
        input.pastedCliDoctorSnapshotJson, input.machineDiagnosticsTimeoutMs,
        input.serverDiagnosticsTimeoutMs, input.logTailTimeoutMs, input.contextWindowMs, input.nowMs,
        input.sessionTarget?.sessionId, input.sessionTarget?.serverId,
        input.sessionTarget?.accountId, input.sessionTarget?.machineId,
        selection.daemon, selection.session, selection.provider,
        activeServer.serverId, activeServer.generation, activeAccountId,
    ]);
    const activePrepared = React.useRef(prepared);
    activePrepared.current = prepared;
    const [collected, setCollected] = React.useState<{ prepared: typeof prepared; result: DiagnosticsResult } | null>(null);
    const [scopeFailed, setScopeFailed] = React.useState<typeof prepared | null>(null);
    const collectDiagnosticsArtifacts = React.useCallback(async () => {
        const assertCurrent = () => {
            if (activePrepared.current !== prepared) {
                const error = new Error('bug_report_diagnostics_superseded');
                error.name = 'AbortError';
                throw error;
            }
        };
        try {
            assertCurrent();
            const result = await prepared.collect();
            assertCurrent();
            setScopeFailed(null);
            setCollected((current) => current?.prepared === prepared && current.result === result ? current : { prepared, result });
            return result;
        } catch (error) {
            if (activePrepared.current === prepared) {
                setCollected(null);
                setScopeFailed(prepared);
            }
            throw error;
        }
    }, [prepared]);
    return {
        collectDiagnosticsArtifacts,
        collectionStatuses: scopeFailed === prepared
            ? { scope: { status: 'unavailable' as const, detail: 'bug_report_diagnostics_scope_changed' } }
            : collected?.prepared === prepared ? collected.result.collectionStatuses : {},
    };
}
