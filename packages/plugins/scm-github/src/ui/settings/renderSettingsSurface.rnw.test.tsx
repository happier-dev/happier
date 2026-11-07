// @vitest-environment jsdom
import { act } from 'react';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { createPluginTestkit, createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import {
  TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1,
  TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1,
  TriageSourceAdministrationActionInputV1Schema,
  TriageSourceInstanceDraftV1Schema,
  TriageListScopeUnitsInputV1Schema,
} from '@happier-dev/triage-protocol/v1';
import { afterEach, describe, expect, it } from 'vitest';

import { GITHUB_CONNECTED_ACCOUNT_PURPOSE, GITHUB_CONNECTED_ACCOUNT_SERVICE, GITHUB_PLUGIN_ID } from '../../observations/githubProviderContracts.js';
import { decodeGithubTriageConfiguration } from '../../triage/configuration.js';
import {
  GITHUB_TRIAGE_ACTION_IDS_V1,
  GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1,
} from '../../triage/contribution.js';

import { renderSurface } from './renderSettingsSurface.js';
import { GITHUB_PLUGIN } from '../../manifest.js';
import { createStubGithubTransport, GITHUB_TEST_ACCOUNT } from '../../triage/testkit/githubTriage.test-support.js';

/**
 * What GitHub contributes to the shared PRs & Issues settings page.
 *
 * The page's behaviour — every lifecycle arm, every failure sentence, and the
 * fact that a configuration survives a remount — is owned and proved once in
 * `@happier-dev/triage-sources`. Repeating those cases here would be six
 * copies of one contract again. What is genuinely per-source is the identity and
 * scope editor this artifact hands the factory, and that is what these cases mount and read: a page
 * wired to another plugin's Action would list scopes the user cannot configure
 * here, and one wired to a sibling Action would enumerate the wrong thing.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const recorded: { action: unknown; input: unknown }[] = [];
const mounted: PluginUiTestkit[] = [];

async function executeAction(
  { action, input }: Readonly<{ action: unknown; input: unknown }>,
): Promise<JsonValue> {
  recorded.push({ action, input });
  const ref = action as Readonly<{ pluginId?: string; localId?: string }>;
  if (ref.localId === GITHUB_TRIAGE_ACTION_IDS_V1.listInstances) {
    return { kind: 'complete', candidates: [], failures: [] };
  }
  return { kind: 'read', status: 'complete', instances: [] };
}

async function mountSettings(handler = executeAction, surfaceContext = createSurfaceContextFixture()): Promise<PluginUiTestkit> {
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-204', mountNonce: 'fixture-mount-204' },
      authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
      surface: renderSurface,
      surfaceContext,
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        executeAction: async ({ action, input }) => await handler({ action, input }),
      },
    });
  });
  mounted.push(fixture);
  return fixture;
}

afterEach(async () => {
  recorded.splice(0);
  for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('the mounted GitHub PRs & Issues settings page', () => {
  it.each(['plain', 'e2ee'] as const)('enumerates and refreshes Account sources through the placement owner with zero Machines (%s)', async accountEncryptionMode => {
    const transport = createStubGithubTransport({
      respond: request => new URL(request.url).pathname === '/user'
        ? { status: 200, body: { login: 'source-owner' } } : undefined,
      listing: { status: 'complete', accounts: [{ account: GITHUB_TEST_ACCOUNT, displayName: 'Source owner',
        connectedAccountOrigins: ['https://api.github.com'], connectedAccountBases: [] }] },
      nativeMaterialization() { throw new Error('Account discovery must not acquire native credentials'); },
    });
    const github = await createPluginTestkit({ manifest: GITHUB_PLUGIN.manifest, module: GITHUB_PLUGIN,
      resolveCurrentPluginMaterializationRef: () => null, services: {
        http: transport.context.services.http, connectedAccounts: transport.context.services.connectedAccounts,
      } });
    try {
      const page = await mountSettings(async ({ action, input }) => {
        const ref = action as Readonly<{ pluginId: string; localId: string }>;
        if (ref.pluginId === GITHUB_PLUGIN_ID) return await github.invokeAction(ref.localId, input as JsonValue);
        return { kind: 'read', status: 'complete', instances: [] };
      }, createSurfaceContextFixture({ accountEncryptionMode, machineExecutionReady: false, machineConnectionPending: false }));
      await expect(page.getByRole('button', { name: 'Add source-owner to PRs & Issues' })).resolves.toBeDefined();
      expect(transport.materializeCount()).toBe(1);
      await act(async () => { await page.press(await page.getByRole('button', { name: 'Refresh' })); });
      await expect(page.getByRole('button', { name: 'Add source-owner to PRs & Issues' })).resolves.toBeDefined();
      expect(transport.materializeCount()).toBe(2);
      expect(transport.materializations.every(request => request.account.accountId === GITHUB_TEST_ACCOUNT.accountId)).toBe(true);
    } finally { await github.dispose(); }
  });

  it('uses the shared multi-repository control and preserves the exact native binding across a remount', async () => {
    const sourceInstanceId = '11111111-1111-4111-8111-111111111111';
    const draft = TriageSourceInstanceDraftV1Schema.parse({
      v: 1, binding: { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, source: 'native', service: GITHUB_CONNECTED_ACCOUNT_SERVICE },
      localInstanceKey: 'github.com', keyStability: 'locatorDerived',
      configuration: { v: 1, token: JSON.stringify({ v: 1, scope: { kind: 'account' } }) },
      locator: { v: 1, displayLabel: 'Current login', displayPath: 'github.com' },
    });
    const units = [{ id: 'org/app', label: 'org/app', collisionScope: 'github:11' }, { id: 'org/api', label: 'org/api', collisionScope: 'github:22' }];
    let saved = draft;
    let directoryAvailable = true;
    const administrations: unknown[] = [];
    const handler = async ({ action, input }: Readonly<{ action: unknown; input: unknown }>): Promise<JsonValue> => {
      const ref = action as Readonly<{ localId?: string }>;
      if (ref.localId === GITHUB_TRIAGE_ACTION_IDS_V1.listInstances) return { kind: 'complete', candidates: [draft], failures: [] };
      if (ref.localId === GITHUB_TRIAGE_ACTION_IDS_V1.listScopeUnits && TriageListScopeUnitsInputV1Schema.parse(input).mode === 'configured') {
        const decoded = decodeGithubTriageConfiguration(saved.configuration.token);
        if (!decoded.ok) throw new Error('Expected readable retained selection');
        return { kind: 'page', status: 'complete', selection: decoded.configuration.selection, units: decoded.configuration.units ?? [] };
      }
      if (ref.localId === GITHUB_TRIAGE_ACTION_IDS_V1.listScopeUnits && !directoryAvailable) return {
        kind: 'failed', failure: { class: 'authentication', code: 'login-unavailable' },
      };
      if (ref.localId === GITHUB_TRIAGE_ACTION_IDS_V1.listScopeUnits) return {
        kind: 'page', status: 'complete', selection: { kind: 'all' }, units,
      };
      if (ref.localId === TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1.localId) return {
        kind: 'read', status: 'complete', instances: [{ v: 1, lifecycle: 'active', configured: {
          v: 1, binding: saved.binding, localInstanceKey: saved.localInstanceKey,
          configuration: saved.configuration, locator: saved.locator!,
          instance: { source: { pluginId: GITHUB_PLUGIN_ID, localId: 'github-forge' }, sourceInstanceId },
        } }],
      };
      const administration = TriageSourceAdministrationActionInputV1Schema.parse(input);
      if (administration.kind !== 'reconfigure') throw new Error('Expected exact reconfiguration');
      administrations.push(administration); saved = administration.draft;
      return { kind: 'reconfigured', sourceInstanceId };
    };
    let page = await mountSettings(handler);
    const press = async (name: string, role: 'button' | 'radio' | 'checkbox' = 'button') => {
      await act(async () => { await page.press(await page.getByRole(role, { name })); });
    };
    await press('Update Use this machine’s GitHub CLI login from the provider');
    expect(administrations).toEqual([]);
    await press('Selected…', 'radio');
    await expect(page.getByRole('button', { name: 'Save selection', state: { disabled: true } })).resolves.toBeDefined();
    await press('org/app', 'checkbox'); await press('org/api', 'checkbox');
    await press('Save selection');
    expect(saved.binding).toEqual(draft.binding);
    expect(decodeGithubTriageConfiguration(saved.configuration.token)).toEqual({
      ok: true, configuration: { v: 1, selection: { kind: 'selected', unitIds: ['org/app', 'org/api'] }, units },
    });
    await page.dispose(); mounted.splice(mounted.indexOf(page), 1);
    directoryAvailable = false;
    page = await mountSettings(handler);
    await press('Update Use this machine’s GitHub CLI login from the provider');
    await press('Save selection');
    expect(administrations).toHaveLength(2);
    expect(saved.binding).toEqual(draft.binding);
    expect(decodeGithubTriageConfiguration(saved.configuration.token)).toEqual({
      ok: true, configuration: { v: 1, selection: { kind: 'selected', unitIds: ['org/app', 'org/api'] }, units },
    });
  });

  it('asks its own plugin what it can reach, and the target for configured state', async () => {
    await mountSettings();
    expect(recorded.map((entry) => entry.action)).toEqual([
      { pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_TRIAGE_ACTION_IDS_V1.listInstances },
      { ...TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1 },
    ]);
    expect(recorded.map((entry) => entry.input)).toEqual([{ v: 1 }, { v: 1 }]);
  });

  it('names this source as its descriptor declares', async () => {
    const page = await mountSettings();
    const heading = `${GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1.displayName} in PRs & Issues`;
    await expect(page.getByText(heading)).resolves.toEqual({ content: heading });
  });
});
