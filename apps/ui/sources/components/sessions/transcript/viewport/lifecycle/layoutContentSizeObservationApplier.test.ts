import { describe, expect, it } from 'vitest';

import type { TranscriptMeasurementHostContentSizeObservation } from '@/components/sessions/transcript/measurement/transcriptMeasurementHost';

import {
    applyTranscriptContentSizeObservation,
    applyTranscriptLayoutObservation,
    type TranscriptContentSizeObservationApplierEffects,
    type TranscriptLayoutObservationApplierEffects,
} from './layoutContentSizeObservationApplier';

function layoutEffects(log: string[]): TranscriptLayoutObservationApplierEffects<string> {
    return {
        captureNativeBottomFollowPreviousFollow() {
            log.push('capture-native-follow');
            return true;
        },
        captureWebBottomFollowPreviousMetrics() {
            log.push('capture-web-metrics');
            return 'web-before';
        },
        commitLayoutHeight(height) {
            log.push(`commit-layout:${height}`);
        },
        observeMountSettleMetrics() {
            log.push('mount-settle');
        },
        observeNativePrependOwner() {
            log.push('native-prepend');
        },
        observeWebPrependOwner() {
            log.push('web-prepend');
        },
        pinNativeInitialFollowBottomViewportIfReady(reason) {
            log.push(`initial-follow:${reason}`);
        },
        recordLayoutMeasuredTelemetry(input) {
            log.push(`layout-telemetry:${input.layoutHeight}:${input.contentHeight}`);
        },
        recordNativeVisibleWindowTelemetry(reason, input) {
            log.push(`visible-window:${reason}:${input.layoutHeight}:${input.contentHeight}`);
        },
        requestAutomaticLiveTailPin(previousWebMetrics, reason, nativePrevFollowAtBottom) {
            log.push(`auto-pin:${previousWebMetrics ?? 'null'}:${reason}:${nativePrevFollowAtBottom}`);
        },
        runEntryRestoreAttempt() {
            log.push('entry-restore');
        },
        verifyNativeSliceEntryRestoreTransaction() {
            log.push('verify-slice');
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

function contentSizeEffects(log: string[]): TranscriptContentSizeObservationApplierEffects<string> {
    return {
        captureNativeBottomFollowPreviousFollow() {
            log.push('capture-native-follow');
            return true;
        },
        captureWebBottomFollowPreviousMetrics() {
            log.push('capture-web-metrics');
            return 'web-before';
        },
        commitContentHeight(height) {
            log.push(`commit-content:${height}`);
        },
        observeMountSettleMetrics() {
            log.push('mount-settle');
        },
        observeNativePrependOwner() {
            log.push('native-prepend');
        },
        observeWebPrependOwner() {
            log.push('web-prepend');
        },
        pinNativeInitialFollowBottomViewportIfReady(reason) {
            log.push(`initial-follow:${reason}`);
        },
        prepareNativeContentMaterializationAutoPin(observation) {
            log.push(`materialization:${observation.measuredContentHeight}:${observation.reason}`);
        },
        recordContentMeasuredTelemetry(input) {
            log.push(`content-telemetry:${input.reason}:${input.layoutHeight}:${input.contentHeight}`);
        },
        recordNativeVisibleWindowTelemetry(reason, input) {
            log.push(`visible-window:${reason}:${input.layoutHeight}:${input.contentHeight}`);
        },
        observeNativeStreamAppendOffsetEscape(input) {
            log.push(`offset-escape:${input.layoutHeight}:${input.contentHeight}`);
        },
        requestAutomaticLiveTailPin(previousWebMetrics, reason, nativePrevFollowAtBottom) {
            log.push(`auto-pin:${previousWebMetrics ?? 'null'}:${reason}:${nativePrevFollowAtBottom}`);
        },
        runEntryRestoreAttempt() {
            log.push('entry-restore');
        },
        verifyNativeSliceEntryRestoreTransaction() {
            log.push('verify-slice');
        },
    };
}

describe('layout/content-size observation applier', () => {
    it('applies native layout observations in the existing owner order and requests automatic pin last', () => {
        const log: string[] = [];

        expect(applyTranscriptLayoutObservation({
            contentHeight: 1200,
            layoutHeight: 800,
            layoutHeightChanged: true,
            platformOS: 'ios',
            shouldRestoreNativeEntry: true,
        }, layoutEffects(log))).toBe(true);

        expect(log).toEqual([
            'capture-web-metrics',
            'capture-native-follow',
            'commit-layout:800',
            'layout-telemetry:800:1200',
            'visible-window:layout-change:800:1200',
            'mount-settle',
            'initial-follow:layout-change',
            'native-prepend',
            'entry-restore',
            'verify-slice',
            'auto-pin:web-before:layout-change:true',
        ]);
    });

    it('keeps renderer-owned layout size changes write-free while preserving observation side effects', () => {
        const log: string[] = [];
        const input = {
            contentHeight: 1200,
            continuousFollowOwner: 'renderer',
            layoutHeight: 800,
            layoutHeightChanged: true,
            platformOS: 'web',
            shouldRestoreNativeEntry: false,
        } as Parameters<typeof applyTranscriptLayoutObservation<string>>[0] & {
            continuousFollowOwner: 'renderer';
        };

        expect(applyTranscriptLayoutObservation(input, layoutEffects(log))).toBe(true);

        expect(log).toEqual([
            'commit-layout:800',
            'layout-telemetry:800:1200',
            'visible-window:layout-change:800:1200',
            'mount-settle',
        ]);
    });

    it('applies web layout observations without native entry restore or native prepend ownership', () => {
        const log: string[] = [];

        applyTranscriptLayoutObservation({
            contentHeight: 0,
            layoutHeight: 600,
            layoutHeightChanged: false,
            platformOS: 'web',
            shouldRestoreNativeEntry: true,
        }, layoutEffects(log));

        expect(log).toEqual([
            'capture-web-metrics',
            'capture-native-follow',
            'commit-layout:600',
            'visible-window:layout-change:600:0',
            'mount-settle',
            'initial-follow:layout-change',
            'web-prepend',
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

    it('applies native content-size observations with materialization before commit and offset escape planning before telemetry', () => {
        const log: string[] = [];

        expect(applyTranscriptContentSizeObservation({
            layoutHeight: 800,
            observation: measuredObservation(),
            platformOS: 'ios',
            shouldRestoreNativeEntry: true,
        }, contentSizeEffects(log))).toBe(true);

        expect(log).toEqual([
            'materialization:1200:stream-append',
            'capture-web-metrics',
            'capture-native-follow',
            'commit-content:1200',
            'offset-escape:800:1200',
            'content-telemetry:stream-append:800:1200',
            'visible-window:stream-append:800:1200',
            'mount-settle',
            'initial-follow:stream-append',
            'native-prepend',
            'entry-restore',
            'verify-slice',
            'auto-pin:web-before:stream-append:true',
        ]);
    });

    it('keeps renderer-owned content growth and append changes write-free while preserving measurement telemetry', () => {
        const log: string[] = [];
        const input = {
            continuousFollowOwner: 'renderer',
            layoutHeight: 800,
            observation: measuredObservation({ reason: 'stream-append' }),
            platformOS: 'web',
            shouldRestoreNativeEntry: false,
        } as Parameters<typeof applyTranscriptContentSizeObservation<string>>[0] & {
            continuousFollowOwner: 'renderer';
        };

        expect(applyTranscriptContentSizeObservation(input, contentSizeEffects(log))).toBe(true);

        expect(log).toEqual([
            'materialization:1200:stream-append',
            'commit-content:1200',
            'content-telemetry:stream-append:800:1200',
            'visible-window:stream-append:800:1200',
            'mount-settle',
        ]);
    });

    it('keeps unchanged content-size observations observable without release, telemetry, or automatic pin', () => {
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
            'materialization:1200:content-size-change',
            'capture-web-metrics',
            'capture-native-follow',
            'commit-content:1200',
            'visible-window:content-size-change:800:1200',
            'mount-settle',
            'initial-follow:content-size-change',
            'web-prepend',
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
