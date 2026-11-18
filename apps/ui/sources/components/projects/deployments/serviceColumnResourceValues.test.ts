import { expect, it } from 'vitest';
import { admitPluginListFilterFieldV1 } from '@happier-dev/plugin-sdk/ui';
import { projectServiceColumnResourceValues } from './serviceColumnResourceValues';
import { DATABASE_CAPTURE_RESOURCE_REF_V1, TELEMETRY_REQUESTS_FIELD_ID_V1 } from '@happier-dev/database-protocol';

it('addresses public service Resource values by Environment without broadcasting a scalar or inventing zero', () => {
  const admitted = admitPluginListFilterFieldV1({ pluginId: 'com.acme.requests', factKeys: new Set(), field: {
    id: 'requests', title: 'Requests', source: { resource: 'requests' }, value: { kind: 'number', unit: '{request}' },
  } });
  if (admitted.kind !== 'admitted') throw new Error('Expected public field admission');
  const values = projectServiceColumnResourceValues({ pluginId: 'com.acme.requests', localId: 'requests' },
    admitted.field, { items: [{ environmentId: 'zero', value: 0 }, { environmentId: 'busy', value: 7 }] });
  expect(values.get('zero')?.value).toBe(0);
  expect(values.get('busy')?.value).toBe(7);
  expect(values.has('missing')).toBe(false);
  expect(projectServiceColumnResourceValues({ pluginId: 'com.acme.requests', localId: 'requests' }, admitted.field, 7).size).toBe(0);
});

it('retains the collector window, mixed sampling provenance and unknown measurement beside the admitted scalar', () => {
  const resource = { pluginId: DATABASE_CAPTURE_RESOURCE_REF_V1.pluginId, localId: DATABASE_CAPTURE_RESOURCE_REF_V1.contributionId };
  const admitted = admitPluginListFilterFieldV1({ pluginId: resource.pluginId, factKeys: new Set(), field: {
    id: TELEMETRY_REQUESTS_FIELD_ID_V1, title: 'Requests', source: { resource: resource.localId }, value: { kind: 'number', unit: '{request}' },
  } });
  if (admitted.kind !== 'admitted') throw new Error('Expected telemetry field admission');
  const measurement = { measure: 'requests', value: 0, unit: '{request}', basis: 'mixed_telemetry',
    producers: [{ serviceName: 'web' }, { serviceName: 'worker' }], window: { since: 1000, until: 4000 },
    completeness: 'partial', reasons: ['sampled_traffic'] };
  const trend = [{ since: 1000, until: 4000, value: 0, unit: '{request}' }];
  const result = { status: 'up', observedAt: 4000, evidence: { v: 1, items: [{
    source: { kind: 'entry', label: 'Collector' }, author: { kind: 'process' }, text: 'Request observations',
  }] } };
  const { value: _omitted, ...unknown } = measurement;
  const values = projectServiceColumnResourceValues(resource, admitted.field, { view: 'metrics', result: { items: [
    { environmentId: 'zero', result: { ...result, measurements: measurement }, routes: [], trend },
    { environmentId: 'unknown', result: { ...result, status: 'unknown', measurements: { ...unknown, completeness: 'unknown', reasons: ['no_traffic'] } }, routes: [], trend: [] },
    { environmentId: 'lost-coverage', result: { ...result, status: 'unknown', measurements: { ...measurement, value: 19, completeness: 'unknown' } }, routes: [], trend },
  ] } });
  expect(values.get('zero')).toEqual({ value: 0, measurement, trend });
  expect(values.get('unknown')).toMatchObject({ value: null, measurement: { window: measurement.window, reasons: ['no_traffic'] } });
  expect(values.get('lost-coverage')).toMatchObject({ value: null, measurement: { value: 19, completeness: 'unknown' } });
});
