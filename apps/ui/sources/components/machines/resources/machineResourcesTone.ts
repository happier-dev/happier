import type { MachineResourcesSnapshot } from '@happier-dev/protocol';

export type MachineResourcesTone = 'ok' | 'warning' | 'danger' | 'unknown';

export type MachineResourcesToneThresholds = Readonly<{ warning: number; danger: number }>;

export const MACHINE_RESOURCES_TONE_THRESHOLDS: MachineResourcesToneThresholds = { warning: 70, danger: 90 };

/**
 * Worst-case tone across CPU, memory, and disk: each metric's `usagePercent` is bucketed against
 * the thresholds (warning/danger are inclusive floors) and the worst bucket wins. A missing
 * snapshot is `unknown` so callers can fall back to a neutral presentation.
 */
export function resolveMachineResourcesTone(
    snapshot: MachineResourcesSnapshot | null | undefined,
    thresholds?: MachineResourcesToneThresholds,
): MachineResourcesTone {
    if (!snapshot) return 'unknown';
    const metricTones = [
        resolveMachineResourcesMetricTone(snapshot.cpu.usagePercent, thresholds),
        resolveMachineResourcesMetricTone(snapshot.memory.usagePercent, thresholds),
        resolveMachineResourcesMetricTone(snapshot.disk.usagePercent, thresholds),
    ];
    if (metricTones.includes('danger')) return 'danger';
    if (metricTones.includes('warning')) return 'warning';
    return 'ok';
}

/** One offending metric on the glyph's alert badges: which metric crossed a threshold and its own
 * severity bucket (a warning machine can carry a danger CPU while disk only warns). */
export type MachineResourcesMetricAlert = Readonly<{
    metric: 'cpu' | 'memory' | 'disk';
    tone: 'warning' | 'danger';
}>;

/**
 * Metrics that crossed a threshold, in stable cpu / memory / disk order — the glyph renders them
 * right-to-left, so the first offender sits in the corner. Healthy and unsampled machines have no
 * alerts; each entry is bucketed against the metric's own usage, not the machine-wide worst tone.
 */
export function resolveMachineResourcesMetricAlerts(
    snapshot: MachineResourcesSnapshot | null | undefined,
    thresholds?: MachineResourcesToneThresholds,
): readonly MachineResourcesMetricAlert[] {
    if (!snapshot) return [];
    const resolved: MachineResourcesToneThresholds = thresholds ?? MACHINE_RESOURCES_TONE_THRESHOLDS;
    const alerts: MachineResourcesMetricAlert[] = [];
    const percents: ReadonlyArray<['cpu' | 'memory' | 'disk', number]> = [
        ['cpu', snapshot.cpu.usagePercent],
        ['memory', snapshot.memory.usagePercent],
        ['disk', snapshot.disk.usagePercent],
    ];
    for (const [metric, percent] of percents) {
        if (percent >= resolved.danger) alerts.push({ metric, tone: 'danger' });
        else if (percent >= resolved.warning) alerts.push({ metric, tone: 'warning' });
    }
    return alerts;
}

/**
 * One metric bucketed against the thresholds (inclusive floors) — the per-gauge counterpart of
 * the machine-wide worst-of tone.
 */
export function resolveMachineResourcesMetricTone(
    usagePercent: number,
    thresholds?: MachineResourcesToneThresholds,
): MachineResourcesTone {
    const resolved: MachineResourcesToneThresholds = thresholds ?? MACHINE_RESOURCES_TONE_THRESHOLDS;
    if (usagePercent >= resolved.danger) return 'danger';
    if (usagePercent >= resolved.warning) return 'warning';
    return 'ok';
}

export type MachineResourcesGaugeColorSource = Readonly<{
    state: Readonly<{ warning: Readonly<{ foreground: string }>; danger: Readonly<{ foreground: string }> }>;
    text: Readonly<{ secondary: string }>;
}>;

/**
 * Gauge ring ink under the quiet-normal calibration: healthy and unsampled metrics stay neutral
 * gray, warning/danger metrics carry their state color — each gauge speaks for its own metric,
 * mirroring the corner badges.
 */
export function resolveMachineResourcesGaugeColor(
    tone: MachineResourcesTone,
    colors: MachineResourcesGaugeColorSource,
): string {
    if (tone === 'warning') return colors.state.warning.foreground;
    if (tone === 'danger') return colors.state.danger.foreground;
    return colors.text.secondary;
}

export type MachineResourcesToneColorSource = Readonly<{
    status: Readonly<{ connected: string; disconnected: string }>;
    state: Readonly<{ warning: Readonly<{ foreground: string }>; danger: Readonly<{ foreground: string }> }>;
    text: Readonly<{ secondary: string }>;
}>;

/**
 * Tone → themed color: ok uses the connected status color, warning/danger use their state
 * foreground colors, and unknown (online without a sample yet) stays neutral gray.
 */
export function resolveMachineResourcesToneColor(
    tone: MachineResourcesTone,
    colors: MachineResourcesToneColorSource,
): string {
    if (tone === 'ok') return colors.status.connected;
    if (tone === 'warning') return colors.state.warning.foreground;
    if (tone === 'danger') return colors.state.danger.foreground;
    return colors.text.secondary;
}

export type MachineResourcesPresenceColorSource = Readonly<{
    status: Readonly<{ disconnected: string }>;
    state: Readonly<{
        success: Readonly<{ foreground: string }>;
        warning: Readonly<{ foreground: string }>;
        danger: Readonly<{ foreground: string }>;
    }>;
    text: Readonly<{ secondary: string }>;
}>;

export type MachineResourcesPresenceInput = Readonly<{
    /** Whether the machine is currently online; offline always wins over any sampled tone. */
    online: boolean;
    tone: MachineResourcesTone;
}>;

/**
 * Accent color for the machine-strip presence surfaces (chip borders, avatar rings, status
 * dots). Unlike {@link resolveMachineResourcesToneColor} — which keeps the gauge rings on the
 * connected status color — chips use the state color ladder: ok renders success, sampled
 * warning/danger render their own state colors, an online-but-unsampled machine stays neutral
 * gray, and offline machines uniformly use the disconnected gray.
 */
export function resolveMachineResourcesPresenceColor(
    input: MachineResourcesPresenceInput,
    colors: MachineResourcesPresenceColorSource,
): string {
    if (!input.online) return colors.status.disconnected;
    if (input.tone === 'ok') return colors.state.success.foreground;
    if (input.tone === 'warning') return colors.state.warning.foreground;
    if (input.tone === 'danger') return colors.state.danger.foreground;
    return colors.text.secondary;
}

export type MachineResourcesPresenceTintSource = Readonly<{
    state: Readonly<{
        success: Readonly<{ onTint: string; background: string }>;
        warning: Readonly<{ onTint: string; background: string }>;
        danger: Readonly<{ onTint: string; background: string }>;
        neutral: Readonly<{ onTint: string; background: string }>;
    }>;
}>;

/**
 * Palette-owned ink and fill for the machine-strip avatar: the 11px letter always uses the state
 * role's `onTint` — the only text-safe colour per the `state.*` doctrine, since `foreground`
 * reads below AA as text — and the comfort chip/avatar fill uses the role's arbitrated
 * `background` rather than a hand-derived alpha. Offline and unsampled machines share the
 * neutral grey role.
 */
export function resolveMachineResourcesPresenceTint(
    input: MachineResourcesPresenceInput,
    colors: MachineResourcesPresenceTintSource,
): Readonly<{ onTint: string; background: string }> {
    const role = !input.online || input.tone === 'unknown'
        ? colors.state.neutral
        : input.tone === 'ok'
            ? colors.state.success
            : input.tone === 'warning'
                ? colors.state.warning
                : colors.state.danger;
    return { onTint: role.onTint, background: role.background };
}
