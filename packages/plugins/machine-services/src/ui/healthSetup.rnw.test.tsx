// @vitest-environment jsdom
import { act } from 'react';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import {
  createPluginUiTestkit,
  createSurfaceContextFixture,
  type PluginUiTestkit,
} from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { MACHINE_SERVICES_PLUGIN_ID, createHealthCheckSourceInstanceIdV1 } from '../healthSetup.js';
import { renderSurface } from './healthSetup.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let mounted: PluginUiTestkit | undefined;
afterEach(async () => {
  await mounted?.dispose();
  mounted = undefined;
});

const subject = {
  kind: 'machineService',
  machineId: 'shop-prod',
  serviceId: 'compose:uptime-kuma',
} as const;

// Only the host's settlement transport is substituted; the real SDK mount, shared tiles/fields
// and the canonical setup-input schema decide what the setup modal receives.
async function mount(launchInput: JsonValue, handlers: Parameters<typeof createPluginUiTestkit>[0]['handlers'] = {},
  preview?: NonNullable<Parameters<typeof createPluginUiTestkit>[0]['handlers']>['executeAction']) {
  const settled: unknown[] = [];
  await act(async () => {
    mounted = await createPluginUiTestkit({
      identity: {
        instanceId: 'health-setup',
        mountNonce: 'health-setup-mount',
      },
      authorPlugin: { id: MACHINE_SERVICES_PLUGIN_ID, version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
      launchInput,
      handlers: {
        ...handlers,
        // The readonly Configure transport is independent of finite probes and diagnostics.
        executeAction: async request => {
          if (typeof request.action === 'object' && request.action.localId === 'health/setup') {
            if (preview) return preview(request);
            const { mode, ...sourceConfig } = request.input as Record<string, JsonValue>;
            return { mode: 'preview', sourceConfig: { ...sourceConfig, alerts: sourceConfig.alerts ?? { channels: [], phases: ['open', 'recovered'] } } };
          }
          if (!handlers.executeAction) throw new Error('Unexpected Action');
          return handlers.executeAction(request);
        },
        settleEphemeralInput: async ({ settlement }) => {
          settled.push(settlement);
        },
      },
    });
  });
  return { page: mounted!, settled };
}

async function type(label: string, value: string) {
  const field = document.querySelector(`input[aria-label="${label}"]`);
  if (!(field instanceof HTMLInputElement))
    throw new Error(`${label} input was not mounted`);
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;
  if (!setValue) throw new Error('Browser input value setter missing');
  await act(async () => {
    setValue.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function addButton(page: PluginUiTestkit) {
  return await page.getByRole('button', { name: 'Add check' });
}

it('prefills first Configure alert defaults without losing the retained automatic investigation', async () => {
  const calls: unknown[] = [];
  const investigation = { mode: 'auto_start', configuredActionId: 'saved-investigation' };
  const alerts = { channels: [{ channelId: 'saved-channel' }], phases: ['open'] };
  let finishPreview: (value: JsonValue) => void = () => { throw new Error('Preview transport not initialized'); };
  const pendingPreview = new Promise<JsonValue>(resolve => { finishPreview = resolve; });
  const { page, settled } = await mount({ initialInput: { v: 1, subject, investigation } }, {}, async request => {
      calls.push(request);
      return pendingPreview;
    });
  await type('Endpoint', 'https://app.example.test');
  expect((await addButton(page)).state?.disabled ?? false).toBe(true);
  await act(async () => { finishPreview({ mode: 'preview', sourceConfig: { v: 1, subject, investigation, alerts } }); });
  await expect(page.getByRole('radio', { name: 'Failure only' })).resolves.toBeDefined();
  expect((await page.getAllByRole('radio')).find(target => target.name?.startsWith('Start investigation'))).toBeDefined();
  expect(calls).toEqual([expect.objectContaining({ action: { pluginId: MACHINE_SERVICES_PLUGIN_ID, localId: 'health/setup' },
    input: expect.objectContaining({ mode: 'preview', subject }) })]);
  expect(settled).toEqual([]);
  await type('Endpoint', 'https://app.example.test');
  await act(async () => { await page.press(await addButton(page)); });
  expect(settled).toEqual([expect.objectContaining({ kind: 'completed', input: expect.objectContaining({ alerts, investigation }) })]);
});

it('saves explicit alert Off without discarding the check draft or sending a diagnostic', async () => {
  const calls: unknown[] = [];
  const { page, settled } = await mount({ initialInput: { v: 1, subject, alerts: { channels: [{
    channelId: 'saved-channel', destination: { connectionId: 'production' },
  }], phases: ['open', 'recovered'] } } }, {
    executeAction: async request => { calls.push(request); return { items: [] }; },
  });
  await act(async () => { await page.press(await page.getByRole('button', { name: 'Turn alerts off' })); });
  await type('Endpoint', 'https://app.example.test');
  await act(async () => { await page.press(await addButton(page)); });
  expect(settled).toEqual([expect.objectContaining({ kind: 'completed', input: expect.objectContaining({
    alerts: { channels: [], phases: ['open', 'recovered'] }, checks: [expect.objectContaining({
      config: expect.objectContaining({ endpoint: 'https://app.example.test' }),
    })],
  }) })]);
  expect(calls).toEqual([]);
});

it('preserves the saved subject alert destination when adding another check without sending on open', async () => {
  const calls: unknown[] = [];
  const alerts = { channels: [{ channelId: 'happier.channel.slack/alerts', destination: {
    connectionId: 'production-slack', endpoint: { kind: 'shared', audience: 'shared', id: 'slack:T1:channel:C1' },
  } }], phases: ['open', 'recovered'] };
  const { page, settled } = await mount({ initialInput: { v: 1, subject, alerts } }, {
    executeAction: async request => { calls.push(request); return { items: [] }; },
  });
  expect(calls).toEqual([]);
  await expect(page.getByText('Alerts')).resolves.toBeDefined();
  await act(async () => {
    const tcp = (await page.getAllByRole('radio')).find(target => target.name?.startsWith('TCP'));
    expect(tcp).toBeDefined();
    await page.press(tcp!);
  });
  await type('Host', 'db.internal');
  await type('Port', '5432');
  await act(async () => { await page.press(await addButton(page)); });
  expect(settled).toEqual([expect.objectContaining({ kind: 'completed', input: expect.objectContaining({ alerts }) })]);
  expect(calls).toEqual([]);
});

it('changes saved alert phases while retaining the selected destination and check draft', async () => {
  const channels = [{ channelId: 'saved-channel', destination: { connectionId: 'production' } }];
  const { page, settled } = await mount({ initialInput: { v: 1, subject, alerts: {
    channels, phases: ['open', 'recovered'],
  } } });
  await act(async () => { await page.press(await page.getByRole('radio', { name: 'Recovery only' })); });
  await type('Endpoint', 'https://app.example.test');
  await act(async () => { await page.press(await addButton(page)); });
  expect(settled).toEqual([expect.objectContaining({ kind: 'completed', input: expect.objectContaining({
    alerts: { channels, phases: ['recovered'] },
  }) })]);
});

it('changes a saved alert destination through the host picker and keeps the draft when the next selection is cancelled', async () => {
  const requests: unknown[] = [];
  const channelId = 'happier.channel.slack/alerts';
  const original = { connectionId: 'production-slack', endpoint: { kind: 'shared', audience: 'shared', id: 'old-room' } };
  const destination = { connectionId: 'production-slack', endpoint: { kind: 'shared', audience: 'shared', id: 'new-room', label: 'Deploy alerts' } };
  const { page, settled } = await mount({ initialInput: { v: 1, subject,
    alerts: { channels: [{ channelId, destination: original }], phases: ['recovered'] } } }, {
    selectActionInput: async request => {
      requests.push(request);
      return requests.length === 1 ? { kind: 'notificationDestination', channel: { channelId, destination } }
        : { kind: 'cancelled' };
    },
    executeAction: async () => { throw new Error('Choosing a destination must not send'); },
  });
  expect(requests).toEqual([]);
  await act(async () => { await page.press(await page.getByRole('button', { name: 'Change destination' })); });
  await act(async () => { await page.press(await page.getByRole('button', { name: 'Change destination' })); });
  expect(requests).toHaveLength(2);
  await type('Endpoint', 'https://app.example.test');
  await act(async () => { await page.press(await addButton(page)); });
  expect(settled).toEqual([expect.objectContaining({ kind: 'completed', input: expect.objectContaining({
    alerts: { channels: [{ channelId, destination }], phases: ['recovered'] },
  }) })]);
});

it('adds an alert destination to explicit Off without discarding the check draft', async () => {
  const channel = { channelId: 'happier.channel.slack/alerts', destination: {
    connectionId: 'production-slack', endpoint: { kind: 'shared', audience: 'shared', id: 'deploys' },
  } };
  const { page, settled } = await mount({ initialInput: { v: 1, subject, alerts: { channels: [], phases: ['open'] } } }, {
    selectActionInput: async () => ({ kind: 'notificationDestination', channel }),
  });
  await type('Endpoint', 'https://app.example.test');
  await act(async () => { await page.press(await page.getByRole('button', { name: 'Add destination' })); });
  await act(async () => { await page.press(await addButton(page)); });
  expect(settled).toEqual([expect.objectContaining({ kind: 'completed', input: expect.objectContaining({
    alerts: { channels: [channel], phases: ['open'] }, checks: [expect.objectContaining({
      config: expect.objectContaining({ endpoint: 'https://app.example.test' }),
    })],
  }) })]);
});

it('removes one alert destination while retaining another saved destination and its phases', async () => {
  const kept = { channelId: 'happier.channel.telegram/alerts', destination: { connectionId: 'telegram',
    endpoint: { kind: 'shared', audience: 'shared', id: 'telegram-room' } } };
  const { page, settled } = await mount({ initialInput: { v: 1, subject,
    alerts: { channels: [{ channelId: 'health-push' }, kept], phases: ['recovered'] } } });
  await act(async () => { await page.press((await page.getAllByRole('button', { name: 'Remove destination' }))[0]!); });
  await type('Endpoint', 'https://app.example.test');
  await act(async () => { await page.press(await addButton(page)); });
  expect(settled).toEqual([expect.objectContaining({ kind: 'completed', input: expect.objectContaining({
    alerts: { channels: [kept], phases: ['recovered'] },
  }) })]);
});

it('tests only the unchanged saved alert through the host Action control and shows its settlement', async () => {
  type ControlHandler = NonNullable<NonNullable<Parameters<typeof createPluginUiTestkit>[0]['handlers']>['actionControl']>;
  type ControlInput = Parameters<ControlHandler>[0];
  type Binding = Extract<ControlInput['request'], { kind: 'bind' }>;
  let control: { presentation: Binding['presentation']; publish: ControlInput['publish'] } | undefined;
  const sent: unknown[] = [];
  const testContext = { serverId: 'home', machineId: subject.machineId,
    sourceInstanceId: createHealthCheckSourceInstanceIdV1(subject), expectedSourceRevision: '7' };
  const alerts = { channels: [{ channelId: 'happier.channel.slack/alerts', destination: {
    connectionId: 'production-slack', endpoint: { kind: 'shared', audience: 'shared', id: 'deploys' },
  } }], phases: ['open', 'recovered'] };
  const input = { v: 1, subject, alerts };
  const { page } = await mount({ initialInput: input }, {
    actionControl: ({ request, publish }) => {
      if (request.kind === 'bind') {
        expect(request.action).toBe('notifications.test');
        control = { presentation: request.presentation, publish };
        return { dispose() { control = undefined; } };
      }
      if (request.kind === 'update') { if (control) control.presentation = request.presentation; return; }
      if (request.preparation) {
        sent.push(request.preparation.input);
        publish({ kind: 'settled', requestId: request.requestId, execution: { ok: true,
          result: { status: 'sent', controllerMachineId: subject.machineId, channelId: alerts.channels[0]!.channelId } } });
      }
    },
  }, async () => ({ mode: 'preview', sourceConfig: input, testContext }));
  await vi.waitFor(() => expect(control).toBeDefined());
  expect(sent).toEqual([]);
  await act(async () => { control!.publish({ kind: 'prepare', requestId: 'person-test-gesture' }); });
  await vi.waitFor(() => expect(sent).toEqual([{ ...testContext, channelId: alerts.channels[0]!.channelId, channelIndex: 0 }]));
  await expect(page.getByText('Test sent')).resolves.toBeDefined();
  await act(async () => { await page.press(await page.getByRole('radio', { name: 'Recovery only' })); });
  await vi.waitFor(() => expect(control?.presentation.disabled).toBe(true));
});

it('keeps Test unavailable when alert choices change before saved preparation completes', async () => {
  const alerts = { channels: [{ channelId: 'saved-provider' }], phases: ['open', 'recovered'] };
  const input = { v: 1, subject, alerts };
  let finishPreview: (value: JsonValue) => void = () => { throw new Error('Preview transport not initialized'); };
  const pending = new Promise<JsonValue>(resolve => { finishPreview = resolve; });
  let bindings = 0;
  const { page } = await mount({ initialInput: input }, {
    actionControl: ({ request }) => { if (request.kind === 'bind') { bindings++; return { dispose() {} }; } },
  }, async () => pending);
  await act(async () => { await page.press(await page.getByRole('radio', { name: 'Recovery only' })); });
  await act(async () => { finishPreview({ mode: 'preview', sourceConfig: input, testContext: {
    serverId: 'home', machineId: subject.machineId, sourceInstanceId: createHealthCheckSourceInstanceIdV1(subject), expectedSourceRevision: '7',
  } }); });
  expect(bindings).toBe(0);
});

it('maps a named Kuma monitor through the saved check setup without accepting a payload subject', async () => {
  const { page, settled } = await mount({ initialInput: { v: 1, subject } });
  await act(async () => {
    const tile = (await page.getAllByRole('radio')).find(target => target.name?.startsWith('Uptime Kuma'));
    expect(tile).toBeDefined();
    await page.press(tile!);
  });
  await type('Monitor ID', '7');
  await act(async () => { await page.press(await addButton(page)); });
  expect(settled).toEqual([expect.objectContaining({ kind: 'completed', input: expect.objectContaining({ subject,
    checks: [expect.objectContaining({ kind: { pluginId: MACHINE_SERVICES_PLUGIN_ID, localId: 'uptime-kuma' },
      config: { monitorId: '7' }, binding: { kind: 'healthCheck' } })] }) })]);
});

it('maps a Gatus endpoint with an empty group and requires its name before saving', async () => {
  const { page, settled } = await mount({ initialInput: { v: 1, subject } });
  await act(async () => {
    const tile = (await page.getAllByRole('radio')).find(target => target.name?.startsWith('Gatus'));
    expect(tile).toBeDefined();
    await page.press(tile!);
  });
  expect((await addButton(page)).state?.disabled).toBe(true);
  await type('Endpoint name', 'Shop');
  await act(async () => { await page.press(await addButton(page)); });
  expect(settled).toEqual([expect.objectContaining({ kind: 'completed', input: expect.objectContaining({
    checks: [expect.objectContaining({ kind: { pluginId: MACHINE_SERVICES_PLUGIN_ID, localId: 'gatus' },
      config: { endpointGroup: '', endpointName: 'Shop' }, consecutiveFailuresBeforeAlerting: 1 })],
  }) })]);
});

it('checks a saved Domain through its declared finite Action and preserves its result when a retry is unavailable', async () => {
  const calls: unknown[] = [];
  let refuse = false;
  const check = { checkId: 'public-http', kind: { pluginId: MACHINE_SERVICES_PLUGIN_ID, localId: 'http' },
    binding: { kind: 'domain', domainId: 'shop-domain', targetLinkId: 'shop-target', condition: 'domain_probe_failed' },
    config: {}, periodMs: 60_000, consecutiveFailuresBeforeAlerting: 2 };
  const environment = { kind: 'environment', environmentId: 'production' };
  const { page } = await mount({ initialInput: { v: 1, subject: environment, checks: [check] } }, {
    executeAction: async ({ action, input }) => {
      calls.push({ action, input });
      if (typeof action === 'object' && action.localId === 'health/kinds') return [{
        pluginId: MACHINE_SERVICES_PLUGIN_ID, id: 'http', title: 'HTTP', action: 'health/http',
        configSchema: { type: 'object', additionalProperties: false, properties: {} },
      }];
      if (refuse) throw new Error('observer unavailable');
      return { status: 'up', observedAt: 1000, evidence: { v: 1, items: [{
        source: { kind: 'alert', label: 'Domain check' }, author: { kind: 'process' }, text: 'HTTP status 200',
      }] } };
    },
  });
  expect(calls).toEqual([]);
  await act(async () => { await page.press(await page.getByRole('button', { name: 'Check now' })); });
  expect(calls).toEqual([expect.objectContaining({ action: { pluginId: MACHINE_SERVICES_PLUGIN_ID, localId: 'health/kinds' } }),
    expect.objectContaining({ action: 'action.invoke', input: expect.objectContaining({
      action: { pluginId: MACHINE_SERVICES_PLUGIN_ID, localId: 'health/http' },
      input: expect.objectContaining({ checkId: 'public-http', sourceInstanceId: expect.stringMatching(/^health:/) }),
    }) })]);
  await expect(page.getByText('Up')).resolves.toBeDefined();
  refuse = true;
  await act(async () => { await page.press(await page.getByRole('button', { name: 'Check now' })); });
  await expect(page.getByText('Up')).resolves.toBeDefined();
  await expect(page.getByText('The check could not run. Try again when its Machine is available.')).resolves.toBeDefined();
});

it('adds a declared contributed kind with its closed configuration through the same saved setup', async () => {
  const calls: unknown[] = [];
  const { page, settled } = await mount({ initialInput: { v: 1, subject } }, {
    executeAction: async request => {
      calls.push(request);
      return [{ pluginId: 'com.example.health', id: 'external-health', title: 'External service', action: 'health/read',
        configSchema: { type: 'object', additionalProperties: false, properties: { monitorId: { type: 'string' } }, required: ['monitorId'] } }];
    },
  });
  expect(calls).toEqual([]);
  await act(async () => { await page.press(await page.getByRole('button', { name: 'More checks' })); });
  await expect(page.getByText('External service')).resolves.toBeDefined();
  expect((await addButton(page)).state?.disabled).toBe(true);
  await type('Configuration', '{"monitorId":"shop","endpoint":"https://other.example"}');
  expect((await addButton(page)).state?.disabled).toBe(true);
  await type('Configuration', '{"monitorId":"shop"}');
  await act(async () => { await page.press(await addButton(page)); });
  expect(calls).toHaveLength(1);
  expect(settled).toEqual([expect.objectContaining({ kind: 'completed', input: expect.objectContaining({ subject,
    checks: [expect.objectContaining({ kind: { pluginId: 'com.example.health', localId: 'external-health' },
      config: { monitorId: 'shop' }, binding: { kind: 'healthCheck' } })] }) })]);
});

it('enables the default Domain checks only after accepting cadence and preserves sibling checks', async () => {
  const sibling = { checkId: 'database', kind: { pluginId: MACHINE_SERVICES_PLUGIN_ID, localId: 'tcp' },
    binding: { kind: 'healthCheck' }, config: { host: 'db.internal', port: 5432 }, periodMs: 300_000, consecutiveFailuresBeforeAlerting: 3 };
  const environment = { kind: 'environment', environmentId: 'production' };
  const domain = { domainId: 'public-domain', targetLinkId: 'serving-target' };
  const { page, settled } = await mount({ initialInput: { v: 1, subject: environment, domain, checks: [sibling] } });
  expect(settled).toEqual([]);
  await act(async () => { await page.press(await page.getByRole('button', { name: 'Enable checks' })); });
  expect(settled).toEqual([expect.objectContaining({ kind: 'completed', input: expect.objectContaining({
    subject: environment, checks: [sibling,
      expect.objectContaining({ kind: { pluginId: MACHINE_SERVICES_PLUGIN_ID, localId: 'http' }, config: {},
        binding: { kind: 'domain', ...domain, condition: 'domain_probe_failed' }, periodMs: 60_000, consecutiveFailuresBeforeAlerting: 1 }),
      expect.objectContaining({ kind: { pluginId: MACHINE_SERVICES_PLUGIN_ID, localId: 'certificate' }, config: {},
        binding: { kind: 'domain', ...domain, condition: 'certificate_renewal_failed' }, periodMs: 60_000, consecutiveFailuresBeforeAlerting: 1 })],
  }) })]);
});

it('replaces a Domain condition producer with a monitor while retaining its check identity and certificate sibling', async () => {
  const domain = { domainId: 'public-domain', targetLinkId: 'serving-target' };
  const http = { checkId: 'public-http', kind: { pluginId: MACHINE_SERVICES_PLUGIN_ID, localId: 'http' },
    binding: { kind: 'domain', ...domain, condition: 'domain_probe_failed' }, config: {},
    periodMs: 300_000, consecutiveFailuresBeforeAlerting: 3 };
  const certificate = { ...http, checkId: 'public-certificate', kind: { ...http.kind, localId: 'certificate' },
    binding: { ...http.binding, condition: 'certificate_renewal_failed' } };
  const { page, settled } = await mount({ initialInput: { v: 1,
    subject: { kind: 'environment', environmentId: 'production' }, domain, checks: [http, certificate] } });
  await act(async () => {
    const kuma = (await page.getAllByRole('radio')).find(target => target.name?.startsWith('Uptime Kuma'));
    expect(kuma).toBeDefined();
    await page.press(kuma!);
  });
  await type('Monitor ID', '7');
  await act(async () => { await page.press(await addButton(page)); });
  expect(settled).toEqual([expect.objectContaining({ kind: 'completed', input: expect.objectContaining({ checks: [
    expect.objectContaining({ checkId: 'public-http', kind: { pluginId: MACHINE_SERVICES_PLUGIN_ID, localId: 'uptime-kuma' },
      binding: http.binding, config: { monitorId: '7' } }), certificate,
  ] }) })]);
});

it('keeps a saved monitor address hidden until person reveal and copies only its accepted POST method', async () => {
  const calls: unknown[] = [];
  const copied: string[] = [];
  const endpointId = 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA';
  const { page } = await mount({ initialInput: { v: 1, subject, checks: [{ checkId: 'shop-monitor',
    kind: { pluginId: MACHINE_SERVICES_PLUGIN_ID, localId: 'uptime-kuma' }, binding: { kind: 'healthCheck' },
    config: { monitorId: '7', webhookEndpointId: endpointId, observingSince: 100 }, periodMs: 60_000, consecutiveFailuresBeforeAlerting: 2 }] } }, {
    executeAction: async ({ action, input }) => {
      calls.push({ action, input });
      return { webhookEndpointId: endpointId, revision: 1, publicUrl: 'https://happier.example/private-monitor-route' };
    },
    writeClipboard: async ({ value }) => { copied.push(value); },
  });
  expect(calls).toEqual([]);
  expect(document.body.textContent).not.toContain('private-monitor-route');
  await act(async () => { await page.press(await page.getByRole('button', { name: 'Reveal address' })); });
  await act(async () => { await page.press(await page.getByRole('button', { name: 'Copy POST command' })); });
  expect(copied).toEqual(["curl -fsS -X POST 'https://happier.example/private-monitor-route'"]);
  expect((await page.getAllByRole('button')).some(button => button.name === 'Copy GET command')).toBe(false);
});

it('reveals the heartbeat address only on request and rotates it through the contributed Action', async () => {
  const calls: unknown[] = [];
  const copied: string[] = [];
  const endpointId = 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA';
  const { page } = await mount({ initialInput: { v: 1, subject, checks: [{ checkId: 'heartbeat',
    kind: { pluginId: MACHINE_SERVICES_PLUGIN_ID, localId: 'heartbeat' }, binding: { kind: 'healthCheck' },
    config: { graceMs: 60_000, webhookEndpointId: endpointId }, periodMs: 60_000, consecutiveFailuresBeforeAlerting: 2 }] } }, {
    executeAction: async ({ action, input }) => {
      calls.push({ action, input });
      return action === 'plugin.webhook.endpoint.read'
        ? { webhookEndpointId: endpointId, revision: 1, publicUrl: 'https://happier.example/secret-capability' }
        : input !== null && typeof input === 'object' && !Array.isArray(input) && input.operation === 'revoke'
          ? { kind: 'revoked', webhookEndpointId: endpointId, revision: 3 }
          : { kind: 'rotated', webhookEndpointId: endpointId, revision: 2 };
    },
    writeClipboard: async ({ value }) => { copied.push(value); },
  });
  expect(calls).toEqual([]);
  expect(document.body.textContent).not.toContain('secret-capability');
  await act(async () => { await page.press(await page.getByRole('button', { name: 'Reveal address' })); });
  await act(async () => { await page.press(await page.getByRole('button', { name: 'Copy POST command' })); });
  expect(copied).toEqual(["curl -fsS -X POST 'https://happier.example/secret-capability'"]);
  await act(async () => { await page.press(await page.getByRole('button', { name: 'Rotate address' })); });
  expect(calls).toEqual([expect.objectContaining({ action: 'plugin.webhook.endpoint.read' }),
    expect.objectContaining({ action: { pluginId: MACHINE_SERVICES_PLUGIN_ID, localId: 'health/heartbeat/manage' },
      input: expect.objectContaining({ operation: 'rotate', webhookEndpointId: endpointId, checkId: 'heartbeat', expectedRevision: 1 }) })]);
  expect(document.body.textContent).not.toContain('secret-capability');
  await expect(page.getByRole('button', { name: 'Reveal address' })).resolves.toBeDefined();
  await act(async () => { await page.press(await page.getByRole('button', { name: 'Revoke address' })); });
  expect(calls.at(-1)).toMatchObject({ action: { pluginId: MACHINE_SERVICES_PLUGIN_ID, localId: 'health/heartbeat/manage' },
    input: { operation: 'revoke', webhookEndpointId: endpointId, expectedRevision: 2 } });
  expect((await page.getAllByRole('button')).some(button => button.name === 'Reveal address')).toBe(false);
  expect(document.body.textContent).not.toContain('secret-capability');
});

it('keeps automatic investigation as an explicit source-local choice when adding a check', async () => {
  const investigation = { mode: 'auto_start', configuredActionId: 'investigate-production' };
  const { page, settled } = await mount({ initialInput: { v: 1, subject } });
  await act(async () => {
    const automatic = (await page.getAllByRole('radio')).find(target => target.name?.startsWith('Start investigation'));
    expect(automatic).toBeDefined();
    await page.press(automatic!);
  });
  await type('Configured investigation', investigation.configuredActionId);
  await act(async () => {
    const tcp = (await page.getAllByRole('radio')).find(target => target.name?.startsWith('TCP'));
    expect(tcp).toBeDefined();
    await page.press(tcp!);
  });
  await type('Host', 'db.internal');
  await type('Port', '5432');
  await act(async () => { await page.press(await addButton(page)); });
  expect(settled).toEqual([expect.objectContaining({ kind: 'completed', input: expect.objectContaining({ investigation }) })]);
});

it('authors one TCP check for the prebound watched service and settles the canonical setup input', async () => {
  const { page, settled } = await mount({ initialInput: { v: 1, subject } });
  await act(async () => {
    const tcp = (await page.getAllByRole('radio')).find(target => target.name?.startsWith('TCP'));
    expect(tcp, 'TCP kind tile').toBeDefined();
    await page.press(tcp!);
  });
  expect((await addButton(page)).state?.disabled).toBe(true);
  await type('Host', 'db.internal');
  await type('Port', '70000');
  await expect(
    page.getByText('Use a port from 1 to 65535.'),
  ).resolves.toBeDefined();
  await type('Port', '5432');
  await act(async () => {
    await page.press(await addButton(page));
  });
  expect(settled).toEqual([
    {
      kind: 'completed',
      input: {
        v: 1,
        subject,
        investigation: { mode: 'inbox' },
        alerts: { channels: [], phases: ['open', 'recovered'] },
        checks: [
          {
            checkId: 'tcp',
            kind: { pluginId: MACHINE_SERVICES_PLUGIN_ID, localId: 'tcp' },
            binding: { kind: 'healthCheck' },
            config: { host: 'db.internal', port: 5432 },
            periodMs: 60_000,
            consecutiveFailuresBeforeAlerting: 1,
          },
        ],
      },
    },
  ]);
});

it('refuses a loopback endpoint in place when another Machine runs the check, and allows it on the service’s own Machine', async () => {
  const outside = await mount({
    initialInput: { v: 1, subject },
    observerMachineId: 'build-01',
  });
  await type('Endpoint', 'http://127.0.0.1:3001');
  await expect(
    outside.page.getByText('This address means the Machine running the check'),
  ).resolves.toBeDefined();
  expect((await addButton(outside.page)).state?.disabled).toBe(true);
  await type('Endpoint', 'https://status.example.com');
  expect(
    await outside.page.queryByText(
      'This address means the Machine running the check',
    ),
  ).toBeUndefined();
  expect((await addButton(outside.page)).state?.disabled ?? false).toBe(false);
  await mounted?.dispose();
  mounted = undefined;

  const self = await mount({
    initialInput: { v: 1, subject },
    observerMachineId: 'shop-prod',
  });
  await type('Endpoint', 'http://127.0.0.1:3001');
  expect(
    await self.page.queryByText(
      'This address means the Machine running the check',
    ),
  ).toBeUndefined();
  await act(async () => {
    await self.page.press(await addButton(self.page));
  });
  expect(self.settled).toMatchObject([
    {
      kind: 'completed',
      input: {
        checks: [
          {
            checkId: 'http',
            config: { endpoint: 'http://127.0.0.1:3001', expectStatus: 200 },
          },
        ],
      },
    },
  ]);
});

it('adds beside checks the source already holds instead of replacing them', async () => {
  const existing = {
    checkId: 'http',
    kind: { pluginId: MACHINE_SERVICES_PLUGIN_ID, localId: 'http' },
    binding: { kind: 'healthCheck' },
    config: { endpoint: 'https://status.example.com', expectStatus: 200 },
    periodMs: 60_000,
    consecutiveFailuresBeforeAlerting: 2,
  };
  const { page, settled } = await mount({
    initialInput: { v: 1, subject, checks: [existing] },
  });
  await type('Endpoint', 'https://shop.example.com/health');
  await act(async () => {
    await page.press(await addButton(page));
  });
  expect(settled).toMatchObject([
    {
      kind: 'completed',
      input: {
        checks: [
          existing,
          {
            checkId: 'http-2',
            config: {
              endpoint: 'https://shop.example.com/health',
              expectStatus: 200,
            },
          },
        ],
      },
    },
  ]);
});

it('explains itself instead of showing a form when no watched service is bound', async () => {
  const { page, settled } = await mount({ initialInput: { v: 1 } });
  await expect(
    page.getByText(
      'Open Add check from a watched service to set up its check.',
    ),
  ).resolves.toBeDefined();
  expect(
    await page.queryByRole('button', { name: 'Add check' }),
  ).toBeUndefined();
  expect(settled).toEqual([]);
});
