import { beforeEach, describe, expect, it } from "vitest";

import { register } from "./registry";
import {
    recordRuntimeGcEvent,
    resetRuntimeMetricsTrackingState,
} from "./runtimeMetrics";

async function expectSampleValue(
    metricName: string,
    labels?: Record<string, string>,
): Promise<number> {
    const metric = register.getSingleMetric(metricName);
    if (!metric) {
        throw new Error(`Expected metric ${metricName} to be registered`);
    }
    const collected = await register.getMetricsAsJSON();
    const target = collected.find((entry) => entry.name === metricName);
    if (!target) {
        throw new Error(`Expected metric ${metricName} to have samples`);
    }
    const sample = (target.values ?? []).find((value) =>
        Object.entries(labels ?? {}).every(([key, expected]) => value.labels[key] === expected),
    );
    if (!sample) {
        throw new Error(`Expected metric ${metricName} sample with labels ${JSON.stringify(labels ?? {})}`);
    }
    return sample.value;
}

describe("runtimeMetrics", () => {
    beforeEach(() => {
        register.resetMetrics();
        resetRuntimeMetricsTrackingState();
    });

    it("collects cumulative GC event counts and durations by kind", async () => {
        recordRuntimeGcEvent({ kind: "major", durationMs: 12 });
        recordRuntimeGcEvent({ kind: "major", durationMs: 8 });
        recordRuntimeGcEvent({ kind: "minor", durationMs: 4 });

        expect(await expectSampleValue("runtime_gc_events_total", { kind: "major" })).toBe(2);
        expect(await expectSampleValue("runtime_gc_events_total", { kind: "minor" })).toBe(1);
        expect(await expectSampleValue("runtime_gc_events_total", { kind: "incremental" })).toBe(0);
        expect(await expectSampleValue("runtime_gc_duration_seconds_total", { kind: "major" })).toBeCloseTo(0.02);
        expect(await expectSampleValue("runtime_gc_duration_seconds_total", { kind: "minor" })).toBeCloseTo(0.004);
    });
});
