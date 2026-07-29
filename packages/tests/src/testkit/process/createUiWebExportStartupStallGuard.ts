import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve as resolvePath, relative as relativePath } from 'node:path';

import { readPositiveEnvInt, resolveUiWebExportFallbackToMetro } from './uiWebEnv';

const STARTUP_MARKER = 'Starting Metro Bundler';
const REQUIRED_PUBLISH_PHASE_FILES = new Set(['index.html', 'metadata.json']);
const UI_WEB_EXPORT_METRO_CACHE_CORRUPTION_MESSAGE =
    'expo export startup detected Metro cache corruption; retry with --clear';
const DEFAULT_UI_WEB_EXPORT_STARTUP_STALL_TIMEOUT_MS = 60_000;
const MAX_UI_WEB_EXPORT_STARTUP_STALL_TIMEOUT_MS = 60_000;

type StartupStallGuard = {
    promise: Promise<void>;
    stop: () => void;
};

type ExportProgressSnapshot = Readonly<{
    fileCount: number;
    totalBytes: number;
    latestMtimeMs: number;
    publishPhaseFileCount: number;
    sampleFiles: readonly string[];
}>;

export function stderrHasUiWebExportMetroCacheCorruption(stderrText: string): boolean {
    return stderrText.includes('Error while reading cache, falling back to a full crawl:')
        && stderrText.includes('Unable to deserialize cloned data');
}

export function isUiWebExportMetroCacheCorruptionError(error: unknown): boolean {
    return error instanceof Error && error.message === UI_WEB_EXPORT_METRO_CACHE_CORRUPTION_MESSAGE;
}

function createUiWebExportMetroCacheCorruptionError(): Error {
    const error = new Error(UI_WEB_EXPORT_METRO_CACHE_CORRUPTION_MESSAGE);
    error.name = 'UiWebExportMetroCacheCorruptionError';
    return error;
}

function normalizeAbortReason(reason: unknown, fallbackMessage: string): Error {
    if (reason instanceof Error) {
        return reason;
    }
    if (typeof reason === 'string' && reason.trim()) {
        return new Error(reason);
    }
    return new Error(fallbackMessage);
}

export function resolveUiWebExportStartupStallTimeoutMs(env: NodeJS.ProcessEnv): number {
    const requestedTimeoutMs = readPositiveEnvInt(
        env.HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_TIMEOUT_MS,
        DEFAULT_UI_WEB_EXPORT_STARTUP_STALL_TIMEOUT_MS,
    );
    if (!resolveUiWebExportFallbackToMetro(env)) {
        return requestedTimeoutMs;
    }
    // Once Expo has reached "Starting Metro Bundler", an export that produces zero staging output
    // for a full minute is not making useful progress for UI-e2e. Cap suite-local overrides so the
    // harness can fail over to Metro instead of waiting for multi-minute dead starts.
    return Math.min(requestedTimeoutMs, MAX_UI_WEB_EXPORT_STARTUP_STALL_TIMEOUT_MS);
}

function resolveUiWebExportStartupStallPollMs(env: NodeJS.ProcessEnv): number {
    return readPositiveEnvInt(env.HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_POLL_MS, 250);
}

async function readExistingFile(path: string): Promise<string> {
    return await readFile(path, 'utf8').catch(() => '');
}

async function walkProgressSnapshot(rootDir: string, currentPath: string): Promise<ExportProgressSnapshot> {
    const entryStats = await stat(currentPath).catch(() => null);
    if (!entryStats) {
        return { fileCount: 0, totalBytes: 0, latestMtimeMs: 0, publishPhaseFileCount: 0, sampleFiles: [] };
    }
    const relativePathname = relativePath(rootDir, currentPath);
    if (entryStats.isFile()) {
        return {
            fileCount: 1,
            totalBytes: entryStats.size,
            latestMtimeMs: entryStats.mtimeMs,
            publishPhaseFileCount: REQUIRED_PUBLISH_PHASE_FILES.has(relativePathname) ? 1 : 0,
            sampleFiles: [relativePath(rootDir, currentPath)],
        };
    }
    if (!entryStats.isDirectory()) {
        return { fileCount: 0, totalBytes: 0, latestMtimeMs: 0, publishPhaseFileCount: 0, sampleFiles: [] };
    }

    const entries = await readdir(currentPath, { withFileTypes: true }).catch(() => []);
    let fileCount = 0;
    let totalBytes = 0;
    let latestMtimeMs = 0;
    let publishPhaseFileCount = 0;
    const sampleFiles: string[] = [];

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        const childPath = resolvePath(currentPath, entry.name);
        const childSnapshot = await walkProgressSnapshot(rootDir, childPath);
        fileCount += childSnapshot.fileCount;
        totalBytes += childSnapshot.totalBytes;
        latestMtimeMs = Math.max(latestMtimeMs, childSnapshot.latestMtimeMs);
        publishPhaseFileCount += childSnapshot.publishPhaseFileCount;
        for (const sampleFile of childSnapshot.sampleFiles) {
            if (sampleFiles.length >= 8) break;
            sampleFiles.push(sampleFile);
        }
    }

    return { fileCount, totalBytes, latestMtimeMs, publishPhaseFileCount, sampleFiles };
}

async function readExportProgressSnapshot(stagingDir: string): Promise<ExportProgressSnapshot> {
    return await walkProgressSnapshot(stagingDir, stagingDir);
}

function didExportProgressChange(previous: ExportProgressSnapshot, next: ExportProgressSnapshot): boolean {
    if (next.publishPhaseFileCount <= 0) {
        return false;
    }
    return previous.fileCount !== next.fileCount
        || previous.totalBytes !== next.totalBytes
        || previous.latestMtimeMs !== next.latestMtimeMs
        || previous.publishPhaseFileCount !== next.publishPhaseFileCount;
}

function readLatestMetroBundleProgressToken(text: string): string | null {
    const sanitized = text.replace(/\u001b\[[0-9;]*[A-Za-z]/gu, '');
    const pattern = /Web[^\r\n]*?(\d+(?:\.\d+)?)%\s*\(\s*(\d+)\s*\/\s*(\d+)\s*\)/gu;
    let latest: string | null = null;
    for (const match of sanitized.matchAll(pattern)) {
        latest = `${match[1]}:${match[2]}:${match[3]}`;
    }
    return latest;
}

export function createUiWebExportStartupStallGuard(params: {
    stdoutPath: string;
    stderrPath: string;
    stagingDir: string;
    env: NodeJS.ProcessEnv;
    abortController: AbortController;
}): StartupStallGuard {
    const timeoutMs = resolveUiWebExportStartupStallTimeoutMs(params.env);
    const pollMs = resolveUiWebExportStartupStallPollMs(params.env);
    let interval: ReturnType<typeof setInterval> | null = null;
    let stopped = false;
    let settled = false;
    let markerSeen = false;
    let markerSeenAtMs = 0;
    let lastProgressAtMs = Date.now();
    let lastStdoutLength = 0;
    let lastStderrLength = 0;
    let lastMetroBundleProgressToken: string | null = null;
    let lastExportProgress: ExportProgressSnapshot = {
        fileCount: 0,
        totalBytes: 0,
        latestMtimeMs: 0,
        publishPhaseFileCount: 0,
        sampleFiles: [],
    };
    let resolvePromise: (() => void) | null = null;
    let rejectPromise: ((error: Error) => void) | null = null;

    const cleanup = () => {
        if (stopped) return;
        stopped = true;
        if (interval) {
            clearInterval(interval);
            interval = null;
        }
    };

    const resolveGuard = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolvePromise?.();
    };

    const rejectGuard = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectPromise?.(error);
    };

    const stop = () => {
        resolveGuard();
    };

    const promise = new Promise<void>((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
    });

    const tick = async () => {
        if (stopped) return;

        const [stdoutText, stderrText] = await Promise.all([
            readExistingFile(params.stdoutPath),
            readExistingFile(params.stderrPath),
        ]);

        if (stderrHasUiWebExportMetroCacheCorruption(stderrText)) {
            const error = createUiWebExportMetroCacheCorruptionError();
            params.abortController.abort(error);
            rejectGuard(error);
            return;
        }

        const now = Date.now();
        const previousStdoutLength = lastStdoutLength;
        const previousStderrLength = lastStderrLength;
        const logsChanged = stdoutText.length !== previousStdoutLength || stderrText.length !== previousStderrLength;
        lastStdoutLength = stdoutText.length;
        lastStderrLength = stderrText.length;

        if (!markerSeen) {
            // Avoid expensive staging scans until Metro startup is confirmed; otherwise marker detection
            // can be delayed long enough for the hard timeout to win the race.
            if (stdoutText.includes(STARTUP_MARKER) || stderrText.includes(STARTUP_MARKER)) {
                markerSeen = true;
                markerSeenAtMs = Date.now();
                lastProgressAtMs = markerSeenAtMs;
                lastMetroBundleProgressToken = readLatestMetroBundleProgressToken(`${stdoutText}\n${stderrText}`);
                lastExportProgress = await readExportProgressSnapshot(params.stagingDir);
            }
            if (logsChanged) {
                lastProgressAtMs = now;
                return;
            }
            if (now - lastProgressAtMs < timeoutMs) return;

            const error = normalizeAbortReason(
                new Error(`expo export startup stalled after ${timeoutMs}ms before ${STARTUP_MARKER}; no log output.`),
                `expo export startup stalled after ${timeoutMs}ms before ${STARTUP_MARKER}; no log output.`,
            );
            params.abortController.abort(error);
            rejectGuard(error);
            return;
        }

        const exportProgress = await readExportProgressSnapshot(params.stagingDir);
        const exportProgressChanged = didExportProgressChange(lastExportProgress, exportProgress);
        lastExportProgress = exportProgress;

        const metroBundleProgressToken = readLatestMetroBundleProgressToken(`${stdoutText}\n${stderrText}`);
        const metroBundleProgressChanged = metroBundleProgressToken !== null
            && metroBundleProgressToken !== lastMetroBundleProgressToken;
        lastMetroBundleProgressToken = metroBundleProgressToken;

        if (exportProgressChanged) {
            lastProgressAtMs = now;
            return;
        }

        if (exportProgress.publishPhaseFileCount === 0 && metroBundleProgressChanged) {
            lastProgressAtMs = now;
            return;
        }

        // Before publish output exists, allow stdout/stderr churn to extend the startup window.
        // Once staging is partial, rely on staging progress only (log churn can mask a frozen export).
        if (exportProgress.fileCount === 0 && logsChanged) {
            lastProgressAtMs = now;
            return;
        }

        if (now - lastProgressAtMs < timeoutMs) return;

        const partialSummary = exportProgress.sampleFiles.length > 0
            ? ` partial staging files=${exportProgress.sampleFiles.join(',')}`
            : ' partial staging files=<none>';
        const error = normalizeAbortReason(
            new Error(`expo export startup stalled after ${timeoutMs}ms at ${STARTUP_MARKER}; no staging progress.${partialSummary}`),
            `expo export startup stalled after ${timeoutMs}ms at ${STARTUP_MARKER}; no staging progress.${partialSummary}`,
        );
        params.abortController.abort(error);
        rejectGuard(error);
    };

    interval = setInterval(() => {
        void tick().catch((error) => {
            if (stopped) return;
            const normalized = normalizeAbortReason(error, 'Failed while monitoring expo export startup progress');
            params.abortController.abort(normalized);
            rejectGuard(normalized);
        });
    }, pollMs);

    if (typeof interval === 'object' && interval !== null && 'unref' in interval) {
        interval.unref();
    }

    return { promise, stop };
}
