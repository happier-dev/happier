import { beforeEach, expect, it } from 'vitest';
import { admitPluginListFilterFieldV1 } from '@happier-dev/plugin-sdk/ui';
import { preloadTranslationsForSettings, setPreferredLanguageFromSettings } from '@/text';
import { formatMomentRange } from '@/utils/datetime/formatMoment';
import { serviceFieldReadout } from './ServiceColumnCell';

beforeEach(async () => {
  await preloadTranslationsForSettings('en');
  setPreferredLanguageFromSettings('en');
});

const now = new Date(2026, 10, 28, 10, 21).getTime();
const day = 24 * 60 * 60 * 1000;

function p95Field() {
  const admitted = admitPluginListFilterFieldV1({ pluginId: 'com.acme.telemetry', factKeys: new Set(), field: {
    id: 'p95', title: 'p95', source: { resource: 'latency' }, value: { kind: 'number', unit: 'ms' },
  } });
  if (admitted.kind !== 'admitted') throw new Error('Expected public field admission');
  return { title: 'p95', source: 'Telemetry', field: admitted.field };
}

it('names the service, not its raw instance, and says a 24 h window as a real range', () => {
  const window = { since: now - day, until: now };
  const readout = serviceFieldReadout(p95Field(), { value: 4750, provenance: { basis: 'metric_points', window,
    producers: [
      { serviceName: 'Billing Canary', serviceVersion: '1.4.2', serviceInstanceId: '2c68207d-6983-4e66-a672-47a995e9e3ee' },
      { serviceName: 'Billing Canary', serviceVersion: '1.4.2', serviceInstanceId: '9f0e1c2b-0000-4e66-a672-47a995e9e3ee' },
    ], completeness: 'complete', reasons: [] } }, 'en', now);
  expect(readout).not.toContain('2c68207d');
  expect(readout).not.toContain('9f0e1c2b');
  // Two instances of one service version are one producer to the person reading the figure.
  expect(readout.split('Billing Canary · 1.4.2')).toHaveLength(2);
  expect(readout).toContain(formatMomentRange(window.since, window.until, now));
});

it('leaves out a window that starts and ends together', () => {
  const readout = serviceFieldReadout(p95Field(), { value: 4750, provenance: { basis: 'metric_points',
    window: { since: now, until: now }, producers: [{ serviceName: 'Billing Canary' }], completeness: 'complete', reasons: [] } },
  'en', now);
  expect(readout).not.toContain('–');
});
