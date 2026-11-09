// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { PluginSettingsAdministrationSetActionInputV1Schema } from '@happier-dev/protocol/plugins/settingsAdministration';
import type { PluginAgentSettingsLaunchInputV1 } from '@happier-dev/protocol/plugins/ui';
import { renderSurface } from './agentSettings.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: PluginUiTestkit[] = [];
afterEach(async () => { for (const fixture of mounted.splice(0)) await act(async () => fixture.dispose()); });

function input(): PluginAgentSettingsLaunchInputV1 {
  return {
    agentId: 'claude',
    account: { values: {}, revision: '7', ready: true, loading: false, writePending: false, error: false },
    machines: [],
  };
}

async function mount(launchInput = input()) {
  let approved = false;
  const writes: unknown[] = [];
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: { instanceId: 'claude-settings-fixture', mountNonce: 'claude-settings-mount' },
      authorPlugin: { id: 'happier.agent.claude', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createSurfaceContextFixture(),
      launchInput,
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
      // The public host confirmation and Action transport are genuine external boundaries.
      handlers: {
        confirm: async () => approved,
        executeAction: async ({ action, input: raw }) => {
          expect(action).toBe('plugins.settings.set');
          const request = PluginSettingsAdministrationSetActionInputV1Schema.parse(raw);
          writes.push(request);
          return { ok: true, kind: 'plugins.settings.set', data: {
            scope: { kind: 'account' }, target: { kind: 'account' }, localId: request.localId,
            revision: '8', application: { kind: 'live' },
          } };
        },
      },
    });
  });
  mounted.push(fixture);
  return { fixture, writes, approve: () => { approved = true; } };
}

async function pressButton(fixture: PluginUiTestkit, prefix: string) {
  const button = (await fixture.getAllByRole('button')).find(target => target.name?.startsWith(prefix));
  expect(button, `Expected visible button ${prefix}`).toBeDefined();
  await act(async () => fixture.press(button!));
}

async function chooseYear(fixture: PluginUiTestkit) {
  await pressButton(fixture, 'Keep local history');
  const option = await fixture.getByRole('menuitemradio', { name: '1 year (365 days)' });
  await act(async () => fixture.press(option));
}

describe('Claude contributed Agent settings', () => {
  it('keeps unknown-risk changes cancelled and sends approved policy through the canonical Account Action with CAS', async () => {
    const harness = await mount();
    expect(harness.writes).toEqual([]);
    await chooseYear(harness.fixture);
    expect(harness.writes).toEqual([]);
    harness.approve();
    await chooseYear(harness.fixture);
    expect(harness.writes).toEqual([{
      pluginId: 'happier.agent.claude', scope: { kind: 'account' }, target: { kind: 'account' },
      localId: 'claudeSessionRetentionV1', value: { mode: 'days', days: 365 }, expectedRevision: '7',
    }]);
  });

  it('distinguishes current application failure from retained failure in another daemon lifetime', async () => {
    const facts = { online: true, pid: 123, startedAt: 20, cliVersion: 'fixture',
      report: { status: 'error', reason: 'provider_settings_failed' } };
    const data = input();
    data.machines = [
      { ...facts, id: 'stale', displayName: 'Old daemon', source: { pid: 123, startedAt: 10, cliVersion: 'fixture' } },
      { ...facts, id: 'fresh', displayName: 'Current daemon', source: { pid: 123, startedAt: 20, cliVersion: 'fixture' } },
    ];
    const { fixture } = await mount(data);
    await pressButton(fixture, 'Machine status');
    expect(await fixture.getByText('Status unavailable')).toBeDefined();
    expect(await fixture.getByText('Could not apply')).toBeDefined();
    await pressButton(fixture, 'Current daemon');
    expect(await fixture.getByText('Could not update Claude settings. Check the machine and reconnect to retry.')).toBeDefined();
  });
});
