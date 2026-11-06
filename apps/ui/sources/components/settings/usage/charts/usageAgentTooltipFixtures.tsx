import type { ReactElement } from 'react';
import { UsageAgentRiver, UsageConstellation, UsageCrew, UsageOrbit, UsageScore, UsageShipped } from '@happier-dev/plugin-ui/presentation';

import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { lightTheme } from '@/theme';
import { usageSignatureAccent } from '../usageAccent';

const theme = projectPluginUiTheme(lightTheme);
const base = {
    theme, paint: { accent: usageSignatureAccent(lightTheme), paper: lightTheme.colors.surface.base, dark: false },
    width: 720, label: 'Measured work', testID: 'agent-chart',
    agents: [{ id: 'claude', name: 'Claude Code', color: usageSignatureAccent(lightTheme) }, { id: 'codex', name: 'Codex', color: usageSignatureAccent(lightTheme) }],
};
const values = { show: 'Values', hide: 'Hide values' };
const percent = (share: number) => `${Math.round(share * 100)}%`;
const scoreLabels = {
    day: () => 'Monday', clock: (hour: number) => `${hour}:00`, unknownAgent: 'Unknown',
    key: { light: 'Light', medium: 'Medium', strong: 'Strong', presence: 'Present', presenceNote: 'Presence only' },
    values: { ...values, agentColumn: 'Agent', dayColumn: 'Day', hoursColumn: 'Hours',
        formatHours: (hours: readonly (number | null)[]) => hours.flatMap((n, hour) => n === null ? [] : [`${hour}:00 ${n} min`]).join(', ') },
};
const constellationLabels = {
    kinds: { session: 'Session', run: 'Run', native: 'Native' }, arrowNote: '', unknownStarts: String,
    nodesOnly: 'Nodes only', unknownAgent: 'Unknown',
};

/** Real chart bodies consumed by the common hover/focus/press-to-Popover contract test. */
export const usageAgentTooltipFixtures: readonly Readonly<{ name: string; value: string; body: ReactElement }>[] = [
    ...[720, 390].map((width) => ({ name: `Score hour at ${width}px`, value: '0:00 12.345 min',
        body: <UsageScore {...base} width={width} labels={scoreLabels} model={{ weekStart: '2026-10-26', encoding: 'minutes',
            rows: [{ agentId: 'claude', hours: [[12.345, null]] }] }} /> })),
    { name: 'Orbit planet', value: '12.35%', body: <UsageOrbit {...base} model={[{ agentId: 'claude', share: 0.123456 }]}
        labels={{ percent, unknown: String, unknownAgent: 'Unknown' }} /> },
    { name: 'Crew share', value: '12.35%', body: <UsageCrew {...base} model={[{ agentId: 'claude', share: 0.123456 }]}
        labels={{ percent, days: String, unknownAgent: 'Unknown' }} /> },
    { name: 'Agent river band', value: '12.35%', body: <UsageAgentRiver {...base} model={{ width: 'share', weeks: [
        { start: 'Monday', end: 'Sunday', partial: false, total: 1234.567, shares: [{ agentId: 'claude', share: 0.123456 }] },
        { start: 'Next Monday', end: 'Next Sunday', partial: false, total: null, shares: [{ agentId: 'claude', share: 1 }] },
    ] }} labels={{ week: String, partialWeek: (a, b) => `${a}–${b}`, inline: String, caption: '', unknownAgent: 'Unknown',
        values: { ...values, weekColumn: 'Week', totalColumn: 'Total', formatTotal: () => '1.2k tokens', percent } }} /> },
    { name: 'Shipped weekly spine', value: '1 merged PR', body: <UsageShipped {...base} model={{ mode: 'weeks', total: 1, undated: 0,
        weeks: [{ start: 'Monday', spines: ['claude'] }] }} labels={{ week: String, noDate: 'No date', countLine: (n) => `${n} merged PR`,
        mixed: 'Mixed', noMergeDate: 'No merge date', colourBy: 'agent' }} /> },
    { name: 'Constellation node', value: '12.35%', body: <UsageConstellation {...base} labels={constellationLabels}
        model={{ nodes: [{ agentId: 'claude', share: 0.123456 }], edges: null, unknownStarts: null }} /> },
    { name: 'Constellation directed edge', value: '1,234', body: <UsageConstellation {...base} labels={constellationLabels}
        model={{ nodes: [{ agentId: 'claude', share: 0.2 }, { agentId: 'codex', share: null }],
            edges: [{ from: 'claude', to: 'codex', kind: 'session', count: 1234 }], unknownStarts: null }} /> },
    { name: 'Constellation self edge', value: '1,234', body: <UsageConstellation {...base} labels={constellationLabels}
        model={{ nodes: [{ agentId: 'claude', share: 0.2 }], edges: [{ from: 'claude', to: 'claude', kind: 'run', count: 1234 }], unknownStarts: null }} /> },
];
