import Constants from 'expo-constants';
import { Platform } from 'react-native';
import {
    hasAcceptedBugReportArtifactKind,
    inferBugReportDeploymentTypeFromServerUrl as inferDeploymentType,
    pushBugReportArtifact,
    resolveBugReportServerDiagnosticsLines,
    sanitizeBugReportDaemonDiagnosticsPayload,
    sanitizeBugReportArtifactFileSegment,
    sanitizeBugReportArtifactPath,
    sanitizeBugReportStackContextPayload,
    sanitizeBugReportUrl,
    parseDoctorSnapshotSafe,
    type BugReportArtifactPayload,
} from '@happier-dev/protocol';

import type { Machine } from '@/sync/domains/state/storageTypes';
import { getStorage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { loadProfile, loadSyncReliabilityEvents } from '@/sync/domains/state/persistence';
import { serverFetch } from '@/sync/http/client';
import { machineCollectBugReportDiagnostics, machineGetBugReportLogTail } from '@/sync/ops/machines';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { getBugReportUserActionTrail } from '@/utils/system/bugReportActionTrail';
import { getBugReportLogText } from '@/utils/system/bugReportLogBuffer';
import { peekPreRestartBugReportSnapshot } from '@/utils/system/preRestartBugReportSnapshot';

import type { BugReportDeploymentType } from './bugReportFallback';
import { resolvePositiveInt, runAbortableWithTimeout, runWithTimeout } from './bugReportAsync';
import { buildLatestSessionSnapshot } from './bugReportSessionSnapshot';

export type BugReportDiagnosticsArtifact = BugReportArtifactPayload;

type DiagnosticsCollectionStatus = 'collected' | 'skipped' | 'error';

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

function toSanitizedLogFilename(path: string, fallback: string): string {
    const basename = sanitizeBugReportArtifactPath(path) ?? fallback;
    return sanitizeBugReportArtifactFileSegment(basename);
}

export async function collectBugReportDiagnosticsArtifacts(input: {
    machines: Machine[];
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
    const appVersion = Constants.expoConfig?.version ?? 'unknown';
    const platform = Platform.OS;
    const osVersion = typeof Platform.Version === 'string' ? Platform.Version : String(Platform.Version ?? '');
    const deviceModel = Constants.deviceName ?? undefined;

    const environment = {
        appVersion,
        platform,
        osVersion: osVersion || undefined,
        deviceModel,
        serverUrl: sanitizeBugReportUrl(snapshot.serverUrl),
        serverVersion: undefined,
        deploymentType: inferDeploymentType(snapshot.serverUrl),
    } as const;

    if (!input.includeDiagnostics) {
        return {
            artifacts: [],
            environment,
        };
    }

    const artifacts: BugReportDiagnosticsArtifact[] = [];
    const machineDiagnosticsTimeoutMs = resolvePositiveInt(input.machineDiagnosticsTimeoutMs, 4_000, 100, 30_000);
    const serverDiagnosticsTimeoutMs = resolvePositiveInt(input.serverDiagnosticsTimeoutMs, 4_000, 100, 30_000);
    const logTailTimeoutMs = resolvePositiveInt(input.logTailTimeoutMs, 4_000, 100, 30_000);
    const nowMs = resolvePositiveInt(input.nowMs, Date.now(), 0, Number.MAX_SAFE_INTEGER);
    const contextWindowMs = resolvePositiveInt(input.contextWindowMs, 30 * 60 * 1_000, 1_000, 24 * 60 * 60 * 1_000);
    const sinceMs = nowMs - contextWindowMs;
    const diagnosticsCollection: Record<string, DiagnosticsCollectionEntry> = {
        appLogs: { status: 'skipped', detail: 'no app logs collected' },
        userActions: { status: 'skipped', detail: 'no recent user actions' },
        preRestartSnapshot: { status: 'skipped', detail: 'no pre-restart snapshot found' },
        latestSession: { status: 'skipped', detail: 'no recent session found' },
        syncReliability: { status: 'skipped', detail: 'no persisted sync reliability events' },
        syncPerformance: { status: 'skipped', detail: 'sync performance telemetry disabled or empty' },
        serverDiagnostics: { status: 'skipped', detail: 'source kind not accepted' },
        machineDiagnostics: { status: 'skipped', detail: 'source kind not accepted' },
        pastedCliDoctorSnapshot: { status: 'skipped', detail: 'no pasted snapshot' },
    };

    const preRestart = await peekPreRestartBugReportSnapshot();
    if (preRestart) {
        let pushedAny = false;
        pushedAny = pushArtifact(artifacts, {
            filename: 'pre-restart-crash.txt',
            sourceKind: 'ui-mobile',
            contentType: 'text/plain',
            content: preRestart.errorDetails,
        }, input) || pushedAny;
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

    const storageState = getStorage().getState();
    const latestSessionSnapshot = buildLatestSessionSnapshot({
        sessions: storageState.sessions,
        sessionMessages: storageState.sessionMessages,
        sessionPending: storageState.sessionPending,
    });
    if (latestSessionSnapshot) {
        const pushed = pushArtifact(artifacts, {
            filename: 'latest-session-summary.json',
            sourceKind: 'ui-mobile',
            contentType: 'application/json',
            content: JSON.stringify({
                capturedAt: new Date().toISOString(),
                latestSession: latestSessionSnapshot,
            }, null, 2),
        }, input);
        if (pushed) diagnosticsCollection.latestSession = { status: 'collected' };
    }

    if (hasAcceptedBugReportArtifactKind(input.acceptedKinds, 'server')) {
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
    const allowStackDiagnostics = hasAcceptedBugReportArtifactKind(input.acceptedKinds, 'stack-service');
    const collectMachineDiagnostics = allowDaemonDiagnostics || allowStackDiagnostics;
    const onlineMachines = collectMachineDiagnostics
        ? input.machines.filter((machine) => isMachineOnline(machine)).slice(0, 3)
        : [];
    if (collectMachineDiagnostics) {
        diagnosticsCollection.machineDiagnostics = onlineMachines.length > 0
            ? { status: 'error', detail: 'machine diagnostics request timed out or failed' }
            : { status: 'skipped', detail: 'no online machines available' };
    }

    for (const machine of onlineMachines) {
        const machineIdSlug = sanitizeBugReportArtifactFileSegment(machine.id);
        const diagnostics = await runWithTimeout(
            async () => await machineCollectBugReportDiagnostics(machine.id, { timeoutMs: machineDiagnosticsTimeoutMs }),
            machineDiagnosticsTimeoutMs,
        );
        if (!diagnostics) continue;
        diagnosticsCollection.machineDiagnostics = { status: 'collected' };

        if (allowDaemonDiagnostics) {
            const daemonDiagnostics = sanitizeBugReportDaemonDiagnosticsPayload(diagnostics);
            pushArtifact(artifacts, {
                filename: `${machineIdSlug}-daemon-summary.json`,
                sourceKind: 'daemon',
                contentType: 'application/json',
                content: JSON.stringify({
                    machineId: machine.id,
                    diagnostics: daemonDiagnostics,
                }, null, 2),
            }, input);

            const doctorSnapshot = (diagnostics as { doctorSnapshot?: unknown }).doctorSnapshot;
            if (doctorSnapshot) {
                pushArtifact(artifacts, {
                    filename: `${machineIdSlug}-cli-doctor-snapshot.json`,
                    sourceKind: 'daemon',
                    contentType: 'application/json',
                    content: JSON.stringify({
                        machineId: machine.id,
                        doctorSnapshot,
                    }, null, 2),
                }, input);
            }
        }

        if (allowStackDiagnostics && diagnostics.stackContext) {
            const stackContext = sanitizeBugReportStackContextPayload(diagnostics.stackContext);
            pushArtifact(artifacts, {
                filename: `${machineIdSlug}-stack-context.json`,
                sourceKind: 'stack-service',
                contentType: 'application/json',
                content: JSON.stringify({
                    machineId: machine.id,
                    stackContext,
                }, null, 2),
            }, input);

            if (diagnostics.stackContext.runtimeState) {
                pushArtifact(artifacts, {
                    filename: `${machineIdSlug}-stack-runtime.json`,
                    sourceKind: 'stack-service',
                    contentType: 'application/json',
                    content: diagnostics.stackContext.runtimeState,
                }, input);
            }
        }

        if (allowDaemonDiagnostics) {
            const candidatePaths = new Set<string>();
            if (diagnostics.daemonState?.daemonLogPath) {
                candidatePaths.add(diagnostics.daemonState.daemonLogPath);
            }
            for (const log of diagnostics.daemonLogs) {
                if (log.path) candidatePaths.add(log.path);
            }

            const logPaths = Array.from(candidatePaths).slice(0, 2);
            for (const logPath of logPaths) {
                const tail = await runWithTimeout(
                    async () => await machineGetBugReportLogTail(machine.id, {
                        path: logPath,
                        maxBytes: Math.min(120_000, input.maxArtifactBytes),
                    }, { timeoutMs: logTailTimeoutMs }),
                    logTailTimeoutMs,
                );
                if (!tail || !tail.ok) continue;

                pushArtifact(artifacts, {
                    filename: `${machineIdSlug}-${toSanitizedLogFilename(logPath, 'daemon.log')}.log`,
                    sourceKind: 'daemon',
                    contentType: 'text/plain',
                    content: tail.tail,
                }, input);
            }
        }

        if (allowStackDiagnostics) {
            const stackLogPaths = diagnostics.stackContext?.logCandidates ?? [];
            for (const stackLogPath of stackLogPaths.slice(0, 2)) {
                const stackTail = await runWithTimeout(
                    async () => await machineGetBugReportLogTail(machine.id, {
                        path: stackLogPath,
                        maxBytes: Math.min(150_000, input.maxArtifactBytes),
                    }, { timeoutMs: logTailTimeoutMs }),
                    logTailTimeoutMs,
                );
                if (!stackTail || !stackTail.ok) continue;

                pushArtifact(artifacts, {
                    filename: `${machineIdSlug}-stack-${toSanitizedLogFilename(stackLogPath, 'stack.log')}.log`,
                    sourceKind: 'stack-service',
                    contentType: 'text/plain',
                    content: stackTail.tail,
                }, input);
            }
        }
    }

    if (allowDaemonDiagnostics) {
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
            profile: (() => {
                const profile = loadProfile();
                return {
                    id: profile.id,
                    username: profile.username,
                    linkedProviderIds: Array.from(new Set(
                        (profile.linkedProviders ?? [])
                            .map((provider) => String((provider as { id?: unknown }).id ?? '').trim())
                            .filter(Boolean),
                    )),
                };
            })(),
            server: {
                ...snapshot,
                serverUrl: sanitizeBugReportUrl(snapshot.serverUrl) ?? snapshot.serverUrl,
            },
            serverProfiles: listServerProfiles().map((profile) => ({
                id: profile.id,
                name: profile.name,
                source: profile.source ?? null,
                serverUrl: sanitizeBugReportUrl(profile.serverUrl) ?? profile.serverUrl,
                lastUsedAt: profile.lastUsedAt,
            })),
            diagnosticsCollection,
        }, null, 2),
    }, input);

    return {
        artifacts,
        environment,
    };
}
