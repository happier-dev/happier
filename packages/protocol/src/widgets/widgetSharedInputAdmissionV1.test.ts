import { describe, expect, it } from 'vitest';
import { findWidgetPrivateInputSelectionsV1, getWidgetSharedInputIssuesV1 } from './widgetSharedInputAdmissionV1.js';

describe('Shared widget input review', () => {
  it('identifies nested private choices with repair paths without returning author account selections', () => {
    const instance = { v: 1, id: 'widget', definition: { kind: 'artifact', artifactId: 'private-definition' },
      bindings: { cloud: { kind: 'value', value: { nested: [{
        service: { pluginId: 'com.acme.test', localId: 'cloud', extra: true }, accountId: 'private-author-account', extra: true,
      }] } }, own: { kind: 'viewer', purpose: 'metrics' } } };
    const issues = findWidgetPrivateInputSelectionsV1(instance);
    expect(issues).toEqual([{ instanceId: 'widget', inputPath: 'cloud', path: ['bindings', 'cloud', 'value', 'nested', 0],
      service: { pluginId: 'com.acme.test', localId: 'cloud' }, reasonCode: 'widget_private_connection_selection' }]);
    expect(JSON.stringify(issues)).not.toContain('private-author-account');
    expect(getWidgetSharedInputIssuesV1({ ...instance, bindings: { own: instance.bindings.own } })).toEqual([]);
  });
});
