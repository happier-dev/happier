// @vitest-environment jsdom
import { act } from 'react';
import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import { TelemetryKeyFlowConfigV1Schema } from '@happier-dev/plugin-sdk/database';
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
const destinationSelectionContext = { serverId: 'home', machineId: subject.machineId };

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
            return { mode: 'preview', destinationSelectionContext,
              sourceConfig: { ...sourceConfig, alerts: sourceConfig.alerts ?? { channels: [], phases: ['open', 'recovered'] } } };
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

it('reopens Add check with the incomplete form entered before changing the watcher', async () => {
  const { page, settled } = await mount({ observerMachineId: 'peer-watcher', initialInput: {
    v: 1, subject, rendererDraft: { check: { kind: 'http', endpoint: 'https://app.example.test', expectStatus: '20' } },
  } });
  expect(document.querySelector<HTMLInputElement>('input[aria-label="Endpoint"]')?.value).toBe('https://app.example.test');
  expect(document.querySelector<HTMLInputElement>('input[aria-label="Expect status"]')?.value).toBe('20');
  expect(settled).toEqual([]);

  await type('Expect status', '204');
  await act(async () => { await page.press(await addButton(page)); });
  expect(settled).toEqual([expect.objectContaining({ kind: 'completed', input: expect.objectContaining({
    checks: [expect.objectContaining({ config: { endpoint: 'https://app.example.test', expectStatus: 204 } })],
  }) })]);
});

it('does not offer to turn alerts off while Add check waits for its read-only preview', async () => {
  const calls: unknown[] = [];
  let finishPreview: (value: JsonValue) => void = () => {};
  const pending = new Promise<JsonValue>(resolve => { finishPreview = resolve; });
  const { page, settled } = await mount({ initialInput: { v: 1, subject } }, {}, async request => {
    calls.push(request);
    return pending;
  });
  await type('Endpoint', 'https://app.example.test');
  expect((await addButton(page)).state?.disabled).toBe(true);
  expect(await page.queryByRole('button', { name: 'Turn alerts off' })).toBeUndefined();
  await expect(page.getByText('Loading alert defaults…')).resolves.toBeDefined();
  await act(async () => { finishPreview({ mode: 'preview', destinationSelectionContext,
    sourceConfig: { v: 1, subject, alerts: { channels: [], phases: ['open', 'recovered'] } } }); });
  await expect(page.getByText('Off')).resolves.toBeDefined();
  expect((await addButton(page)).state?.disabled).not.toBe(true);
  expect(await page.queryByText('Loading alert defaults…')).toBeUndefined();
  expect(calls).toEqual([expect.objectContaining({ input: expect.objectContaining({ mode: 'preview' }) })]);
  expect(settled).toEqual([]);
});

it('states why Add check is disabled when a required field is missing', async () => {
  const { page } = await mount({ initialInput: { v: 1, subject } });
  await expect(page.getByText('Fill in the required fields to add this check.')).resolves.toBeDefined();
  expect((await addButton(page)).state?.disabled).toBe(true);
  await type('Endpoint', 'https://app.example.test');
  expect((await addButton(page)).state?.disabled).not.toBe(true);
  expect(await page.queryByText('Fill in the required fields to add this check.')).toBeUndefined();
});

it('explains why Environment alert defaults failed and retries without losing the check', async () => {
  const environment = { kind: 'environment', environmentId: 'production' } as const;
  let attempt = 0;
  const { page, settled } = await mount({ initialInput: { v: 1, subject: environment } }, {}, async () => {
    if (++attempt === 1) throw new PluginError({ code: 'account_settings_unavailable',
      message: 'The Account settings could not be read.' });
    return { mode: 'preview', destinationSelectionContext,
      sourceConfig: { v: 1, subject: environment, alerts: { channels: [], phases: ['open', 'recovered'] } } };
  });
  await type('Endpoint', 'https://app.example.test');
  await expect(page.getByText('The Account settings could not be read.')).resolves.toBeDefined();
  expect((await addButton(page)).state?.disabled).toBe(true);
  await act(async () => { await page.press(await page.getByRole('button', { name: 'Retry alert defaults' })); });
  await act(async () => { await page.press(await addButton(page)); });
  expect(attempt).toBe(2);
  expect(settled).toEqual([expect.objectContaining({ kind: 'completed', input: expect.objectContaining({
    subject: environment, checks: [expect.objectContaining({ config: { endpoint: 'https://app.example.test', expectStatus: 200 } })],
  }) })]);
});

it('prefills first Configure alert defaults without exposing legacy auto_start investigation', async () => {
  const calls: unknown[] = [];
  const investigation = { mode: 'inbox' as const };
  const alerts = { channels: [{ channelId: 'saved-channel' }], phases: ['open'] };
  let finishPreview: (value: JsonValue) => void = () => { throw new Error('Preview transport not initialized'); };
  const pendingPreview = new Promise<JsonValue>(resolve => { finishPreview = resolve; });
  const { page, settled } = await mount({ initialInput: { v: 1, subject, investigation } }, {}, async request => {
      calls.push(request);
      return pendingPreview;
    });
  await type('Endpoint', 'https://app.example.test');
  expect((await addButton(page)).state?.disabled ?? false).toBe(true);
  expect((await page.getByRole('button', { name: 'Add destination' })).state?.disabled ?? false).toBe(true);
  await act(async () => { finishPreview({ mode: 'preview', destinationSelectionContext,
    sourceConfig: { v: 1, subject, investigation, alerts } }); });
  expect((await page.getByRole('button', { name: 'Add destination' })).state?.disabled ?? false).toBe(false);
  await expect(page.getByRole('radio', { name: 'Failure only' })).resolves.toBeDefined();
  expect((await page.getAllByRole('radio')).find(target => target.name?.startsWith('Start investigation'))).toBeUndefined();
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
  const requests: unknown[] = [];
  const channel = { channelId: 'happier.channel.slack/alerts', destination: {
    connectionId: 'production-slack', endpoint: { kind: 'shared', audience: 'shared', id: 'deploys' },
  } };
  const { page, settled } = await mount({ initialInput: { v: 1, subject, alerts: { channels: [], phases: ['open'] } } }, {
    selectActionInput: async request => { requests.push(request); return { kind: 'notificationDestination', channel }; },
  });
  await type('Endpoint', 'https://app.example.test');
  await act(async () => { await page.press(await page.getByRole('button', { name: 'Add destination' })); });
  expect(requests).toMatchObject([{ request: { target: destinationSelectionContext } }]);
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
      if (refuse) throw new Error('observer unavailable');
      return { status: 'up', observedAt: 1000, evidence: { v: 1, items: [{
        source: { kind: 'alert', label: 'Domain check' }, author: { kind: 'process' }, text: 'HTTP status 200',
      }] } };
    },
  });
  expect(calls).toEqual([]);
  await act(async () => { await page.press(await page.getByRole('button', { name: 'Check now' })); });
  expect(calls).toEqual([expect.objectContaining({ action: { pluginId: MACHINE_SERVICES_PLUGIN_ID, localId: 'health/http' },
      input: expect.objectContaining({ checkId: 'public-http', sourceInstanceId: expect.stringMatching(/^health:/) }),
    })]);
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
  // The kind's declared field, not a JSON box: an empty required field keeps the check unavailable.
  await type('Monitor id', 'shop');
  await act(async () => { await page.press(await addButton(page)); });
  expect(calls).toHaveLength(1);
  expect(settled).toEqual([expect.objectContaining({ kind: 'completed', input: expect.objectContaining({ subject,
    checks: [expect.objectContaining({ kind: { pluginId: 'com.example.health', localId: 'external-health' },
      config: { monitorId: 'shop' }, binding: { kind: 'healthCheck' } })] }) })]);
});

// The manifest round-trip sorts property keys, putting Spend's costMode before its kind.
const keyFlowSchema: JsonValue = JSON.parse(JSON.stringify(TelemetryKeyFlowConfigV1Schema.jsonSchema,
  (key, value: unknown) => key === 'properties' && value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : Number(left > right)))
    : value,
));

it.each(['new', 'saved', 'from-route', 'from-route-to-spend', 'from-trace-error-rate'] as const)('authors a Key flow through its declared schema (%s)', async mode => {
  const saved = mode === 'saved';
  const spend = mode === 'from-route-to-spend';
  const fromTrace = mode === 'from-trace-error-rate';
  const seeded = mode === 'from-route' || spend || fromTrace;
  const serviceName = fromTrace ? 'DBW R4 control/R4 control' : 'billing-api';
  const method = fromTrace ? 'GET' : 'POST';
  const value = fromTrace ? 0.25 : 800;
  const existing = { checkId: 'saved-checkout', kind: { pluginId: 'happier.telemetry', localId: 'key-flow' },
    binding: { kind: 'healthCheck' },
    config: { environmentId: 'env-prod', serviceName,
      measure: { kind: 'route', routes: [{ method, route: '/checkout' }], statistic: 'p95' },
      windowMs: 600_000, threshold: { operator: 'above', value: 450 } },
    periodMs: 300_000, consecutiveFailuresBeforeAlerting: 3,
  } as const;
  const { page, settled } = await mount({ initialInput: { v: 1,
    subject: seeded ? { kind: 'environment', environmentId: 'env-prod' } : subject,
    ...(saved ? { checks: [existing], selectedCheckId: existing.checkId } : {}),
    ...(seeded ? { newContributedCheck: { kind: existing.kind,
      config: { environmentId: existing.config.environmentId, serviceName: existing.config.serviceName,
        measure: existing.config.measure } } } : {}),
  } }, {
    executeAction: async () => [{ pluginId: 'happier.telemetry', id: 'key-flow', title: 'Key flow', action: 'health/key-flow',
      configSchema: keyFlowSchema }],
  });
  const field = (label: string) => document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (saved) {
    await vi.waitFor(() => expect(field('Route')?.value).toBe('/checkout'));
    expect(field('Value')?.value).toBe('450');
  } else if (seeded) {
    const measure = await page.findByRole('button', { name: 'Measure: Route' });
    if (spend) {
      await act(async () => { await page.press(measure); });
      await expect(page.getByRole('menuitemradio', { name: 'Route' })).resolves.toBeDefined();
      await expect(page.getByRole('menuitemradio', { name: 'Runtime' })).resolves.toBeDefined();
      await act(async () => { await page.press(await page.getByRole('menuitemradio', { name: 'Spend' })); });
      await expect(page.getByRole('button', { name: 'Measure: Spend' })).resolves.toBeDefined();
    } else {
      expect(field('Route')?.value).toBe('/checkout');
      expect(field('Method')?.value).toBe(method);
    }
    expect(field('Service name')?.value).toBe(serviceName);
    if (fromTrace) {
      await act(async () => { await page.press(await page.getByRole('button', { name: 'Statistic: P95' })); });
      await act(async () => { await page.press(await page.getByRole('menuitemradio', { name: 'Error rate' })); });
    }
    expect((await addButton(page)).state?.disabled).toBe(true);
    await type('Window ms', '600000');
  } else {
    await act(async () => { await page.press(await page.getByRole('button', { name: 'More checks' })); });
    expect(field('Configuration')).toBeNull();
    await type('Environment id', 'env-prod');
    await type('Service name', 'billing-api');
    await type('Method', 'POST');
    await type('Route', '/checkout');
    await type('Window ms', '600000');
    expect((await addButton(page)).state?.disabled).toBe(true);
  }
  await type('Value', String(value));
  await act(async () => {
    await page.press(await page.getByRole('button', { name: saved ? 'Save changes' : 'Add check' }));
  });
  expect(settled).toEqual([expect.objectContaining({ kind: 'completed', input: expect.objectContaining({
    checks: [expect.objectContaining({ checkId: saved ? existing.checkId : 'key-flow', kind: existing.kind,
      config: { environmentId: 'env-prod', serviceName,
        measure: spend ? { kind: 'spend', costMode: 'api_equivalent' }
          : { ...existing.config.measure, statistic: fromTrace ? 'errorRate' : mode === 'new' ? 'p50' : 'p95' },
        windowMs: 600_000, threshold: { operator: 'above', value } } })] }) })]);
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

it.each([
  { kind: 'uptime-kuma', label: 'Monitor ID', config: { monitorId: '7' }, value: '7', next: '8',
    editedConfig: { monitorId: '8' } },
  { kind: 'gatus', label: 'Endpoint name', config: { endpointGroup: 'production', endpointName: 'Shop' }, value: 'Shop', next: 'Store',
    editedConfig: { endpointGroup: 'production', endpointName: 'Store' } },
] as const)('restores the selected saved $kind fields and saves its existing check', async ({ kind, label, config, value, next, editedConfig }) => {
  const first = { checkId: 'http-check', kind: { pluginId: MACHINE_SERVICES_PLUGIN_ID, localId: 'http' },
    binding: { kind: 'healthCheck' }, config: { endpoint: 'https://shop.example.test', expectStatus: 200 },
    periodMs: 60_000, consecutiveFailuresBeforeAlerting: 1 };
  const mapping = { webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA', observingSince: 100 };
  const saved = { checkId: 'imported-check', kind: { pluginId: MACHINE_SERVICES_PLUGIN_ID, localId: kind },
    binding: { kind: 'healthCheck' }, config: { ...config, ...mapping }, periodMs: 300_000,
    consecutiveFailuresBeforeAlerting: 2 };
  const { page, settled } = await mount({ initialInput: { v: 1, subject, checks: [first, saved] } });
  await act(async () => { await page.press(await page.getByRole('button', { name: 'Saved check: http-check' })); });
  await act(async () => { await page.press(await page.getByRole('menuitemradio', { name: 'imported-check' })); });
  expect((await page.getByRole('button', { name: 'Saved check: imported-check' })).name).toContain('imported-check');
  expect(document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)?.value).toBe(value);
  expect(document.querySelector('input[aria-label="Endpoint"]')).toBeNull();
  await type(label, next);
  await act(async () => { await page.press(await page.getByRole('button', { name: 'Save changes' })); });
  expect(settled).toEqual([expect.objectContaining({ kind: 'completed', input: expect.objectContaining({
    checks: [first, { ...saved, config: { ...editedConfig, ...mapping } }],
  }) })]);
});

it.each([
  { kind: 'http', field: 'Endpoint', config: { endpoint: 'https://shop.example.test', expectStatus: 204, keyword: 'Ready' },
    fieldKey: 'endpoint', address: 'https://shop.example.test', editedAddress: 'https://new-shop.example.test' },
  { kind: 'certificate', field: 'Endpoint', config: { endpoint: 'https://shop.example.test', expectStatus: 200 },
    fieldKey: 'endpoint', address: 'https://shop.example.test', editedAddress: 'https://new-shop.example.test' },
  { kind: 'tcp', field: 'Host', config: { host: 'shop.example.test', port: 5432 },
    fieldKey: 'host', address: 'shop.example.test', editedAddress: 'new-shop.example.test' },
  { kind: 'dns', field: 'Name', config: { hostname: 'shop.example.test', recordType: 'AAAA', expectedAnswer: '2001:db8::1' },
    fieldKey: 'hostname', address: 'shop.example.test', editedAddress: 'new-shop.example.test' },
])('edits the selected saved $kind address without replacing the check or its siblings', async ({
  kind, field, config, fieldKey, address, editedAddress,
}) => {
  const first = { checkId: 'first-http', kind: { pluginId: MACHINE_SERVICES_PLUGIN_ID, localId: 'http' },
    binding: { kind: 'healthCheck' }, config: { endpoint: 'https://other.example.test', expectStatus: 200 },
    periodMs: 60_000, consecutiveFailuresBeforeAlerting: 1 };
  const saved = { ...first, checkId: 'shop-check', kind: { ...first.kind, localId: kind }, config,
    periodMs: 300_000, consecutiveFailuresBeforeAlerting: 3 };
  const { page, settled } = await mount({ initialInput: { v: 1, subject, checks: [first, saved], selectedCheckId: saved.checkId } });
  expect(document.querySelector<HTMLInputElement>(`input[aria-label="${field}"]`)?.value).toBe(address);
  await type(field, editedAddress);
  await act(async () => { await page.press(await page.getByRole('button', { name: 'Save changes' })); });
  expect(settled).toEqual([expect.objectContaining({ kind: 'completed', input: expect.objectContaining({
    checks: [first, { ...saved, config: { ...saved.config, [fieldKey]: editedAddress } }],
  }) })]);
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

it('omits legacy auto_start investigation choice and settles inbox mode when adding a check', async () => {
  const investigation = { mode: 'inbox' as const };
  const { page, settled } = await mount({ initialInput: { v: 1, subject } });
  expect((await page.getAllByRole('radio')).find(target => target.name?.startsWith('Start investigation'))).toBeUndefined();
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


it.each([false, true])('saves and reopens Environment notification choices with existing checks: %s', async hasCheck => {
  const environment = { kind: 'environment', environmentId: 'production' } as const;
  const check = { checkId: 'outside', kind: { pluginId: MACHINE_SERVICES_PLUGIN_ID, localId: 'tcp' },
    binding: { kind: 'healthCheck' }, config: { host: 'app.example.test', port: 443 },
    periodMs: 60000, consecutiveFailuresBeforeAlerting: 3 };
  const alerts = { channels: [{ channelId: 'saved-slack', destination: { connectionId: 'production' } }], phases: ['open'] };
  const investigation = { mode: 'inbox' as const };
  const { page, settled } = await mount({ initialInput: { v: 1, subject: environment } }, {
    selectActionInput: async () => ({ kind: 'notificationDestination', channel: alerts.channels[0]! }),
  }, async () => ({
    mode: 'preview', sourceConfig: { v: 1, subject: environment, ...(hasCheck ? { checks: [check] } : {}),
      alerts: hasCheck ? alerts : { channels: [], phases: ['open'] }, investigation },
    destinationSelectionContext: { serverId: 'home', machineId: 'controller' },
    testContext: { serverId: 'home', machineId: 'controller',
      sourceInstanceId: createHealthCheckSourceInstanceIdV1(environment), expectedSourceRevision: '9' },
  }));
  await act(async () => { await page.press(await page.getByRole('button', { name: hasCheck ? 'Turn alerts off' : 'Add destination' })); });
  const save = await page.getByRole('button', { name: 'Save changes' });
  expect(save.state?.disabled ?? false).toBe(false);
  await act(async () => { await page.press(save); });
  const savedAlerts = hasCheck ? { channels: [], phases: ['open'] } : alerts;
  expect(settled).toEqual([{ kind: 'completed', input: { v: 1, subject: environment, checks: hasCheck ? [check] : [],
    alerts: savedAlerts, investigation } }]);
  const saved = { v: 1, subject: environment, checks: hasCheck ? [check] : [],
    alerts: savedAlerts, investigation };
  await mounted?.dispose();
  const reopened = await mount({ initialInput: saved });
  // Reopened with checks, alerts save as changes; with none yet it is an Add check, whose one primary is Add check (R11-D1).
  if (hasCheck) expect((await reopened.page.getByRole('button', { name: 'Save changes' })).state?.disabled ?? false).toBe(false);
  else expect(await reopened.page.queryByRole('button', { name: 'Save changes' })).toBeUndefined();
  await expect(reopened.page.getByText(hasCheck ? 'Off' : 'saved-slack')).resolves.toBeDefined();
  expect(reopened.settled).toEqual([]);
});

// PAGE-ACCEPT-176 R10-D1, R11-D1: a new check's one primary reads "Add check" from the start, beside Cancel; only alerts
// changed with no check entered save as changes.
it('reads Add check from the start of an Environment Add check, and Save changes only for alerts alone', async () => {
  const environment = { kind: 'environment', environmentId: 'production' } as const;
  const { page, settled } = await mount({ initialInput: { v: 1, subject: environment } }, {}, async () => ({
    mode: 'preview', sourceConfig: { v: 1, subject: environment, alerts: { channels: [], phases: ['open'] } },
    destinationSelectionContext: { serverId: 'home', machineId: 'controller' },
  }));
  const names = async () => (await page.getAllByRole('button')).map(button => button.name);
  await expect(page.getByText('Off')).resolves.toBeDefined();
  expect(await names()).toEqual(expect.arrayContaining(['Cancel', 'Add check']));
  expect(await names()).not.toContain('Save changes');
  await type('Endpoint', 'https://shop.example.test/health');
  expect(await names()).not.toContain('Save changes');
  await act(async () => { await page.press(await addButton(page)); });
  expect(settled).toEqual([expect.objectContaining({ kind: 'completed', input: expect.objectContaining({
    checks: [expect.objectContaining({ config: expect.objectContaining({ endpoint: 'https://shop.example.test/health' }) })] }) })]);
});

// PAGE-ACCEPT-176 R11-D3: a saved check opened to edit is its own sheet: no other saved check to pick, its kind fixed,
// one Save beside Cancel; Cancel settles nothing written.
it('edits a saved check in its own sheet with one Save and a Cancel that writes nothing', async () => {
  const first = { checkId: 'first-http', kind: { pluginId: MACHINE_SERVICES_PLUGIN_ID, localId: 'http' },
    binding: { kind: 'healthCheck' }, config: { endpoint: 'https://other.example.test', expectStatus: 200 },
    periodMs: 60_000, consecutiveFailuresBeforeAlerting: 1 };
  const saved = { ...first, checkId: 'shop-check', config: { endpoint: 'https://shop.example.test', expectStatus: 200 } };
  const { page, settled } = await mount({ initialInput: { v: 1, subject, checks: [first, saved], selectedCheckId: saved.checkId } });
  const names = async () => (await page.getAllByRole('button')).map(button => button.name);
  await vi.waitFor(async () => expect(await names()).toContain('Save changes'));
  expect((await names()).some(name => name?.startsWith('Saved check'))).toBe(false);
  expect(await names()).not.toContain('Add check');
  expect(await names()).not.toContain('More checks');
  expect(await page.queryByRole('radio', { name: 'TCP' })).toBeUndefined();
  await act(async () => { await page.press(await page.getByRole('button', { name: 'Cancel' })); });
  expect(settled).toEqual([{ kind: 'cancelled' }]);
});

// PAGE-ACCEPT-176 R11-D2: Gatus's setup body waits behind "How to connect Gatus", as copyable code, not prose at rest.
it('keeps the Gatus connection body behind its disclosure', async () => {
  const { page } = await mount({ initialInput: { v: 1, subject } });
  await act(async () => {
    const tile = (await page.getAllByRole('radio')).find(target => target.name?.startsWith('Gatus'));
    await page.press(tile!);
  });
  expect(document.body.textContent).not.toContain('[ENDPOINT_GROUP]');
  expect(document.body.textContent).not.toContain('add a custom alert that sends POST');
  await act(async () => { await page.press(await page.getByRole('button', { name: 'How to connect Gatus' })); });
  expect(document.body.textContent).toContain('add a custom alert that sends POST');
});

// R17-D3: the host refuses a Save while the sheet keeps the draft; the form says the host's own reason and Save works again.
it('keeps the entries and shows the host refusal in its own words when a Save is refused', async () => {
  const attempts: unknown[] = [];
  let settleWrite: () => void = () => {};
  const write = new Promise<void>(resolve => { settleWrite = resolve; });
  await act(async () => {
    mounted = await createPluginUiTestkit({
      identity: { instanceId: 'health-setup', mountNonce: 'health-setup-refused' },
      authorPlugin: { id: MACHINE_SERVICES_PLUGIN_ID, version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
      launchInput: { initialInput: { v: 1, subject } },
      handlers: {
        executeAction: async request => {
          const { mode: _mode, ...sourceConfig } = request.input as Record<string, JsonValue>;
          return { mode: 'preview', destinationSelectionContext,
            sourceConfig: { ...sourceConfig, alerts: { channels: [], phases: ['open', 'recovered'] } } };
        },
        settleEphemeralInput: async ({ settlement }) => {
          attempts.push(settlement);
          await write;
          throw new PluginError({ code: 'invalid_input', retryable: false,
            message: 'This source already has a different configuration. Edit the saved source to make this change.' });
        },
      },
    });
  });
  const page = mounted!;
  await expect(page.getByText('Off')).resolves.toBeDefined();
  await type('Endpoint', 'https://app.example.test/ready');
  await act(async () => { await page.press(await addButton(page)); });
  expect(attempts).toHaveLength(1);
  // Save stays busy while the host's write runs.
  expect((await addButton(page)).state?.busy).toBe(true);
  await act(async () => { settleWrite(); });
  await expect(page.getByText('This source already has a different configuration. Edit the saved source to make this change.'))
    .resolves.toBeDefined();
  expect(document.querySelector<HTMLInputElement>('input[aria-label="Endpoint"]')?.value).toBe('https://app.example.test/ready');
  expect((await addButton(page)).state?.disabled).not.toBe(true);
});
