import { log } from '@/log';
import type { SyncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';

import { recordNativeCryptoWorkerFallback } from './nativeCryptoWorkerTelemetry';
import {
    NATIVE_CRYPTO_WORKER_FALLBACK_REASON,
    NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON,
    NATIVE_CRYPTO_WORKER_ROUTING_DECLINE_REASON,
    type NativeCryptoWorkerFallbackReason,
    type NativeCryptoWorkerOperation,
    type NativeCryptoWorkerRoutingDeclineReason,
} from './types';

/**
 * Single owner for "this batch ran on the JS reference path" visibility.
 *
 * The native worker routes in `auto` mode, so a build whose `HappierCryptoWorker`
 * module is missing, stale, or broken silently runs every envelope open and every
 * payload decrypt on the JS thread. Degradation is therefore recorded here
 * unconditionally (counters + a first-occurrence log line per operation/reason,
 * at most one line per distinct degradation for the life of the process), and
 * verbosely when routing enables `logFallbacks`.
 *
 * Routing *declines* — mode `off`, or a batch under `minBatchSize` /
 * `minPayloadBytes` — are recorded the same way but counted separately, because
 * they are the configured answer rather than a failure. Both halves are needed to
 * answer the only question that matters from a profile: this batch ran on JS —
 * which branch put it there?
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
    telemetry?: SyncPerformanceTelemetry;
    telemetryEnabled?: boolean;
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
        // Not a degradation: this platform has no native worker, so the JS path is
        // the intended implementation. Reporting it would bury the real signal.
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

    if (params.telemetryEnabled === true && params.telemetry) {
        recordNativeCryptoWorkerFallback(params.telemetry, {
            operation: params.operation,
            reason: params.reason,
            items: params.itemCount,
            payloadBytes: params.payloadBytes,
            failureReason: lastFailureReason ?? 0,
        });
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
     * `unsupportedPlatform` means the platform ships no worker at all, so a decline
     * changed nothing and reporting it would bury the signal — exactly as for a
     * fallback on that platform.
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
