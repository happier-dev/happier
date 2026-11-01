import Constants from 'expo-constants';
import { Platform } from 'react-native';
import {
    hasAcceptedBugReportArtifactKind,
    BUG_REPORT_LOG_SOURCE_KINDS,
    inferBugReportDeploymentTypeFromServerUrl as inferDeploymentType,
    pushBugReportArtifact,
    resolveBugReportServerDiagnosticsLines,
    sanitizeBugReportArtifactFileSegment,
    sanitizeBugReportUrl,
    parseDoctorSnapshotSafe,
    resolveBugReportLogSelection,
    type BugReportLogSelection,
    type BugReportArtifactPayload,
} from '@happier-dev/protocol';

import type { Machine } from '@/sync/domains/state/storageTypes';
import { getStorage } from '@/sync/domains/state/storage';
import { resolveSessionMachineId } from '@/sync/domains/session/directSessions/resolveSessionMachineId';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { loadProfile, loadSyncReliabilityEvents } from '@/sync/domains/state/persistence';
import { serverFetch } from '@/sync/http/client';
import { machineCollectBugReportDiagnostics } from '@/sync/ops/machines';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { getBugReportUserActionTrail } from '@/utils/system/bugReportActionTrail';
import { getBugReportLogText } from '@/utils/system/bugReportLogBuffer';
import { peekPreRestartBugReportSnapshot } from '@/utils/system/preRestartBugReportSnapshot';

import type { BugReportDeploymentType } from './bugReportFallback';
import { resolvePositiveInt, runAbortableWithTimeout, runWithTimeout } from './bugReportAsync';
import { buildSelectedSessionSnapshot } from './bugReportSessionSnapshot';

export type BugReportDiagnosticsArtifact = BugReportArtifactPayload;

type DiagnosticsCollectionStatus = 'collected' | 'skipped' | 'error' | 'unavailable' | 'disabled' | 'unsupported';

export type BugReportSessionTarget = Readonly<{
    sessionId: string;
    serverId: string;
    accountId?: string | null;
    machineId?: string | null;
}>;

type DiagnosticsCollectionEntry = {
    status: DiagnosticsCollectionStatus;
    detail?: string;
};

function pushArtifact(list: BugReportDiagnosticsArtifact[], artifact: BugReportDiagnosticsArtifact, options: {
    maxArtifactBytes: number;
    acceptedKinds: string[];
}): boolean {
    const before = list.length;
    pushBugReportArtifact(list, artifact, options);
    return list.length > before;
}

export async function collectBugReportDiagnosticsArtifacts(input: {
    machines: Machine[];
    sessionTarget?: BugReportSessionTarget | null;
    logSelection?: BugReportLogSelection;
    includeDiagnostics: boolean;
    acceptedKinds: string[];
    maxArtifactBytes: number;
    pastedCliDoctorSnapshotJson?: string;
    machineDiagnosticsTimeoutMs?: number;
    serverDiagnosticsTimeoutMs?: number;
    logTailTimeoutMs?: number;
    contextWindowMs?: number;
    nowMs?: number;
}): Promise<{
    artifacts: BugReportDiagnosticsArtifact[];
    collectionStatuses: Record<string, DiagnosticsCollectionEntry>;
    environment: {
        appVersion: string;
        platform: string;
        osVersion?: string;
        deviceModel?: string;
        serverUrl?: string;
        serverVersion?: string;
        deploymentType: BugReportDeploymentType;
    };
}> {
    const snapshot = getActiveServerSnapshot();
    const storageState = getStorage().getState();
    const profile = loadProfile();
    const serverProfiles = listServerProfiles();
    const sessionTarget = input.sessionTarget ? { ...input.sessionTarget } : null;
    const serverId = sessionTarget?.serverId ?? snapshot.serverId;
    const accountId = sessionTarget?.accountId !== undefined
        ? sessionTarget.accountId
        : (serverId === snapshot.serverId ? storageState.profileScope?.accountId ?? profile.id : null);
    const serverProfile = serverProfiles.find((entry) => entry.id === serverId);
    const targetServerUrl = serverId === snapshot.serverId ? snapshot.serverUrl : serverProfile?.serverUrl;
    const logSelection = resolveBugReportLogSelection(input.logSelection);
    const machineLogSelection = {
        daemon: logSelection.daemon && hasAcceptedBugReportArtifactKind(input.acceptedKinds, BUG_REPORT_LOG_SOURCE_KINDS.daemon),
        session: logSelection.session && hasAcceptedBugReportArtifactKind(input.acceptedKinds, BUG_REPORT_LOG_SOURCE_KINDS.session),
        provider: logSelection.provider && hasAcceptedBugReportArtifactKind(input.acceptedKinds, BUG_REPORT_LOG_SOURCE_KINDS.provider),
    };
    const canCollectLocalLogs = !sessionTarget || (serverId === snapshot.serverId && accountId === profile.id);
    const scopedSession = sessionTarget
        ? storageState.sessionListViewDataByServerId?.[serverId]?.find((entry) => entry.type === 'session' && entry.session.id === sessionTarget.sessionId)
        : null;
    const hydratedSession = sessionTarget
        && serverId === (storageState.profileScope?.serverId ?? snapshot.serverId)
        && accountId === (storageState.profileScope?.accountId ?? profile.id)
        ? storageState.sessions[sessionTarget.sessionId]
        : null;
    const targetMachineId = sessionTarget?.machineId
        ?? resolveSessionMachineId(hydratedSession?.metadata)
        ?? resolveSessionMachineId(scopedSession?.type === 'session' ? scopedSession.session.metadata : null);
    const appVersion = Constants.expoConfig?.version ?? 'unknown';
    const platform = Platform.OS;
    const osVersion = typeof Platform.Version === 'string' ? Platform.Version : String(Platform.Version ?? '');
    const deviceModel = Constants.deviceName ?? undefined;

    const environment = {
        appVersion,
        platform,
        osVersion: osVersion || undefined,
        deviceModel,
        serverUrl: sanitizeBugReportUrl(targetServerUrl),
        serverVersion: undefined,
        deploymentType: inferDeploymentType(targetServerUrl ?? ''),
    } as const;

    if (!input.includeDiagnostics) {
        return {
            artifacts: [],
            collectionStatuses: {},
            environment,
        };
    }

    const artifacts: BugReportDiagnosticsArtifact[] = [];
    const machineDiagnosticsTimeoutMs = resolvePositiveInt(input.machineDiagnosticsTimeoutMs, 4_000, 100, 30_000);
    const serverDiagnosticsTimeoutMs = resolvePositiveInt(input.serverDiagnosticsTimeoutMs, 4_000, 100, 30_000);
    const nowMs = resolvePositiveInt(input.nowMs, Date.now(), 0, Number.MAX_SAFE_INTEGER);
    const contextWindowMs = resolvePositiveInt(input.contextWindowMs, 30 * 60 * 1_000, 1_000, 24 * 60 * 60 * 1_000);
    const sinceMs = nowMs - contextWindowMs;
    const diagnosticsCollection: Record<string, DiagnosticsCollectionEntry> = {
        appLogs: { status: 'skipped', detail: 'no app logs collected' },
        userActions: { status: 'skipped', detail: 'no recent user actions' },
        preRestartSnapshot: { status: 'skipped', detail: 'no pre-restart snapshot found' },
        selectedSession: { status: 'skipped', detail: 'no session selected' },
        daemon: logSelection.daemon ? { status: 'unavailable', detail: sessionTarget ? 'no machine diagnostics available' : 'no selected computer' } : { status: 'disabled' },
        session: logSelection.session ? { status: 'unavailable', detail: sessionTarget ? 'selected session logs unavailable' : 'no session selected' } : { status: 'disabled' },
        provider: logSelection.provider ? { status: 'unavailable', detail: sessionTarget ? 'selected provider logs unavailable' : 'no session selected' } : { status: 'disabled' },
        syncReliability: { status: 'skipped', detail: 'no persisted sync reliability events' },
        syncPerformance: { status: 'skipped', detail: 'sync performance telemetry disabled or empty' },
        serverDiagnostics: { status: 'skipped', detail: sessionTarget ? 'source kind not accepted or selected server/account unavailable' : 'no session selected' },
        machineDiagnostics: { status: 'skipped', detail: 'source kind not accepted' },
        pastedCliDoctorSnapshot: { status: 'skipped', detail: 'no pasted snapshot' },
    };
    for (const kind of ['daemon', 'session', 'provider'] as const) {
        if (logSelection[kind] && !machineLogSelection[kind]) {
            diagnosticsCollection[kind] = { status: 'disabled', detail: 'artifact source kind not accepted by the server' };
        }
    }

    if (logSelection.daemon && canCollectLocalLogs) {
        const preRestart = await peekPreRestartBugReportSnapshot();
        if (preRestart) {
            let pushedAny = false;
            // The composer owns the editable exception text. Reattaching the saved original here
            // would silently undo the user's edits/redactions in the report fields.
            pushedAny = pushArtifact(artifacts, {
                filename: 'pre-restart-app-console.log',
                sourceKind: 'ui-mobile',
                contentType: 'text/plain',
                content: preRestart.appLogs,
            }, input) || pushedAny;
            if (preRestart.userActions.length > 0) {
                pushedAny = pushArtifact(artifacts, {
                    filename: 'pre-restart-user-action-trail.json',
                    sourceKind: 'ui-mobile',
                    contentType: 'application/json',
                    content: JSON.stringify({
                        capturedAt: new Date(preRestart.createdAtMs).toISOString(),
                        actionCount: preRestart.userActions.length,
                        actions: preRestart.userActions,
                    }, null, 2),
                }, input) || pushedAny;
            }
            if (pushedAny) {
                diagnosticsCollection.preRestartSnapshot = { status: 'collected' };
            } else {
                diagnosticsCollection.preRestartSnapshot = { status: 'skipped', detail: 'pre-restart snapshot was empty after trimming/redaction' };
            }
        }

        const appLogs = getBugReportLogText(input.maxArtifactBytes, { sinceMs });
        if (appLogs.trim()) {
            const pushed = pushArtifact(artifacts, {
                filename: 'app-console.log',
                sourceKind: 'ui-mobile',
                contentType: 'text/plain',
                content: appLogs,
            }, input);
            if (pushed) diagnosticsCollection.appLogs = { status: 'collected' };
        }

        const userActions = getBugReportUserActionTrail({ sinceMs });
        if (userActions.length > 0) {
            const pushed = pushArtifact(artifacts, {
                filename: 'user-action-trail.json',
                sourceKind: 'ui-mobile',
                contentType: 'application/json',
                content: JSON.stringify({
                    capturedAt: new Date().toISOString(),
                    actionCount: userActions.length,
                    actions: userActions,
                }, null, 2),
            }, input);
            if (pushed) diagnosticsCollection.userActions = { status: 'collected' };
        }

        try {
            const syncReliabilityEvents = loadSyncReliabilityEvents()
                .filter((event) => event.atMs >= sinceMs);
            if (syncReliabilityEvents.length > 0) {
                const pushed = pushArtifact(artifacts, {
                    filename: 'sync-reliability-events.json',
                    sourceKind: 'ui-mobile',
                    contentType: 'application/json',
                    content: JSON.stringify({
                        capturedAt: new Date(nowMs).toISOString(),
                        contextWindowMs,
                        eventCount: syncReliabilityEvents.length,
                        events: syncReliabilityEvents,
                    }, null, 2),
                }, input);
                if (pushed) {
                    diagnosticsCollection.syncReliability = { status: 'collected' };
                } else {
                    diagnosticsCollection.syncReliability = { status: 'skipped', detail: 'source kind not accepted or artifact was empty' };
                }
            }
        } catch {
            diagnosticsCollection.syncReliability = { status: 'error', detail: 'failed to read persisted sync reliability events' };
        }

        try {
            if (syncPerformanceTelemetry.isEnabled()) {
                const syncPerformanceSnapshot = syncPerformanceTelemetry.snapshot();
                if (syncPerformanceSnapshot.events.length > 0) {
                    const pushed = pushArtifact(artifacts, {
                        filename: 'sync-performance-telemetry.json',
                        sourceKind: 'ui-mobile',
                        contentType: 'application/json',
                        content: JSON.stringify({
                            capturedAt: new Date(nowMs).toISOString(),
                            eventCount: syncPerformanceSnapshot.events.length,
                            telemetry: syncPerformanceSnapshot,
                        }, null, 2),
                    }, input);
                    if (pushed) {
                        diagnosticsCollection.syncPerformance = { status: 'collected' };
                    } else {
                        diagnosticsCollection.syncPerformance = { status: 'skipped', detail: 'source kind not accepted or artifact was empty' };
                    }
                }
            }
        } catch {
            diagnosticsCollection.syncPerformance = { status: 'error', detail: 'failed to read sync performance telemetry snapshot' };
        }

    }

    const selectedSessionSnapshot = sessionTarget && hydratedSession ? buildSelectedSessionSnapshot({
        sessionId: sessionTarget.sessionId,
        sessions: { [hydratedSession.id]: hydratedSession },
        sessionMessages: storageState.sessionMessages,
        sessionPending: storageState.sessionPending,
    }) : null;
    if (sessionTarget) {
        const pushed = pushArtifact(artifacts, {
            filename: 'selected-session-summary.json',
            sourceKind: 'ui-mobile',
            contentType: 'application/json',
            content: JSON.stringify({
                serverId,
                accountId,
                sessionId: sessionTarget.sessionId,
                machineId: targetMachineId ?? null,
                summary: selectedSessionSnapshot,
            }, null, 2),
        }, input);
        if (pushed) diagnosticsCollection.selectedSession = { status: 'collected' };
    }

    if (sessionTarget && logSelection.daemon && canCollectLocalLogs && serverId === snapshot.serverId && getActiveServerSnapshot().generation === snapshot.generation && hasAcceptedBugReportArtifactKind(input.acceptedKinds, 'server')) {
        const lines = resolveBugReportServerDiagnosticsLines(contextWindowMs);
        const serverSnapshot = await runAbortableWithTimeout(async (signal) => {
            const response = await serverFetch(`/v1/diagnostics/bug-report-snapshot?lines=${lines}`, {
                method: 'GET',
                signal,
            });
            if (response.ok) {
                return { status: 'ok' as const, body: await response.text() };
            }
            return { status: 'error' as const, httpStatus: response.status };
        }, serverDiagnosticsTimeoutMs);
        if (serverSnapshot?.status === 'ok') {
            const pushed = pushArtifact(artifacts, {
                filename: 'server-diagnostics.json',
                sourceKind: 'server',
                contentType: 'application/json',
                content: serverSnapshot.body,
            }, input);
            if (pushed) diagnosticsCollection.serverDiagnostics = { status: 'collected' };
        } else if (serverSnapshot?.status === 'error' && serverSnapshot.httpStatus === 404) {
            diagnosticsCollection.serverDiagnostics = { status: 'skipped', detail: 'server diagnostics endpoint disabled (404)' };
        } else if (serverSnapshot?.status === 'error') {
            diagnosticsCollection.serverDiagnostics = { status: 'error', detail: `server responded with status ${serverSnapshot.httpStatus ?? 'unknown'}` };
        } else {
            diagnosticsCollection.serverDiagnostics = { status: 'error', detail: 'server diagnostics request timed out or failed' };
        }
    }

    const allowDaemonDiagnostics = hasAcceptedBugReportArtifactKind(input.acceptedKinds, 'daemon');
    const collectMachineDiagnostics = hasAcceptedBugReportArtifactKind(input.acceptedKinds, 'stack-service', ...Object.values(BUG_REPORT_LOG_SOURCE_KINDS));
    // A selected session has exactly one machine authority. Missing metadata or an
    // unavailable machine must never redirect collection to an unrelated machine.
    const machineIds = collectMachineDiagnostics && accountId && sessionTarget && targetMachineId
        ? [targetMachineId]
        : [];
    if (collectMachineDiagnostics) {
        diagnosticsCollection.machineDiagnostics = machineIds.length > 0
            ? { status: 'error', detail: 'machine diagnostics request timed out or failed' }
            : { status: 'skipped', detail: !accountId ? 'selected account unavailable' : sessionTarget ? 'selected session machine unavailable' : 'no selected computer' };
    }

    for (const machineId of machineIds) {
        const machineIdSlug = sanitizeBugReportArtifactFileSegment(machineId);
        const diagnostics = await runWithTimeout(
            async () => await machineCollectBugReportDiagnostics(machineId, {
                timeoutMs: machineDiagnosticsTimeoutMs,
                serverId,
                accountId,
                sessionId: sessionTarget?.sessionId,
                logSelection: machineLogSelection,
            }),
            machineDiagnosticsTimeoutMs,
        );
        if (!diagnostics) continue;
        diagnosticsCollection.machineDiagnostics = { status: 'collected' };

        if (allowDaemonDiagnostics) {
            // Older daemons can ignore the additive exclusions. Keep their known
            // structural facts only; never serialize arbitrary runtime/doctor fields.
            pushArtifact(artifacts, {
                filename: `${machineIdSlug}-daemon-summary.json`,
                sourceKind: 'daemon',
                contentType: 'application/json',
                content: JSON.stringify({
                    machineId,
                    diagnostics: {
                        daemonState: diagnostics.daemonState ? {
                            pid: diagnostics.daemonState.pid,
                            httpPort: diagnostics.daemonState.httpPort,
                            startedAt: diagnostics.daemonState.startedAt,
                            startedWithCliVersion: diagnostics.daemonState.startedWithCliVersion,
                            hasControlToken: diagnostics.daemonState.hasControlToken,
                        } : null,
                        runtime: {
                            platform: diagnostics.runtime.platform,
                            nodeVersion: diagnostics.runtime.nodeVersion,
                        },
                    },
                }, null, 2),
            }, input);
        }

        const sessionDiagnostics = diagnostics.sessionDiagnostics;
        const matchingSession = sessionDiagnostics
            && sessionDiagnostics.context.sessionId === (sessionTarget?.sessionId ?? '')
            && (!sessionDiagnostics.context.machineId || sessionDiagnostics.context.machineId === machineId)
            && sessionDiagnostics.context.metadataStatus !== 'wrong-machine';
        for (const kind of ['daemon', 'session', 'provider'] as const) {
            if (!machineLogSelection[kind]) continue;
            if (!matchingSession) {
                diagnosticsCollection[kind] = { status: 'unsupported', detail: 'daemon did not confirm the requested log scope' };
                continue;
            }
            if (kind !== 'daemon' && (!sessionTarget || sessionDiagnostics.context.metadataStatus !== 'available')) {
                diagnosticsCollection[kind] = { status: 'unavailable', detail: 'selected session metadata unavailable' };
                continue;
            }
            const log = sessionDiagnostics.logs.find((entry) => entry.kind === kind);
            if (!log) {
                diagnosticsCollection[kind] = { status: 'unavailable', detail: 'daemon returned no collection status' };
                continue;
            }
            if (log.status === 'collected' && log.artifact) {
                const pushed = pushArtifact(artifacts, log.artifact, input);
                diagnosticsCollection[kind] = pushed ? { status: 'collected' } : { status: 'skipped', detail: 'artifact source kind not accepted or empty' };
            } else {
                diagnosticsCollection[kind] = { status: log.status === 'collected' ? 'unavailable' : log.status, detail: log.detail };
            }
        }
    }

    if (allowDaemonDiagnostics && logSelection.daemon) {
        const pasted = String(input.pastedCliDoctorSnapshotJson ?? '').trim();
        if (pasted.length > 0) {
            const parsed = parseDoctorSnapshotSafe(pasted);
            if (parsed.ok) {
                const pushed = pushArtifact(artifacts, {
                    filename: 'pasted-cli-doctor-snapshot.json',
                    sourceKind: 'daemon',
                    contentType: 'application/json',
                    content: JSON.stringify({
                        capturedAt: new Date().toISOString(),
                        doctorSnapshot: parsed.snapshot,
                    }, null, 2),
                }, input);
                if (pushed) diagnosticsCollection.pastedCliDoctorSnapshot = { status: 'collected' };
            } else {
                diagnosticsCollection.pastedCliDoctorSnapshot = { status: 'error', detail: parsed.error };
            }
        } else {
            diagnosticsCollection.pastedCliDoctorSnapshot = { status: 'skipped', detail: 'no pasted snapshot' };
        }
    }

    pushArtifact(artifacts, {
        filename: 'app-context.json',
        sourceKind: 'ui-mobile',
        contentType: 'application/json',
        content: JSON.stringify({
            collectedAt: new Date().toISOString(),
            environment,
            profile: { id: accountId },
            server: {
                serverId,
                serverUrl: sanitizeBugReportUrl(targetServerUrl),
            },
            logSelection,
            diagnosticsCollection,
        }, null, 2),
    }, input);

    return {
        artifacts,
        collectionStatuses: diagnosticsCollection,
        environment,
    };
}
