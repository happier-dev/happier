// @vitest-environment jsdom
import { act } from 'react';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { createPluginTestkit, createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit, PluginTestkit, PluginUiTestkitHostHandlers } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1, type TriageSourceAccountBindingV1 } from '@happier-dev/triage-protocol/v1';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activate } from '../../activate.js';
import { activate as activateAccount } from '../../accountRuntime.js';
import { PLUGIN_MANIFEST } from '../../manifest.js';
import { PosthogConfigurationDirectoryResultV1Schema } from '../../connect/configurationContract.js';
import organizationsPage from '../../api/__fixtures__/organizationsPage.json' with { type: 'json' };
import projectsPage from '../../api/__fixtures__/organizationProjectsPage.json' with { type: 'json' };

import {
  POSTHOG_ACTION_IDS,
  POSTHOG_PLUGIN_ID,
  POSTHOG_SOURCE_CONTRIBUTION_ID,
  POSTHOG_SOURCE_DISPLAY_NAME,
} from '../../posthogContracts.js';

import { renderSurface } from './renderSettingsSurface.js';

/**
 * What PostHog contributes to the shared PRs & Issues settings page.
 *
 * The page's behaviour — every lifecycle arm, every failure sentence, and the
 * fact that a configuration survives a remount — is owned and proved once in
 * `@happier-dev/triage-sources`. Repeating those cases here would be six
 * copies of one contract again. What is genuinely per-source is the identity this
 * artifact hands the factory, and that is what these cases mount and read: a page
 * wired to another plugin's Action would list scopes the user cannot configure
 * here, and one wired to a sibling Action would enumerate the wrong thing.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const recorded: { action: unknown; input: unknown }[] = [];
const mounted: PluginUiTestkit[] = [];
const plugins: PluginTestkit[] = [];
const accountBinding = {
  purpose: 'posthog-api',
  account: {
    service: { pluginId: POSTHOG_PLUGIN_ID, localId: 'posthog-api' },
    accountId: 'account-1',
  },
} satisfies TriageSourceAccountBindingV1;
let discoveredBinding: TriageSourceAccountBindingV1 = accountBinding;
let configuredScanWindow: unknown = { kind: 'relative', durationMs: 2_592_000_000 };
let configuredDetailWindow: unknown = { kind: 'relative', durationMs: 2_592_000_000 };
type ConfigurationRequest = Readonly<{
  kind?: string;
  organizationUuid?: string;
  page?: Readonly<{ kind?: string; next?: string }>;
}>;
let configurationResult: ((input: Readonly<{
  request: ConfigurationRequest;
  signal: AbortSignal;
}>) => Promise<JsonValue>) | null = null;
const ORGANIZATIONS_NEXT = 'https://eu.posthog.com/api/organizations/?limit=100&offset=100';
const ENVIRONMENTS_NEXT = 'https://eu.posthog.com/api/organizations/00000000-0000-4000-8000-0000000000a1/projects/?limit=100&offset=100';

async function executeAction(
  { action, input, signal }: Readonly<{ action: unknown; input: unknown; signal: AbortSignal }>,
): Promise<JsonValue> {
  recorded.push({ action, input });
  const ref = action as Readonly<{ pluginId?: string; localId?: string }>;
  if (ref.localId === POSTHOG_ACTION_IDS.listInstances) {
    return {
      kind: 'complete',
      candidates: [{
        v: 1,
        binding: discoveredBinding,
        localInstanceKey: 'posthog-org:https://eu.posthog.com:00000000-0000-4000-8000-0000000000a1',
        keyStability: 'locatorDerived',
        configuration: {
          v: 1,
          token: JSON.stringify({
            v: 1,
            organizationUuid: '00000000-0000-4000-8000-0000000000a1',
            environments: [{
              teamPathId: 4821,
              teamUuid: '00000000-0000-4000-8000-0000000000d1',
              parentProjectId: 4820,
              displayName: 'Storefront production',
            }],
            scanWindowPolicy: configuredScanWindow,
            detailWindowPolicy: configuredDetailWindow,
          }),
        },
        locator: { v: 1, displayLabel: 'Example organization' },
      }],
      failures: [],
    };
  }
  if (ref.localId === POSTHOG_ACTION_IDS.configuration) {
    const request = input as ConfigurationRequest;
    if (configurationResult !== null) return await configurationResult({ request, signal });
    if (request.kind === 'environments') {
      return {
        kind: 'environments',
        organizationUuid: request.organizationUuid,
        rows: request.page?.kind === 'continuation'
          ? [{
            teamPathId: 4822,
            teamUuid: '00000000-0000-4000-8000-0000000000d2',
            parentProjectId: 4820,
            displayName: 'Storefront staging',
          }]
          : [{
            teamPathId: 4821,
            teamUuid: '00000000-0000-4000-8000-0000000000d1',
            parentProjectId: 4820,
            displayName: 'Storefront production',
          }],
        ...(request.page?.kind === 'continuation' ? {} : { next: ENVIRONMENTS_NEXT }),
      };
    }
    return {
      kind: 'organizations',
      rows: request.page?.kind === 'continuation'
        ? [{
          organizationUuid: '00000000-0000-4000-8000-0000000000a2',
          displayName: 'Second organization',
          localInstanceKey: 'posthog-org:https://eu.posthog.com:00000000-0000-4000-8000-0000000000a2',
        }]
        : [{
          organizationUuid: '00000000-0000-4000-8000-0000000000a1',
          displayName: 'Example organization',
          localInstanceKey: 'posthog-org:https://eu.posthog.com:00000000-0000-4000-8000-0000000000a1',
        }],
      ...(request.page?.kind === 'continuation' ? {} : { next: ORGANIZATIONS_NEXT }),
    };
  }
  if (ref.localId === 'posthog/list-scope-units') {
    const request = input as Readonly<{ mode?: string; draft: Readonly<{ configuration: Readonly<{ token: string }> }> }>;
    const configuration = JSON.parse(request.draft.configuration.token) as Readonly<{
      include?: JsonValue;
      environments: readonly Readonly<{ teamUuid: string; displayName: string }>[];
    }>;
    return {
      kind: 'page', status: 'complete',
      selection: configuration.include ?? { kind: 'selected', unitIds: configuration.environments.map((entry) => entry.teamUuid) },
      units: configuration.environments.map((entry) => ({ id: entry.teamUuid, label: entry.displayName })),
    };
  }
  if (ref.localId === 'sources/administer-v1') {
    return { kind: 'active', sourceInstanceId: '11111111-1111-4111-8111-111111111111' };
  }
  return { kind: 'read', status: 'complete', instances: [] };
}

async function mountSettings(handler?: PluginUiTestkitHostHandlers['executeAction']): Promise<PluginUiTestkit> {
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: { instanceId: 'triage-sources', mountNonce: 'triage-sources-mount' },
      authorPlugin: { id: POSTHOG_PLUGIN_ID, version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        executeAction: handler ?? (async ({ action, input, signal }) => await executeAction({ action, input, signal })),
      },
    });
  });
  mounted.push(fixture);
  return fixture;
}

afterEach(async () => {
  recorded.splice(0);
  configuredScanWindow = { kind: 'relative', durationMs: 2_592_000_000 };
  configuredDetailWindow = { kind: 'relative', durationMs: 2_592_000_000 };
  configurationResult = null;
  discoveredBinding = accountBinding;
  for (const fixture of mounted.splice(0)) await fixture.dispose();
  for (const plugin of plugins.splice(0)) await plugin.dispose();
});

describe('the mounted PostHog PRs & Issues settings page', () => {
  it('keeps configuration usable and shows the registered directory HTTP failure and issued request ID', async () => {
    let failDirectory = false;
    const results: Array<{ requestId: string; result: JsonValue | void }> = [];
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: {
      connectedAccounts: {
        async listAccounts() { return { status: 'complete', accounts: [{ account: accountBinding.account, displayName: 'PostHog', state: 'connected', connectedAccountOrigins: ['https://eu.posthog.com'], connectedAccountBases: ['https://eu.posthog.com'] }] }; },
        async materializeListedAccount() { return { kind: 'httpHeaders', headers: { authorization: 'Bearer test-only-placeholder' } }; },
      },
      http: { async request(request) {
        const organizations = new URL(request.url).pathname === '/api/organizations/';
        const status = organizations && failDirectory ? 429 : 200;
        const body = status === 429 ? {} : organizations ? { ...organizationsPage, next: null } : { ...projectsPage, next: null };
        return { status, finalUrl: request.url, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(body)) };
      } },
    } });
    plugins.push(plugin);
    const page = await mountSettings(async ({ action, input, requestId, signal }) => {
      if (typeof action === 'string' || input === undefined) throw new Error('Expected a registered source Action');
      // The configured-instance store belongs to the host; source Actions run their real handlers.
      if (action.pluginId !== POSTHOG_PLUGIN_ID) return { kind: 'read', status: 'complete', instances: [] };
      const result = await plugin.invokeAction(action.localId, input, { surface: 'ui', signal, requestId });
      if (action.localId === POSTHOG_ACTION_IDS.configuration) results.push({ requestId, result });
      return result;
    });
    const add = await page.findByRole('button', { name: 'Add Example Storefront to PRs & Issues' });
    failDirectory = true;
    await act(async () => { await page.press(add); });
    await vi.waitFor(() => expect(results[0]).toBeDefined());
    const read = results[0]!;
    expect(PosthogConfigurationDirectoryResultV1Schema.parse(read.result)).toMatchObject({ kind: 'unavailable', failure: { code: 'posthog/rate-limited', requestId: read.requestId } });
    await expect(page.getByRole('radio', { name: 'All' })).resolves.toBeDefined();
    await act(async () => { await page.press(await page.getByRole('button', { name: 'Details' })); });
    await expect(page.getByText('posthog/rate-limited')).resolves.toBeDefined();
    await expect(page.getByText(read.requestId)).resolves.toBeDefined();
  });

  it('uses the shared All choice while preserving source-owned window policies', async () => {
    const page = await mountSettings();
    await act(async () => { await page.press(await page.getByRole('button', { name: 'Add Example organization to PRs & Issues' })); });
    await act(async () => { await page.press(await page.getByRole('radio', { name: 'All' })); });
    await act(async () => { await page.press(await page.getByRole('button', { name: 'Save selection' })); });
    const write = recorded.find((entry) => (entry.action as Readonly<{ localId?: string }>).localId === 'sources/administer-v1');
    const result = write?.input as Readonly<{ draft: Readonly<{ configuration: Readonly<{ token: string }> }> }>;
    expect(JSON.parse(result.draft.configuration.token)).toMatchObject({
      include: { kind: 'all' }, scanWindowPolicy: configuredScanWindow, detailWindowPolicy: configuredDetailWindow,
    });
  });
  it('refuses a native draft before reading or administering configuration and allows cancellation', async () => {
    discoveredBinding = {
      purpose: accountBinding.purpose,
      source: 'native',
      service: accountBinding.account.service,
    };
    const page = await mountSettings();
    await act(async () => {
      await page.press(await page.getByRole('button', { name: 'Add Example organization to PRs & Issues' }));
    });

    const actionIds = recorded.map((entry) => (entry.action as Readonly<{ localId?: string }>).localId);
    expect(actionIds).not.toContain(POSTHOG_ACTION_IDS.configuration);
    expect(actionIds).not.toContain('sources/administer-v1');
    await act(async () => { await page.press(await page.getByRole('button', { name: 'Cancel' })); });
    await expect(page.getByRole('button', { name: 'Add Example organization to PRs & Issues' })).resolves.toBeDefined();
  });

  it('asks its own plugin what it can reach, and the target for the rest', async () => {
    await mountSettings();

    expect(recorded.map((entry) => entry.action)).toEqual([
      { pluginId: POSTHOG_PLUGIN_ID, localId: POSTHOG_ACTION_IDS.listInstances },
      { ...TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1 },
    ]);
    // Both mount reads are reads: opening a settings page must never configure
    // anything.
    expect(recorded.map((entry) => entry.input)).toEqual([
      { v: 1 },
      { v: 1, source: { pluginId: POSTHOG_PLUGIN_ID, localId: POSTHOG_SOURCE_CONTRIBUTION_ID } },
    ]);
  });

  it('names this source the way its own descriptor spells it', async () => {
    const page = await mountSettings();

    const heading = `${POSTHOG_SOURCE_DISPLAY_NAME} in PRs & Issues`;
    await expect(page.getByText(heading)).resolves.toEqual({ content: heading });
  });

  it('opens an interactive configuration editor before creating the discovered draft', async () => {
    const page = await mountSettings();

    await act(async () => {
      await page.press(await page.getByRole('button', {
        name: 'Add Example organization to PRs & Issues',
      }));
    });

    await expect(page.getByRole('radio', { name: 'All' })).resolves.toBeDefined();
    expect(recorded.some((entry) => (
      (entry.action as Readonly<{ localId?: string }>).localId === 'sources/administer-v1'
    ))).toBe(false);
  });

  it('administers the draft without a provider read and leaves materialization to refresh', async () => {
    const page = await mountSettings();
    await act(async () => {
      await page.press(await page.getByRole('button', {
        name: 'Add Example organization to PRs & Issues',
      }));
    });
    const save = await page.findByRole('button', { name: 'Save selection' });
    await act(async () => { await page.press(save); });

    const actionIds = recorded.map((entry) => (
      entry.action as Readonly<{ localId?: string }>
    ).localId);
    expect(actionIds).not.toContain('posthog/capability');
    expect(actionIds).toContain('sources/administer-v1');
  });

  it('preserves exact scan and detail windows when an exact configuration is edited', async () => {
    configuredScanWindow = {
      kind: 'exact',
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-15T00:00:00.000Z',
    };
    configuredDetailWindow = {
      kind: 'exact',
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-06-30T23:59:59.000Z',
    };
    const page = await mountSettings();
    await act(async () => {
      await page.press(await page.getByRole('button', {
        name: 'Add Example organization to PRs & Issues',
      }));
    });

    await expect(page.getByRole('radio', {
      name: 'Exact scan window',
      state: { checked: true },
    })).resolves.toBeDefined();
    await expect(page.getByRole('radio', {
      name: 'Exact detail window',
      state: { checked: true },
    })).resolves.toBeDefined();

    await act(async () => {
      await page.press(await page.findByRole('button', { name: 'Save selection' }));
    });
    const administration = recorded.find((entry) => (
      (entry.action as Readonly<{ localId?: string }>).localId === 'sources/administer-v1'
    ));
    const token = (
      administration?.input as Readonly<{
        draft?: Readonly<{ configuration?: Readonly<{ token?: string }> }>;
      }>
    )?.draft?.configuration?.token;
    expect(typeof token).toBe('string');
    expect(JSON.parse(token ?? '')).toEqual(expect.objectContaining({
      scanWindowPolicy: configuredScanWindow,
      detailWindowPolicy: configuredDetailWindow,
    }));
  });

  it('loads a later organization page only when the user asks', async () => {
    const page = await mountSettings();
    await act(async () => {
      await page.press(await page.getByRole('button', {
        name: 'Add Example organization to PRs & Issues',
      }));
    });

    await act(async () => {
      await page.press(await page.findByRole('button', { name: 'Load more organizations' }));
    });
    const configurationInputs = recorded.flatMap((entry) => (
      (entry.action as Readonly<{ localId?: string }>).localId === POSTHOG_ACTION_IDS.configuration
        ? [entry.input]
        : []
    ));
    expect(configurationInputs).toContainEqual(expect.objectContaining({
      kind: 'organizations',
      page: { kind: 'continuation', next: ORGANIZATIONS_NEXT },
    }));
  });

  it('changes the organization boundary without retaining selected environments from its predecessor', async () => {
    const organizationA = '00000000-0000-4000-8000-0000000000a1';
    const organizationB = '00000000-0000-4000-8000-0000000000a2';
    configurationResult = async ({ request }) => {
      if (request.kind === 'organizations') {
        return {
          kind: 'organizations',
          rows: [
            {
              organizationUuid: organizationA,
              displayName: 'Organization A',
              localInstanceKey: `posthog-org:https://eu.posthog.com:${organizationA}`,
            },
            {
              organizationUuid: organizationB,
              displayName: 'Organization B',
              localInstanceKey: `posthog-org:https://eu.posthog.com:${organizationB}`,
            },
          ],
        };
      }
      return {
        kind: 'environments',
        organizationUuid: organizationA,
        rows: [{
          teamPathId: 4821,
          teamUuid: '00000000-0000-4000-8000-0000000000d1',
          parentProjectId: 4820,
          displayName: 'Environment A',
        }],
      };
    };

    const page = await mountSettings();
    await act(async () => {
      await page.press(await page.getByRole('button', {
        name: 'Add Example organization to PRs & Issues',
      }));
    });
    const organizationBControl = await page.findByRole('radio', { name: 'Organization B' });
    expect(organizationBControl.state?.disabled).not.toBe(true);
    await act(async () => { await page.press(organizationBControl); });
    await act(async () => { await page.press(await page.getByRole('button', { name: 'Save selection' })); });
    const write = recorded.find((entry) => (entry.action as Readonly<{ localId?: string }>).localId === 'sources/administer-v1');
    const draft = (write?.input as Readonly<{ draft: Readonly<{ localInstanceKey: string; configuration: Readonly<{ token: string }> }> }>).draft;
    expect(draft.localInstanceKey).toContain(organizationB);
    expect(JSON.parse(draft.configuration.token)).toMatchObject({ organizationUuid: organizationB, include: { kind: 'all' }, environments: [] });
  });

  it('cancels an in-flight organization page when the editor unmounts', async () => {
    let organizationSignal!: AbortSignal;
    let observeOrganization!: () => void;
    const organizationStarted = new Promise<void>((resolve) => { observeOrganization = resolve; });
    configurationResult = async ({ request, signal }) => {
      if (request.kind !== 'organizations') {
        return { kind: 'unavailable', failure: { class: 'unknown', code: 'unexpected-read' } };
      }
      organizationSignal = signal;
      observeOrganization();
      return await new Promise<JsonValue>(() => {
        // The provider boundary deliberately ignores abort. The editor still owns the
        // mounted request lifetime and must withdraw it when Cancel unmounts the page.
      });
    };

    const page = await mountSettings();
    await act(async () => {
      await page.press(await page.getByRole('button', {
        name: 'Add Example organization to PRs & Issues',
      }));
    });
    await organizationStarted;

    await act(async () => {
      await page.press(await page.getByRole('button', { name: 'Cancel' }));
    });
    expect(organizationSignal.aborted).toBe(true);
  });

  it('refuses shared Save while a source-owned window is invalid and permits repair', async () => {
    const page = await mountSettings();
    await act(async () => {
      await page.press(await page.getByRole('button', {
        name: 'Add Example organization to PRs & Issues',
      }));
    });
    const field = document.querySelector('input[aria-label="Scan window (days)"]');
    if (!(field instanceof HTMLInputElement)) throw new Error('Scan window input was not mounted');
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setValue) throw new Error('Browser input value setter missing');
    await act(async () => { setValue.call(field, '0'); field.dispatchEvent(new Event('input', { bubbles: true })); });
    expect((await page.getByRole('button', { name: 'Save selection' })).state?.disabled).toBe(true);
    expect(recorded.some((entry) => (entry.action as Readonly<{ localId?: string }>).localId === 'sources/administer-v1')).toBe(false);
    await act(async () => { setValue.call(field, '14'); field.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { await page.press(await page.getByRole('button', { name: 'Save selection' })); });
    const write = recorded.find((entry) => (entry.action as Readonly<{ localId?: string }>).localId === 'sources/administer-v1');
    const result = write?.input as Readonly<{ draft: Readonly<{ configuration: Readonly<{ token: string }> }> }>;
    expect(JSON.parse(result.draft.configuration.token)).toMatchObject({ scanWindowPolicy: { kind: 'relative', durationMs: 14 * 86_400_000 } });
  });

  it('does not let a successful environment read erase an organization failure', async () => {
    configurationResult = async ({ request }) => request.kind === 'organizations'
      ? { kind: 'unavailable', failure: { class: 'transient', code: 'posthog/transport-failed' } }
      : {
        kind: 'environments',
        organizationUuid: request.organizationUuid ?? '00000000-0000-4000-8000-0000000000a1',
        rows: [],
      };

    const page = await mountSettings();
    await act(async () => {
      await page.press(await page.getByRole('button', {
        name: 'Add Example organization to PRs & Issues',
      }));
    });

    await expect(page.getByText('PostHog could not read this configuration page.'))
      .resolves.toBeDefined();
  });
});
