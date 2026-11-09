import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { StackedSeriesChart } from '@happier-dev/plugin-ui/presentation';
import { MachineResourceSummaryV1Schema, projectMachineResourceSummaryV1 } from '@happier-dev/protocol/machines/resources/machineResourceSummaryV1';
import { MachineVitalsSnapshotV1Schema } from '@happier-dev/protocol/machines/vitals/machineVitalsRpcV1';

import { renderScreen } from '@/dev/testkit';
import { Tooltip } from '@/components/ui/overlays/Tooltip';
import { t } from '@/text';

import { MachineSummaryStrip } from './MachineSummaryStrip';
import { MACHINE_SUMMARY_METRICS } from './machineSummaryStripModel';
import { MACHINE_SUMMARY_PREVIEW } from './machineSummaryPreview';

describe('MachineSummaryStrip', () => {
    it.each([
        { layout: 'under', source: 'kernel_level', key: 'kernel' },
        { layout: 'inline', source: 'psi', key: 'estimated' },
        { layout: 'cells', source: 'events', key: 'estimated' },
        { layout: 'fact', source: 'none', key: 'none' },
        { layout: 'tiles', source: 'kernel_level', key: 'kernel' },
    ] as const)('carries producer pressure provenance into $layout hover and accessible text', async ({ layout, source, key }) => {
        const snapshot = MachineVitalsSnapshotV1Schema.parse({
            state: 'reporting', sample: { v: 1, sampledAt: 60_000, intervalMs: 15_000,
                cpu: { reported: false, reason: 'unavailable' },
                memory: { reported: true, totalBytes: 8 * 1024 ** 3, availableBytes: 6 * 1024 ** 3, usedBytes: 2 * 1024 ** 3,
                    pressure: { level: source === 'none' ? 'not_reported' : 'calm', source } },
                disk: { reported: false, reason: 'unavailable' }, network: { reported: false, reason: 'unavailable' } },
            series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] },
        });
        const summary = MachineResourceSummaryV1Schema.parse(projectMachineResourceSummaryV1(snapshot));
        const screen = await renderScreen(<MachineSummaryStrip testID="strip" availability={{ kind: 'reporting', summary, freshness: 'live' }}
            style="bars" metrics={['memory']} layout={layout} />);
        const provenance = t(`machineVitals.memory.source.${key}`);
        expect(screen.findByTestId('strip')?.props.accessibilityLabel).toContain(provenance);
        expect(screen.findAll(node => node.type === Tooltip).some(node => String(node.props.label).includes(provenance))).toBe(true);
    });
    it.each([
        { level: 'calm', tone: 'calm', said: null },
        { level: 'elevated', tone: 'warn', said: () => t('machineAttention.words.memoryElevated') },
        { level: 'critical', tone: 'crit', said: () => t('machineAttention.words.memoryCritical') },
    ] as const)('says a $level machine\'s memory as a fact, never a bare pressure word (picker fact)', async ({ level, tone, said }) => {
        const snapshot = MachineVitalsSnapshotV1Schema.parse({
            state: 'reporting', sample: { v: 1, sampledAt: 60_000, intervalMs: 15_000,
                cpu: { reported: false, reason: 'unavailable' },
                memory: { reported: true, totalBytes: 8 * 1024 ** 3, availableBytes: 6 * 1024 ** 3, usedBytes: 2 * 1024 ** 3,
                    pressure: { level, source: 'kernel_level' } },
                disk: { reported: false, reason: 'unavailable' }, network: { reported: false, reason: 'unavailable' } },
            series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] },
        });
        const projected = MachineResourceSummaryV1Schema.parse(projectMachineResourceSummaryV1(snapshot));
        // Tone is the daemon attention owner's verdict; the fact only words it.
        const summary = { ...projected, memory: { ...projected.memory, tone } };
        const screen = await renderScreen(<MachineSummaryStrip testID="strip" availability={{ kind: 'reporting', summary, freshness: 'live' }}
            style="numbers" metrics={['memory']} layout="fact" />);
        const text = screen.getTextContent();
        if (said) expect(text).toBe(said());
        else expect(text).not.toBe(t('machineAttention.words.memoryElevated'));
        expect(text).not.toContain(t('machineSummary.pressure.critical'));
    });
    it('keeps an instrument\'s tree in place when a sample drops or regains its exact reading', async () => {
        const calm = MACHINE_SUMMARY_PREVIEW.calm;
        if (calm.kind !== 'reporting' || !calm.summary) throw new Error('preview must report');
        const draw = (cpu: Partial<typeof calm.summary.cpu>) => (
            <MachineSummaryStrip testID="strip" availability={{ ...calm, summary: { ...calm.summary!, cpu: { ...calm.summary!.cpu, ...cpu } } }}
                style="sparklines" metrics={['cpu']} layout="under" />
        );
        const screen = await renderScreen(draw({}));
        const withReading = screen.findAll(node => node.type === Tooltip).length;
        expect(withReading).toBe(1);
        // A sample without a reading must not swap the tooltip host out from around the line (it would remount the chart).
        await screen.update(draw({ busyPct: null as never }));
        expect(screen.findAll(node => node.type === Tooltip).length).toBe(withReading);
    });
    it('says what a filling tile\'s figure is without repeating the frame\'s metric name (lab `rw` M, Small)', async () => {
        const draw = (metric: 'cpu' | 'memory') => (
            <MachineSummaryStrip testID="strip" availability={MACHINE_SUMMARY_PREVIEW.calm} style="sparklines" metrics={[metric]} layout="tiles" fill />
        );
        const screen = await renderScreen(draw('memory'));
        expect(screen.getTextContent()).toContain(t('machineSummary.caption.memory'));
        await screen.update(draw('cpu'));
        // The frame already says "CPU": the line says only the window the chart covers.
        expect(screen.getTextContent()).toContain(t('machineSummary.caption.window'));
        expect(screen.getTextContent()).not.toContain(t('machineSummary.caption.cpu'));
    });

    it('names a filling CPU tile\'s load and cores from the summary, and falls back to the window when the machine reports neither (lab `rw` M, Small)', async () => {
        const calm = MACHINE_SUMMARY_PREVIEW.calm;
        if (calm.kind !== 'reporting' || !calm.summary) throw new Error('preview must report');
        const withCpu = (cpu: Partial<typeof calm.summary.cpu>) => ({ ...calm, summary: { ...calm.summary!, cpu: { ...calm.summary!.cpu, ...cpu } } });
        const draw = (availability: typeof calm) => (
            <MachineSummaryStrip testID="strip" availability={availability} style="sparklines" metrics={['cpu']} layout="tiles" fill />
        );
        const screen = await renderScreen(draw(withCpu({ load1: 2.31, logicalCores: 18 })));
        expect(screen.getTextContent()).toContain(t('machineVitals.cpu.loadAndCores', { load: '2.31', count: 18 }));
        expect(screen.getTextContent()).not.toContain(t('machineSummary.caption.window'));
        // Load 0 is a reading, not an absence; capacity a container limits is "available", fractional as the host holds it.
        await screen.update(draw(withCpu({ load1: 0, logicalCores: 8, effectiveCores: 1.5 })));
        expect(screen.getTextContent()).toContain(t('machineVitals.cpu.loadAndCoresLimited', { load: '0.00', count: 1.5 }));
        // One observed fact says only that fact (Windows reports cores without a load average).
        await screen.update(draw(withCpu({ logicalCores: 16 })));
        expect(screen.getTextContent()).toContain(t('machineVitals.cpu.cores', { count: 16 }));
        expect(screen.getTextContent()).not.toContain(t('machineSummary.caption.window'));
        await screen.update(draw(withCpu({ load1: 0.5 })));
        expect(screen.getTextContent()).toContain(t('machineVitals.cpu.load', { load: '0.50' }));
        // An older daemon sends neither: the line keeps the window it had.
        await screen.update(draw(withCpu({})));
        expect(screen.getTextContent()).toContain(t('machineSummary.caption.window'));
    });

    it('draws nothing with no metric shown: rows show the machine name only (R42.6)', async () => {
        const screen = await renderScreen(<MachineSummaryStrip testID="strip" availability={MACHINE_SUMMARY_PREVIEW.calm} style="sparklines" metrics={[]} layout="under" />);
        // The component itself carries the id; no host view is drawn for it.
        expect(screen.findAll(node => typeof node.type === 'string' && node.props?.testID === 'strip')).toHaveLength(0);
    });

    it('names every shown metric exactly for screen readers, in use for CPU and free for memory and disk', async () => {
        const screen = await renderScreen(<MachineSummaryStrip testID="strip" availability={MACHINE_SUMMARY_PREVIEW.calm} style="bars" metrics={['cpu', 'memory', 'disk']} layout="under" />);
        const label = String(screen.findByTestId('strip')?.props.accessibilityLabel);
        expect(label).toContain('4%');
        expect(label).toContain('19 GB');
        expect(label).toContain('310 GB');
    });

    it('draws every chosen instrument on the name\'s line in a list row (lab `rm` R): three small lines, no figures', async () => {
        const screen = await renderScreen(<MachineSummaryStrip testID="strip" availability={MACHINE_SUMMARY_PREVIEW.calm} style="sparklines" metrics={['cpu', 'memory', 'disk']} layout="inline" />);
        const label = String(screen.findByTestId('strip')?.props.accessibilityLabel);
        expect(label).toContain('4%');
        expect(label).toContain('19 GB');
        expect(label).toContain('310 GB');
        expect(screen.getTextContent()).not.toContain('GB');
    });

    it('leaves a list row\'s name its width when numbers are the style: one figure stands, the metric in trouble first', async () => {
        const screen = await renderScreen(<MachineSummaryStrip testID="strip" availability={MACHINE_SUMMARY_PREVIEW.calm} style="numbers" metrics={['cpu', 'memory', 'disk']} layout="inline" />);
        expect(screen.getTextContent()).toContain('4%');
        expect(screen.getTextContent()).not.toContain('19 GB');
        expect(screen.getTextContent()).not.toContain('310 GB');
    });

    it('steps the `under` row down to the metrics that fit its measured width, calm ones first, and back up when it widens', async () => {
        const screen = await renderScreen(<MachineSummaryStrip testID="strip" availability={MACHINE_SUMMARY_PREVIEW.calm}
            style="bars" metrics={MACHINE_SUMMARY_METRICS} layout="under" />);
        const measure = (width: number) => act(() => screen.findByTestId('strip')!.props.onLayout({ nativeEvent: { layout: { width, height: 16, x: 0, y: 0 } } }));
        const named = () => screen.findAll(node => node.type === Tooltip).length;
        // Before the first measurement every chosen metric shows (nothing is dropped on a guess).
        expect(named()).toBe(MACHINE_SUMMARY_METRICS.length);
        measure(0);
        expect(named()).toBe(MACHINE_SUMMARY_METRICS.length);
        measure(250);
        expect(named()).toBeLessThan(MACHINE_SUMMARY_METRICS.length);
        expect(named()).toBeGreaterThanOrEqual(1);
        const retainedMetrics = named();
        measure(0);
        expect(named()).toBe(retainedMetrics);
        measure(40);
        expect(named()).toBe(1);
        measure(520);
        expect(named()).toBe(MACHINE_SUMMARY_METRICS.length);
    });

    it('keeps its slots without figures while the values are not held yet, never saying zero', async () => {
        const screen = await renderScreen(<MachineSummaryStrip testID="strip" availability={{ kind: 'reporting', summary: null, freshness: 'live' }}
            style="numbers" metrics={['cpu', 'memory']} layout="under" />);
        expect(screen.findByTestId('strip')).not.toBeNull();
        expect(screen.getTextContent()).not.toContain('0%');
        expect(screen.getTextContent()).toContain('–');
    });

    it('labels ring-tile memory and disk amounts with their free-space units', async () => {
        const screen = await renderScreen(<MachineSummaryStrip testID="strip" availability={MACHINE_SUMMARY_PREVIEW.calm}
            style="rings" metrics={['memory', 'disk']} layout="tiles" />);
        expect(screen.getTextContent()).toContain('GB free');
        expect(screen.findByTestId('strip')?.props.accessibilityLabel).toContain('19 GB');
        expect(screen.findByTestId('strip')?.props.accessibilityLabel).toContain('310 GB');
    });

    it('draws no line before a sample exists: an unsampled metric is never a flat zero', async () => {
        const screen = await renderScreen(<MachineSummaryStrip testID="strip" availability={{ kind: 'reporting', summary: null, freshness: 'live' }}
            style="sparklines" metrics={['cpu', 'memory']} layout="under" />);
        expect(screen.findByTestId('strip')).not.toBeNull();
        expect(screen.findAll(node => node.type === StackedSeriesChart)).toHaveLength(0);
    });

    it('keeps summary sparklines passive while announcing their measured values', async () => {
        const screen = await renderScreen(<MachineSummaryStrip testID="strip" availability={MACHINE_SUMMARY_PREVIEW.calm}
            style="sparklines" metrics={['cpu', 'memory']} layout="under" />);
        expect(screen.findAll(node => typeof node.type === 'string' && node.props.accessibilityRole === 'button')).toHaveLength(0);
        // A sparkline is a picture: the chart draws ink only, with no hit layer mounted per sample.
        const charts = screen.findAll(node => node.type === StackedSeriesChart);
        expect(charts.length).toBeGreaterThan(0);
        expect(charts.every(chart => chart.props.decorative === true)).toBe(true);
        expect(screen.findByTestId('strip')?.props.accessibilityLabel).toContain('4%');
        expect(screen.findByTestId('strip')?.props.accessibilityLabel).toContain('19 GB');
    });

    it.each(['under', 'fact'] as const)('retains held values and dims stale or failed reads in %s layout', async layout => {
        const calm = MACHINE_SUMMARY_PREVIEW.calm;
        if (calm.kind !== 'reporting') throw new Error('preview must report');
        const draw = (availability: typeof calm) => <MachineSummaryStrip testID="strip" availability={availability}
            style="numbers" metrics={['memory']} layout={layout} />;
        const screen = await renderScreen(draw(calm));
        const heldText = screen.getTextContent();
        const dimmed = () => {
            const style = [screen.findByTestId('strip')?.props.style].flat(3).filter(Boolean) as Array<{ opacity?: number }>;
            return style.some(entry => typeof entry.opacity === 'number' && entry.opacity < 1);
        };
        expect(heldText).toContain('19 GB');
        expect(dimmed()).toBe(false);
        await screen.update(draw({ ...calm, freshness: 'held' }));
        expect(screen.getTextContent()).toBe(heldText);
        expect(dimmed()).toBe(false);
        await screen.update(draw({ ...calm, freshness: 'stale' }));
        expect(screen.getTextContent()).toBe(heldText);
        expect(dimmed()).toBe(true);
        await screen.update(draw({ ...calm, freshness: 'held', readStatus: 'error' }));
        expect(screen.getTextContent()).toBe(heldText);
        expect(dimmed()).toBe(true);
        await screen.update(draw(calm));
        expect(dimmed()).toBe(false);
    });
});
