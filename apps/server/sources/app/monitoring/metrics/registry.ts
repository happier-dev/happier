import type { Metric } from "prom-client";
import { Registry } from "prom-client";

export const register = new Registry();

export function getOrCreateMetric<TMetric extends Metric>(
    name: string,
    createMetric: () => TMetric,
): TMetric {
    const existing = register.getSingleMetric(name);
    if (existing) {
        return existing as TMetric;
    }
    return createMetric();
}
