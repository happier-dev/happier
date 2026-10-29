import { describe, expect, it } from 'vitest';

import {
    resolveMachineResourcesGaugeColor,
    resolveMachineResourcesMetricAlerts,
    resolveMachineResourcesMetricTone,
    resolveMachineResourcesPresenceColor,
    resolveMachineResourcesPresenceTint,
    resolveMachineResourcesTone,
} from './machineResourcesTone';
import type { MachineResourcesSnapshot } from '@happier-dev/protocol';

function snapshot(input: Partial<{
    cpu: number;
    memory: number;
    disk: number;
}>): MachineResourcesSnapshot {
    return {
        sampledAt: 0,
        cpu: { usagePercent: input.cpu ?? 0 },
        memory: { totalBytes: 1, usedBytes: 0, usagePercent: input.memory ?? 0 },
        disk: { path: '/', totalBytes: 1, availableBytes: 1, usedBytes: 0, usagePercent: input.disk ?? 0 },
    };
}

describe('resolveMachineResourcesTone', () => {
    it('returns unknown without a snapshot', () => {
        expect(resolveMachineResourcesTone(null)).toBe('unknown');
        expect(resolveMachineResourcesTone(undefined)).toBe('unknown');
    });

    it('treats the default warning threshold as inclusive and the value below it as ok', () => {
        expect(resolveMachineResourcesTone(snapshot({ cpu: 69.9 }))).toBe('ok');
        expect(resolveMachineResourcesTone(snapshot({ cpu: 70 }))).toBe('warning');
    });

    it('treats the default danger threshold as inclusive', () => {
        expect(resolveMachineResourcesTone(snapshot({ cpu: 89.9 }))).toBe('warning');
        expect(resolveMachineResourcesTone(snapshot({ cpu: 90 }))).toBe('danger');
    });

    it('keeps ok when a single metric stays under the warning threshold', () => {
        expect(resolveMachineResourcesTone(snapshot({ cpu: 65, memory: 10, disk: 2 }))).toBe('ok');
    });

    it('promotes to warning when only one metric crosses the warning threshold', () => {
        expect(resolveMachineResourcesTone(snapshot({ cpu: 5, memory: 75, disk: 2 }))).toBe('warning');
    });

    it('takes the worst bucket across cpu, memory, and disk', () => {
        expect(resolveMachineResourcesTone(snapshot({ cpu: 5, memory: 10, disk: 95 }))).toBe('danger');
        expect(resolveMachineResourcesTone(snapshot({ cpu: 95, memory: 10, disk: 5 }))).toBe('danger');
    });

    it('honors custom thresholds', () => {
        expect(resolveMachineResourcesTone(snapshot({ cpu: 50 }), { warning: 50, danger: 80 })).toBe('warning');
        expect(resolveMachineResourcesTone(snapshot({ cpu: 50 }), { warning: 51, danger: 80 })).toBe('ok');
        expect(resolveMachineResourcesTone(snapshot({ disk: 80 }), { warning: 51, danger: 80 })).toBe('danger');
    });
});

const presenceColors = {
    status: { disconnected: '#disconnect-gray' },
    state: {
        success: { foreground: '#success-green' },
        warning: { foreground: '#warning-orange' },
        danger: { foreground: '#danger-red' },
    },
    text: { secondary: '#neutral-gray' },
};

describe('resolveMachineResourcesPresenceColor', () => {
    it('maps sampled tones onto the state color ladder with success for ok', () => {
        expect(resolveMachineResourcesPresenceColor({ online: true, tone: 'ok' }, presenceColors)).toBe('#success-green');
        expect(resolveMachineResourcesPresenceColor({ online: true, tone: 'warning' }, presenceColors)).toBe('#warning-orange');
        expect(resolveMachineResourcesPresenceColor({ online: true, tone: 'danger' }, presenceColors)).toBe('#danger-red');
    });

    it('keeps an online machine without a sample neutral gray', () => {
        expect(resolveMachineResourcesPresenceColor({ online: true, tone: 'unknown' }, presenceColors)).toBe('#neutral-gray');
    });

    it('always renders offline machines with the disconnected gray, regardless of tone', () => {
        expect(resolveMachineResourcesPresenceColor({ online: false, tone: 'unknown' }, presenceColors)).toBe('#disconnect-gray');
        expect(resolveMachineResourcesPresenceColor({ online: false, tone: 'danger' }, presenceColors)).toBe('#disconnect-gray');
    });
});

const presenceTints = {
    state: {
        success: { onTint: '#success-ink', background: '#success-fill' },
        warning: { onTint: '#warning-ink', background: '#warning-fill' },
        danger: { onTint: '#danger-ink', background: '#danger-fill' },
        neutral: { onTint: '#neutral-ink', background: '#neutral-fill' },
    },
};

describe('resolveMachineResourcesPresenceTint', () => {
    it('pairs each sampled tone with its state role ink and background', () => {
        expect(resolveMachineResourcesPresenceTint({ online: true, tone: 'ok' }, presenceTints))
            .toEqual({ onTint: '#success-ink', background: '#success-fill' });
        expect(resolveMachineResourcesPresenceTint({ online: true, tone: 'warning' }, presenceTints))
            .toEqual({ onTint: '#warning-ink', background: '#warning-fill' });
        expect(resolveMachineResourcesPresenceTint({ online: true, tone: 'danger' }, presenceTints))
            .toEqual({ onTint: '#danger-ink', background: '#danger-fill' });
    });

    it('uses the neutral grey role for unsampled and offline machines', () => {
        expect(resolveMachineResourcesPresenceTint({ online: true, tone: 'unknown' }, presenceTints))
            .toEqual({ onTint: '#neutral-ink', background: '#neutral-fill' });
        expect(resolveMachineResourcesPresenceTint({ online: false, tone: 'danger' }, presenceTints))
            .toEqual({ onTint: '#neutral-ink', background: '#neutral-fill' });
    });
});

describe('resolveMachineResourcesMetricAlerts', () => {
    function snap(input: Readonly<{ cpu?: number; memory?: number; disk?: number }>) {
        return {
            sampledAt: 1,
            cpu: { usagePercent: input.cpu ?? 0 },
            memory: { totalBytes: 16, usedBytes: 8, usagePercent: input.memory ?? 0 },
            disk: { path: '/', totalBytes: 16, availableBytes: 8, usedBytes: 8, usagePercent: input.disk ?? 0 },
        };
    }

    it('returns no alerts while every metric stays under the warning floor', () => {
        expect(resolveMachineResourcesMetricAlerts(snap({ cpu: 69.9, memory: 40, disk: 10 }))).toEqual([]);
    });

    it('badges each offending metric with its own bucket, not the machine-wide worst tone', () => {
        expect(resolveMachineResourcesMetricAlerts(snap({ cpu: 95, disk: 85 }))).toEqual([
            { metric: 'cpu', tone: 'danger' },
            { metric: 'disk', tone: 'warning' },
        ]);
    });

    it('treats the thresholds as inclusive floors', () => {
        expect(resolveMachineResourcesMetricAlerts(snap({ cpu: 70 }))).toEqual([{ metric: 'cpu', tone: 'warning' }]);
        expect(resolveMachineResourcesMetricAlerts(snap({ cpu: 90 }))).toEqual([{ metric: 'cpu', tone: 'danger' }]);
        expect(resolveMachineResourcesMetricAlerts(snap({ memory: 90 }))).toEqual([{ metric: 'memory', tone: 'danger' }]);
    });

    it('keeps a stable cpu, memory, disk order regardless of severity', () => {
        expect(resolveMachineResourcesMetricAlerts(snap({ cpu: 75, memory: 95, disk: 80 }))).toEqual([
            { metric: 'cpu', tone: 'warning' },
            { metric: 'memory', tone: 'danger' },
            { metric: 'disk', tone: 'warning' },
        ]);
    });
});

describe('resolveMachineResourcesMetricTone', () => {
    it('buckets a single metric against the inclusive thresholds', () => {
        expect(resolveMachineResourcesMetricTone(69.9)).toBe('ok');
        expect(resolveMachineResourcesMetricTone(70)).toBe('warning');
        expect(resolveMachineResourcesMetricTone(89.9)).toBe('warning');
        expect(resolveMachineResourcesMetricTone(90)).toBe('danger');
    });
});

describe('resolveMachineResourcesGaugeColor', () => {
    it('keeps healthy and unsampled gauges neutral; only breaches carry state color', () => {
        const colors = {
            state: {
                warning: { foreground: '#ffff00' },
                danger: { foreground: '#ff0000' },
            },
            text: { secondary: '#888888' },
        };
        expect(resolveMachineResourcesGaugeColor('ok', colors)).toBe('#888888');
        expect(resolveMachineResourcesGaugeColor('unknown', colors)).toBe('#888888');
        expect(resolveMachineResourcesGaugeColor('warning', colors)).toBe('#ffff00');
        expect(resolveMachineResourcesGaugeColor('danger', colors)).toBe('#ff0000');
    });
});
