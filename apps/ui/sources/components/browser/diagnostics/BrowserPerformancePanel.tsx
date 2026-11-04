import * as React from 'react';
import { View } from 'react-native';

import type { BrowserDiagnosticEventProjection } from '@/sync/domains/browser/diagnostics';
import { t } from '@/text';

import {
    browserDiagnosticsPanelStyles as styles,
    BrowserDiagnosticsFamilyPanelFrame,
    DiagnosticsMetric,
    type BrowserDiagnosticsFamilyPanelProps,
    fieldLabel,
    formatDurationMs,
    formatNumber,
} from './BrowserDiagnosticsFamilyPanel';

type Unit = 'ms' | 'score' | 'count';

/** Web-vitals thresholds (good, poor) from web.dev; between them is "needs improvement". */
const METRICS: readonly Readonly<{ key: string; unit: Unit; thresholds?: readonly [number, number] }>[] = [
    { key: 'lcpMs', unit: 'ms', thresholds: [2500, 4000] },
    { key: 'inpMs', unit: 'ms', thresholds: [200, 500] },
    { key: 'clsScore', unit: 'score', thresholds: [0.1, 0.25] },
    { key: 'fcpMs', unit: 'ms', thresholds: [1800, 3000] },
    { key: 'longTaskCount', unit: 'count' },
    { key: 'longTaskTotalMs', unit: 'ms' },
    { key: 'navResponseEndMs', unit: 'ms' },
    { key: 'navDomContentLoadedMs', unit: 'ms' },
    { key: 'navLoadEventEndMs', unit: 'ms' },
];

function formatMetric(value: number, unit: Unit): string {
    if (unit === 'ms') return formatDurationMs(value);
    if (unit === 'score') return new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(value);
    return formatNumber(value);
}

function verdict(value: number, thresholds: readonly [number, number] | undefined) {
    if (!thresholds) return null;
    if (value <= thresholds[0]) return { label: t('browserDiagnostics.host.devtools.performance.good'), tone: 'success' as const };
    if (value <= thresholds[1]) return { label: t('browserDiagnostics.host.devtools.performance.needsWork'), tone: 'warning' as const };
    return { label: t('browserDiagnostics.host.devtools.performance.poor'), tone: 'danger' as const };
}

function latestMetrics(events: readonly BrowserDiagnosticEventProjection[]): ReadonlyMap<string, number> {
    const values = new Map<string, number>();
    for (const event of events) {
        for (const field of event.detail?.fields ?? []) {
            if (typeof field.value === 'number' && Number.isFinite(field.value)) values.set(field.key, field.value);
        }
    }
    return values;
}

export function BrowserPerformancePanel(props: BrowserDiagnosticsFamilyPanelProps): React.ReactElement {
    const values = React.useMemo(() => latestMetrics(props.events), [props.events]);
    const present = METRICS.filter((metric) => values.has(metric.key));
    return (
        <BrowserDiagnosticsFamilyPanelFrame
            {...props}
            familyKey="performance"
            items={present}
            renderItems={(metrics) => (
                <View style={styles.metricGrid}>
                    {metrics.map((metric) => {
                        const value = values.get(metric.key) ?? 0;
                        return (
                            <DiagnosticsMetric
                                key={metric.key}
                                testID={`${props.testID}-performance-metric-${metric.key}`}
                                label={fieldLabel(metric.key) ?? metric.key}
                                value={formatMetric(value, metric.unit)}
                                verdict={verdict(value, metric.thresholds)}
                            />
                        );
                    })}
                </View>
            )}
        />
    );
}
