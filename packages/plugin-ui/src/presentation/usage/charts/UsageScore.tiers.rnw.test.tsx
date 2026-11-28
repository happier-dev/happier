import { describe, expect, it } from 'vitest';

import { SURFACE_CONTEXT_THEME_FIXTURE as theme } from '../../../../../plugin-sdk/src/ui/surfaceContext.fixture.js';
import { mountThroughReactNativeWeb } from '../../../rnwMount.testSupport.js';
import { mixHappierColorOverPaper } from '../../data/dataModel.js';
import { UsageScore } from './UsageAgentsCharts.js';

/** WCAG 2 contrast of two `#RRGGBB` colours. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
      .map((c) => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

// The Agent catalog's identity hues for each theme (Claude and Codex descriptors), on the card paper they draw over.
// Pi is left out: its light catalog hue (#e87ba4) is 2.69:1 on white even at full strength, a floor the Pi Agent
// presentation owner decides, not this chart; every tier here draws the hue it is given at full strength.
const slices = [
  { name: 'light', paper: '#ffffff', agents: [{ id: 'claude', name: 'Claude Code', color: '#eb6834' }, { id: 'codex', name: 'Codex', color: '#2a78d6' }] },
  { name: 'dark', paper: '#221c1c', agents: [{ id: 'claude', name: 'Claude Code', color: '#d95926' }, { id: 'codex', name: 'Codex', color: '#3987e5' }] },
] as const;
// One hour in each tier on the first day of an ordinary seven-day week: 1–15, 15–40 and 40+ minutes of agent time.
const idle = Array.from({ length: 24 }, () => 0);
const week = [[10, 30, 50, ...idle.slice(3)], ...Array.from({ length: 6 }, () => idle)];
const labels = {
  day: (index: number) => `Mon ${index + 9}`,
  clock: String,
  unknownAgent: 'Unknown',
  key: { light: 'Light', medium: 'Medium', strong: 'Strong', presence: 'Present', presenceNote: '' },
  values: { show: 'Values', hide: 'Hide', agentColumn: 'Agent', dayColumn: 'Day', hoursColumn: 'Hours', formatHours: (value: readonly (number | null)[]) => value.join(', ') },
};

describe('Score tiers', () => {
  for (const slice of slices) for (const width of [900, 560, 360]) {
    it(`draws every tier at 3:1 or more on the ${slice.name} card and keys the tiers with the marks' own encoding (width ${width})`, () => {
      const chart = mountThroughReactNativeWeb(
        <UsageScore theme={theme} paint={{ accent: '#007aff', paper: slice.paper, dark: slice.name === 'dark' }} agents={slice.agents} width={width} label="Score" testID="chart"
          model={{ weekStart: '2026-11-09', dayCount: 7, encoding: 'minutes', rows: [{ agentId: 'claude', hours: week }, { agentId: 'codex', hours: week }] }}
          labels={labels} />,
      );
      try {
        const marks = [...chart.container.querySelectorAll('circle')]
          .filter((circle) => slice.agents.some((agent) => agent.color === circle.getAttribute('fill')));
        expect(marks).toHaveLength(6);
        for (const mark of marks) {
          const drawn = mixHappierColorOverPaper(mark.getAttribute('fill')!, slice.paper, Number(mark.getAttribute('fill-opacity') ?? 1))!;
          expect(contrast(drawn, slice.paper)).toBeGreaterThanOrEqual(3);
        }
        // Each row's three hours read as three tiers, lightest to strongest.
        const radii = marks.slice(0, 3).map((mark) => Number(mark.getAttribute('r')));
        expect(radii[0]).toBeLessThan(radii[1]!);
        expect(radii[1]).toBeLessThan(radii[2]!);
        expect(marks.slice(3).map((mark) => Number(mark.getAttribute('r')))).toEqual(radii);
        // The key draws the same tiers the plot draws: one neutral sample at the marks' relative sizes.
        const swatches = ['Light', 'Medium', 'Strong'].map((label) => {
          const text = [...chart.container.querySelectorAll<HTMLElement>('div')].find((node) => node.textContent === label && node.childElementCount === 0)!;
          return getComputedStyle(text.previousElementSibling as HTMLElement);
        });
        expect(new Set(swatches.map((swatch) => swatch.backgroundColor)).size).toBe(1);
        const sizes = swatches.map((swatch) => parseFloat(swatch.width));
        sizes.forEach((size, index) => expect(size / sizes[2]!).toBeCloseTo(radii[index]! / radii[2]!, 2));
      } finally {
        chart.unmount();
      }
    });
  }
});
