// @vitest-environment jsdom
import { act } from 'react';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import {
  createPluginUiTestkit,
  createSurfaceContextFixture,
  type PluginUiTestkit,
} from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { afterEach, expect, it } from 'vitest';
import { MACHINE_SERVICES_PLUGIN_ID } from '../healthSetup.js';
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
async function mount(launchInput: JsonValue) {
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
        checks: [
          {
            checkId: 'tcp',
            kind: { pluginId: MACHINE_SERVICES_PLUGIN_ID, localId: 'tcp' },
            binding: { kind: 'healthCheck' },
            config: { host: 'db.internal', port: 5432 },
            periodMs: 60_000,
            consecutiveFailuresBeforeAlerting: 2,
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
