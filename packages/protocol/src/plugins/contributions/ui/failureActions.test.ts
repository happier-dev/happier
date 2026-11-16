import { describe, expect, it } from 'vitest';
import { PluginUiViewV2Schema } from './v2.js';

describe('native failure Action contribution binding', () => {
  it('admits a non-Triage app page binding without giving another container that role', () => {
    const view = { id: 'support', container: 'appPage', target: { kind: 'app' }, renderer: 'support',
      failureActions: { action: 'failure/handle-v1', declaredActions: [{ subjects: ['nativeFailure'],
        actionId: 'support.fix', label: 'Fix this failure', launchMode: 'review', startable: true }] } };
    expect(PluginUiViewV2Schema.parse(view)).toMatchObject({ failureActions: view.failureActions });
    expect(PluginUiViewV2Schema.safeParse({ ...view, container: 'detailsTab', target: { kind: 'session' } }).success).toBe(false);
    expect(PluginUiViewV2Schema.safeParse({ ...view, failureActions: { action: 'failure/handle-v1', pluginId: 'another.plugin' } }).success).toBe(false);
  });
});
