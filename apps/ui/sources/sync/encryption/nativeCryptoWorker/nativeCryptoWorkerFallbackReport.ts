import { log } from '@/log';

import {
    NATIVE_CRYPTO_WORKER_FALLBACK_REASON,
    NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON,
    NATIVE_CRYPTO_WORKER_ROUTING_DECLINE_REASON,
    type NativeCryptoWorkerFallbackReason,
    type NativeCryptoWorkerOperation,
    type NativeCryptoWorkerRoutingDeclineReason,
} from './types';

/**
 * Single owner for "native crypto degraded to the JS reference path" visibility.
 *
 * The native worker routes in `auto` mode by default, so a build whose `HappierCryptoWorker` module
 * is missing, stale, or broken silently runs every envelope open and every payload decrypt on the JS
 * thread. Routing's own telemetry is opt-in (`telemetryEnabled` defaults to false) and `logFallbacks`
 * defaults to false too, which is exactly why nobody could tell from logs whether native crypto ever
 * ran. Degradation is therefore recorded here unconditionally — counters plus one log line per
 * distinct operation/reason for the life of the process — and verbosely when routing asks for it.
 */

const FALLBACK_REASONS: readonly NativeCryptoWorkerFallbackReason[] = Object.values(
    NATIVE_CRYPTO_WORKER_FALLBACK_REASON,
);

const ROUTING_DECLINE_REASONS: readonly NativeCryptoWorkerRoutingDeclineReason[] = Object.values(
    NATIVE_CRYPTO_WORKER_ROUTING_DECLINE_REASON,
);

export type NativeCryptoWorkerFallbackDiagnostics = Readonly<{
    totalFallbacks: number;
    countsByReason: Readonly<Record<NativeCryptoWorkerFallbackReason, number>>;
    lastReason: NativeCryptoWorkerFallbackReason | null;
    lastOperation: NativeCryptoWorkerOperation | null;
    lastFailureReason: number | null;
    lastDetail: string | null;
    /** Batches routing kept on JS by configuration, never handed to the worker. */
    totalRoutingDeclines: number;
    routingDeclineCountsByReason: Readonly<Record<NativeCryptoWorkerRoutingDeclineReason, number>>;
    lastRoutingDeclineReason: NativeCryptoWorkerRoutingDeclineReason | null;
    lastRoutingDeclineOperation: NativeCryptoWorkerOperation | null;
}>;

export type ReportNativeCryptoWorkerFallbackParams = Readonly<{
    operation: NativeCryptoWorkerOperation;
    reason: NativeCryptoWorkerFallbackReason;
    itemCount: number;
    payloadBytes: number;
    failureReason?: number | null;
    error?: unknown;
    /** Routing `logFallbacks`: log every degraded batch instead of only the first of its kind. */
    verbose?: boolean;
}>;

function createEmptyCounts(): Record<NativeCryptoWorkerFallbackReason, number> {
    return FALLBACK_REASONS.reduce((counts, reason) => {
        counts[reason] = 0;
        return counts;
    }, {} as Record<NativeCryptoWorkerFallbackReason, number>);
}

function createEmptyRoutingDeclineCounts(): Record<NativeCryptoWorkerRoutingDeclineReason, number> {
    return ROUTING_DECLINE_REASONS.reduce((counts, reason) => {
        counts[reason] = 0;
        return counts;
    }, {} as Record<NativeCryptoWorkerRoutingDeclineReason, number>);
}

let totalFallbacks = 0;
let countsByReason = createEmptyCounts();
let lastReason: NativeCryptoWorkerFallbackReason | null = null;
let lastOperation: NativeCryptoWorkerOperation | null = null;
let lastFailureReason: number | null = null;
let lastDetail: string | null = null;
let loggedKinds = new Set<string>();
let totalRoutingDeclines = 0;
let routingDeclineCountsByReason = createEmptyRoutingDeclineCounts();
let lastRoutingDeclineReason: NativeCryptoWorkerRoutingDeclineReason | null = null;
let lastRoutingDeclineOperation: NativeCryptoWorkerOperation | null = null;

function describeError(error: unknown): string | null {
    if (error === undefined || error === null) return null;
    const message = error instanceof Error
        ? error.message
        : typeof error === 'string'
            ? error
            : typeof (error as { message?: unknown }).message === 'string'
                ? (error as { message: string }).message
                : String(error);
    const normalized = message.replace(/\s+/gu, ' ').trim();
    return normalized ? normalized.slice(0, 200) : null;
}

export function reportNativeCryptoWorkerFallback(params: ReportNativeCryptoWorkerFallbackParams): void {
    if (params.failureReason === NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.unsupportedPlatform) {
        // Not a degradation: this platform has no native worker, so the JS path is the intended
        // implementation. Reporting it would bury the signal we actually care about.
        return;
    }

    totalFallbacks += 1;
    countsByReason[params.reason] += 1;
    lastReason = params.reason;
    lastOperation = params.operation;
    lastFailureReason = typeof params.failureReason === 'number' ? params.failureReason : null;
    lastDetail = describeError(params.error);

    const kind = `${params.operation}:${params.reason}`;
    const isFirstOfKind = !loggedKinds.has(kind);
    if (isFirstOfKind) {
        loggedKinds.add(kind);
    }
    if (isFirstOfKind || params.verbose === true) {
        const parts = [
            `⚠️ native crypto worker fell back to JS: operation=${params.operation}`,
            `reason=${params.reason}`,
            `items=${params.itemCount}`,
            `payloadBytes=${params.payloadBytes}`,
            `occurrences=${countsByReason[params.reason]}`,
        ];
        if (lastFailureReason !== null) parts.push(`failureReason=${lastFailureReason}`);
        if (lastDetail) parts.push(`detail=${lastDetail}`);
        log.log(parts.join(' '));
    }
}

export type ReportNativeCryptoWorkerRoutingDeclineParams = Readonly<{
    operation: NativeCryptoWorkerOperation;
    reason: NativeCryptoWorkerRoutingDeclineReason;
    itemCount: number;
    payloadBytes: number;
    /** The configured floor this batch failed to clear, for the threshold reasons. */
    threshold: number | null;
    /**
     * Last observed probe outcome for this worker, when routing already has one.
     * `unsupportedPlatform` means the platform ships no worker at all, so the decline
     * changed nothing and reporting it would bury the signal — as for a fallback.
     */
    lastKnownFailureReason?: number | null;
    /** Routing `logFallbacks`: log every declined batch instead of only the first of its kind. */
    verbose?: boolean;
}>;

export function reportNativeCryptoWorkerRoutingDecline(
    params: ReportNativeCryptoWorkerRoutingDeclineParams,
): void {
    if (params.lastKnownFailureReason === NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.unsupportedPlatform) {
        return;
    }

    totalRoutingDeclines += 1;
    routingDeclineCountsByReason[params.reason] += 1;
    lastRoutingDeclineReason = params.reason;
    lastRoutingDeclineOperation = params.operation;

    const kind = `decline:${params.operation}:${params.reason}`;
    const isFirstOfKind = !loggedKinds.has(kind);
    if (isFirstOfKind) {
        loggedKinds.add(kind);
    }
    if (isFirstOfKind || params.verbose === true) {
        const parts = [
            `ℹ️ native crypto worker routing kept a batch on JS: operation=${params.operation}`,
            `reason=${params.reason}`,
            `items=${params.itemCount}`,
            `payloadBytes=${params.payloadBytes}`,
            `occurrences=${routingDeclineCountsByReason[params.reason]}`,
        ];
        if (params.threshold !== null) parts.push(`threshold=${params.threshold}`);
        log.log(parts.join(' '));
    }
}

export function readNativeCryptoWorkerFallbackDiagnostics(): NativeCryptoWorkerFallbackDiagnostics {
    return {
        totalFallbacks,
        countsByReason: { ...countsByReason },
        lastReason,
        lastOperation,
        lastFailureReason,
        lastDetail,
        totalRoutingDeclines,
        routingDeclineCountsByReason: { ...routingDeclineCountsByReason },
        lastRoutingDeclineReason,
        lastRoutingDeclineOperation,
    };
}

export function resetNativeCryptoWorkerFallbackDiagnosticsForTests(): void {
    totalFallbacks = 0;
    countsByReason = createEmptyCounts();
    lastReason = null;
    lastOperation = null;
    lastFailureReason = null;
    lastDetail = null;
    loggedKinds = new Set<string>();
    totalRoutingDeclines = 0;
    routingDeclineCountsByReason = createEmptyRoutingDeclineCounts();
    lastRoutingDeclineReason = null;
    lastRoutingDeclineOperation = null;
}
