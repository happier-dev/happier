import { describe, expect, it } from 'vitest';

import type { TranscriptMeasurementHostContentSizeObservation } from '@/components/sessions/transcript/measurement/transcriptMeasurementHost';

import {
    applyTranscriptContentSizeObservation,
    applyTranscriptLayoutObservation,
    type TranscriptContentSizeObservationApplierEffects,
    type TranscriptLayoutObservationApplierEffects,
} from './layoutContentSizeObservationApplier';

function layoutEffects(log: string[]): TranscriptLayoutObservationApplierEffects {
    return {
        commitLayoutHeight(height) {
            log.push(`commit-layout:${height}`);
        },
        observeMountSettleMetrics() {
            log.push('mount-settle');
        },
        recordLayoutMeasuredTelemetry(input) {
            log.push(`layout-telemetry:${input.layoutHeight}:${input.contentHeight}`);
        },
        recordNativeVisibleWindowTelemetry(reason, input) {
            log.push(`visible-window:${reason}:${input.layoutHeight}:${input.contentHeight}`);
        },
        runEntryRestoreAttempt() {
            log.push('entry-restore');
        },
    };
}

function measuredObservation(
    overrides: Partial<Extract<TranscriptMeasurementHostContentSizeObservation, { status: 'measured' }>> = {},
): TranscriptMeasurementHostContentSizeObservation {
    return {
        status: 'measured',
        contentHeightChanged: true,
        contentHeightGrew: true,
        measuredContentHeight: 1200,
        previousMeasuredContentHeight: 900,
        reason: 'stream-append',
        ...overrides,
    };
}

function contentSizeEffects(log: string[]): TranscriptContentSizeObservationApplierEffects {
    return {
        commitContentHeight(height) {
            log.push(`commit-content:${height}`);
        },
        observeMountSettleMetrics() {
            log.push('mount-settle');
        },
        recordContentMeasuredTelemetry(input) {
            log.push(`content-telemetry:${input.reason}:${input.layoutHeight}:${input.contentHeight}`);
        },
        recordNativeVisibleWindowTelemetry(reason, input) {
            log.push(`visible-window:${reason}:${input.layoutHeight}:${input.contentHeight}`);
        },
        runEntryRestoreAttempt() {
            log.push('entry-restore');
        },
    };
}

describe('renderer-owned layout/content-size observation applier', () => {
    it('applies native layout facts and entry restore without an app follow write', () => {
        const log: string[] = [];

        expect(applyTranscriptLayoutObservation({
            contentHeight: 1200,
            layoutHeight: 800,
            layoutHeightChanged: true,
            platformOS: 'ios',
            shouldRestoreNativeEntry: true,
        }, layoutEffects(log))).toBe(true);

        expect(log).toEqual([
            'commit-layout:800',
            'layout-telemetry:800:1200',
            'visible-window:layout-change:800:1200',
            'mount-settle',
            'entry-restore',
        ]);
    });

    it('applies web layout facts without native entry restore', () => {
        const log: string[] = [];

        applyTranscriptLayoutObservation({
            contentHeight: 0,
            layoutHeight: 600,
            layoutHeightChanged: false,
            platformOS: 'web',
            shouldRestoreNativeEntry: true,
        }, layoutEffects(log));

        expect(log).toEqual([
            'commit-layout:600',
            'visible-window:layout-change:600:0',
            'mount-settle',
        ]);
    });

    it('ignores non-finite layout height', () => {
        const log: string[] = [];

        expect(applyTranscriptLayoutObservation({
            contentHeight: 1200,
            layoutHeight: Number.NaN,
            layoutHeightChanged: true,
            platformOS: 'ios',
            shouldRestoreNativeEntry: true,
        }, layoutEffects(log))).toBe(false);
        expect(log).toEqual([]);
    });

    it('applies native content facts and entry restore without materialization pin planning', () => {
        const log: string[] = [];

        expect(applyTranscriptContentSizeObservation({
            layoutHeight: 800,
            observation: measuredObservation(),
            platformOS: 'ios',
            shouldRestoreNativeEntry: true,
        }, contentSizeEffects(log))).toBe(true);

        expect(log).toEqual([
            'commit-content:1200',
            'content-telemetry:stream-append:800:1200',
            'visible-window:stream-append:800:1200',
            'mount-settle',
            'entry-restore',
        ]);
    });

    it('keeps unchanged content observations observable without growth telemetry', () => {
        const log: string[] = [];

        applyTranscriptContentSizeObservation({
            layoutHeight: 800,
            observation: measuredObservation({
                contentHeightChanged: false,
                contentHeightGrew: false,
                reason: 'content-size-change',
            }),
            platformOS: 'web',
            shouldRestoreNativeEntry: true,
        }, contentSizeEffects(log));

        expect(log).toEqual([
            'commit-content:1200',
            'visible-window:content-size-change:800:1200',
            'mount-settle',
        ]);
    });

    it('ignores ignored content-size observations', () => {
        const log: string[] = [];

        expect(applyTranscriptContentSizeObservation({
            layoutHeight: 800,
            observation: { status: 'ignored' },
            platformOS: 'ios',
            shouldRestoreNativeEntry: true,
        }, contentSizeEffects(log))).toBe(false);
        expect(log).toEqual([]);
    });
});
