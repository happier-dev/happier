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
    type BugReportArtifactPayload,
} from '@happier-dev/protocol';

import type { Machine } from '@/sync/domains/state/storageTypes';
import { getStorage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { serverFetch } from '@/sync/http/client';
import { machineCollectBugReportDiagnostics, machineGetBugReportLogTail } from '@/sync/ops/machines';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { getBugReportUserActionTrail } from '@/utils/system/bugReportActionTrail';
import { getBugReportLogText } from '@/utils/system/bugReportLogBuffer';

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
        latestSession: { status: 'skipped', detail: 'no recent session found' },
        serverDiagnostics: { status: 'skipped', detail: 'source kind not accepted' },
        machineDiagnostics: { status: 'skipped', detail: 'source kind not accepted' },
    };

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
        diagnosticsCollection.serverDiagnostics = { status: 'error', detail: 'server diagnostics request timed out or failed' };
        const lines = resolveBugReportServerDiagnosticsLines(contextWindowMs);
        const serverSnapshot = await runAbortableWithTimeout(async (signal) => {
            const response = await serverFetch(`/v1/diagnostics/bug-report-snapshot?lines=${lines}`, {
                method: 'GET',
                signal,
            });
            if (!response.ok) return null;
            return await response.text();
        }, serverDiagnosticsTimeoutMs);
        if (serverSnapshot) {
            const pushed = pushArtifact(artifacts, {
                filename: 'server-diagnostics.json',
                sourceKind: 'server',
                contentType: 'application/json',
                content: serverSnapshot,
            }, input);
            if (pushed) diagnosticsCollection.serverDiagnostics = { status: 'collected' };
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

    pushArtifact(artifacts, {
        filename: 'app-context.json',
        sourceKind: 'ui-mobile',
        contentType: 'application/json',
        content: JSON.stringify({
            collectedAt: new Date().toISOString(),
            environment,
            server: {
                ...snapshot,
                serverUrl: sanitizeBugReportUrl(snapshot.serverUrl) ?? snapshot.serverUrl,
            },
            diagnosticsCollection,
        }, null, 2),
    }, input);

    return {
        artifacts,
        environment,
    };
}
