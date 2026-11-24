import { expect, it } from 'vitest';
import { admitPluginListFilterFieldV1, PluginServiceListFieldResourceResultV1Schema } from '@happier-dev/plugin-sdk/ui';
import { projectServiceColumnResourceValues } from './serviceColumnResourceValues';

it('addresses public service Resource values by Environment without broadcasting a scalar or inventing zero', () => {
  const admitted = admitPluginListFilterFieldV1({ pluginId: 'com.acme.requests', factKeys: new Set(), field: {
    id: 'requests', title: 'Requests', source: { resource: 'requests' }, value: { kind: 'number', unit: '{request}' },
  } });
  if (admitted.kind !== 'admitted') throw new Error('Expected public field admission');
  const values = projectServiceColumnResourceValues(admitted.field, [
    { environmentId: 'zero', value: 0 }, { environmentId: 'busy', value: 7 },
    { environmentId: 'invalid', value: '7' },
  ]);
  expect(values.get('zero')?.value).toBe(0);
  expect(values.get('busy')?.value).toBe(7);
  expect(values.has('missing')).toBe(false);
  expect(values.has('invalid')).toBe(false);
});

it('retains public producer coverage and trend beside zero or an unknown measurement', () => {
  const admitted = admitPluginListFilterFieldV1({ pluginId: 'com.acme.requests', factKeys: new Set(), field: {
    id: 'requests', title: 'Requests', source: { resource: 'requests' }, value: { kind: 'number', unit: '{request}' },
  } });
  if (admitted.kind !== 'admitted') throw new Error('Expected public field admission');
  const provenance = { basis: 'mixed_telemetry',
    producers: [{ serviceName: 'web' }, { serviceName: 'worker' }], window: { since: 1000, until: 4000 },
    completeness: 'partial', reasons: ['sampled_traffic'] };
  const trend = [{ at: 2500, value: null }, { at: 4000, value: 0 }];
  const result = PluginServiceListFieldResourceResultV1Schema.parse({ items: [
    { environmentId: 'zero', value: 0, provenance, trend },
    { environmentId: 'unknown', value: null, provenance: { ...provenance, completeness: 'unknown', reasons: ['no_traffic'] }, trend: [] },
  ] });
  const values = projectServiceColumnResourceValues(admitted.field, result.items);
  expect(values.get('zero')).toEqual({ value: 0, provenance, trend });
  expect(values.get('unknown')).toMatchObject({ value: null, provenance: { window: provenance.window, reasons: ['no_traffic'] } });
});
