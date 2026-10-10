// @vitest-environment jsdom
import { act } from 'react';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import {
  TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1,
  TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1,
  TriageSourceAdministrationActionInputV1Schema,
  TriageSourceInstanceDraftV1Schema,
} from '@happier-dev/triage-protocol/v1';
import { afterEach, describe, expect, it } from 'vitest';

import { GITHUB_CONNECTED_ACCOUNT_PURPOSE, GITHUB_CONNECTED_ACCOUNT_SERVICE, GITHUB_PLUGIN_ID } from '../../observations/githubProviderContracts.js';
import { decodeGithubTriageConfiguration } from '../../triage/configuration.js';
import {
  GITHUB_TRIAGE_ACTION_IDS_V1,
  GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1,
} from '../../triage/contribution.js';

import { renderSurface } from './renderSettingsSurface.js';

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

async function mountSettings(handler = executeAction): Promise<PluginUiTestkit> {
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-204', mountNonce: 'fixture-mount-204' },
      authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createSurfaceContextFixture(),
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
  it('reconfigures the exact native instance to an explicitly chosen repository through the shared administration Action', async () => {
    const sourceInstanceId = '11111111-1111-4111-8111-111111111111';
    const draft = TriageSourceInstanceDraftV1Schema.parse({
      v: 1,
      binding: { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, source: 'native', service: GITHUB_CONNECTED_ACCOUNT_SERVICE },
      localInstanceKey: 'github.com', keyStability: 'stable',
      configuration: { v: 1, token: JSON.stringify({ v: 1, scope: { kind: 'account' } }) },
      locator: { v: 1, displayLabel: 'qa-user', displayPath: 'github.com' },
    });
    const secondInstanceId = '22222222-2222-4222-8222-222222222222';
    const secondDraft = TriageSourceInstanceDraftV1Schema.parse({
      ...draft,
      binding: { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, account: { service: GITHUB_CONNECTED_ACCOUNT_SERVICE, accountId: 'second-account' } },
      locator: { v: 1, displayLabel: 'Second account', displayPath: 'github.com' },
    });
    const administrations: unknown[] = [];
    let savedDraft = draft;
    const page = await mountSettings(async ({ action, input }): Promise<JsonValue> => {
      const ref = action as Readonly<{ localId?: string }>;
      if (ref.localId === GITHUB_TRIAGE_ACTION_IDS_V1.listInstances) {
        return { kind: 'complete', candidates: [draft, secondDraft], failures: [] };
      }
      if (ref.localId === TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1.localId) {
        return { kind: 'read', status: 'complete', instances: [
          { draft: savedDraft, sourceInstanceId }, { draft: secondDraft, sourceInstanceId: secondInstanceId },
        ].map(({ draft: entry, sourceInstanceId: id }) => ({
          v: 1, lifecycle: 'active', configured: {
            v: 1, binding: entry.binding, localInstanceKey: entry.localInstanceKey,
            configuration: entry.configuration, locator: entry.locator!,
            instance: { source: { pluginId: GITHUB_PLUGIN_ID, localId: 'github-forge' }, sourceInstanceId: id },
          },
        })) };
      }
      if (ref.localId === TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1.localId) {
        const administration = TriageSourceAdministrationActionInputV1Schema.parse(input);
        if (administration.kind !== 'reconfigure') throw new Error('Expected exact reconfiguration');
        administrations.push(administration);
        if (administration.sourceInstanceId === sourceInstanceId) savedDraft = administration.draft;
        return { kind: 'reconfigured', sourceInstanceId: administration.sourceInstanceId };
      }
      throw new Error('Unexpected Settings Action');
    });
    const press = async (name: string, role: 'button' | 'radio' = 'button') => {
      await act(async () => { await page.press(await page.getByRole(role, { name })); });
    };
    await press('Update Use this machine’s GitHub CLI login from the provider');
    // Update must open the source-owned editor, not immediately re-submit discovery's account-wide draft.
    expect(administrations).toEqual([]);
    await press('Repository', 'radio');
    await expect(page.getByRole('button', { name: 'Save scope', state: { disabled: true } })).resolves.toBeDefined();
    const repository = document.querySelector<HTMLInputElement>('input[aria-label="Repository"]');
    expect(repository).not.toBeNull();
    if (repository === null) throw new Error('Repository field is absent');
    // Drive the genuine platform text-input boundary; no component or policy internals are mocked.
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(repository, ' Happier-Dev/Happier ');
      repository.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(page.getByRole('textbox', { label: 'Repository', value: ' Happier-Dev/Happier ' })).resolves.toBeDefined();
    await press('Save scope');
    const expectedDraft = { ...draft, configuration: { v: 1, token: JSON.stringify({ v: 1, scope: { kind: 'repository', repositoryKey: 'happier-dev/happier' } }) } };
    expect(administrations).toEqual([{ v: 1, kind: 'reconfigure', sourceInstanceId, draft: expectedDraft }]);
    expect(decodeGithubTriageConfiguration(expectedDraft.configuration.token)).toEqual({
      ok: true, configuration: { v: 1, scope: { kind: 'repository', repositoryKey: 'happier-dev/happier' } },
    });
    await expect(page.queryByRole('button', { name: 'Save scope' })).resolves.toBeUndefined();
    await press('Update Use this machine’s GitHub CLI login from the provider');
    await press('Cancel');
    expect(administrations).toHaveLength(1);
    await press('Update Use this machine’s GitHub CLI login from the provider');
    await press('Save scope');
    expect(administrations[1]).toEqual({ v: 1, kind: 'reconfigure', sourceInstanceId, draft: expectedDraft });
    await press('Update Use this machine’s GitHub CLI login from the provider');
    await press('Repository', 'radio');
    const nextRepository = document.querySelector<HTMLInputElement>('input[aria-label="Repository"]');
    if (nextRepository === null) throw new Error('Repository field is absent');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(nextRepository, 'happier-dev/happier');
      nextRepository.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // Choosing a different configured row cannot silently carry the first row's unsaved scope into it.
    await press('Update Second account from the provider');
    await press('Save scope');
    expect(administrations[2]).toEqual({ v: 1, kind: 'reconfigure', sourceInstanceId: secondInstanceId, draft: secondDraft });
  });

  it('seeds Restore and remounted Update from persisted repository scope while keeping fresh discovery location', async () => {
    const sourceInstanceId = '11111111-1111-4111-8111-111111111111';
    const draft = TriageSourceInstanceDraftV1Schema.parse({
      v: 1,
      binding: { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, source: 'native', service: GITHUB_CONNECTED_ACCOUNT_SERVICE },
      localInstanceKey: 'github.com', keyStability: 'stable',
      configuration: { v: 1, token: JSON.stringify({ v: 1, scope: { kind: 'account' } }) },
      locator: { v: 1, displayLabel: 'Current login', displayPath: 'github.com' },
    });
    const configuration = { v: 1 as const, token: JSON.stringify({ v: 1, scope: { kind: 'repository', repositoryKey: 'happier-dev/happier' } }) };
    let lifecycle: 'active' | 'retired' = 'retired';
    const administrations: unknown[] = [];
    const handler = async ({ action, input }: Readonly<{ action: unknown; input: unknown }>): Promise<JsonValue> => {
      const ref = action as Readonly<{ localId?: string }>;
      if (ref.localId === GITHUB_TRIAGE_ACTION_IDS_V1.listInstances) return { kind: 'complete', candidates: [draft], failures: [] };
      if (ref.localId === TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1.localId) return {
        kind: 'read', status: 'complete', instances: [{ v: 1, lifecycle, configured: {
          v: 1, binding: draft.binding, localInstanceKey: draft.localInstanceKey,
          configuration, locator: { v: 1, displayLabel: 'Old login', displayPath: 'old/location' },
          instance: { source: { pluginId: GITHUB_PLUGIN_ID, localId: 'github-forge' }, sourceInstanceId },
        } }],
      };
      const administration = TriageSourceAdministrationActionInputV1Schema.parse(input);
      if (administration.kind !== 'reactivate' && administration.kind !== 'reconfigure') throw new Error('Expected Restore or Update');
      administrations.push(administration);
      lifecycle = 'active';
      return { kind: administration.kind === 'reactivate' ? 'reactivated' : 'reconfigured', sourceInstanceId };
    };
    let page = await mountSettings(handler);
    const press = async (name: string) => { await act(async () => { await page.press(await page.getByRole('button', { name })); }); };
    await press('Restore Use this machine’s GitHub CLI login to PRs & Issues');
    await expect(page.getByRole('textbox', { label: 'Repository', value: 'happier-dev/happier' })).resolves.toBeDefined();
    await press('Save scope');
    expect(administrations[0]).toEqual({ v: 1, kind: 'reactivate', sourceInstanceId, draft: { ...draft, configuration } });
    await page.dispose();
    mounted.splice(mounted.indexOf(page), 1);
    page = await mountSettings(handler);
    await press('Update Use this machine’s GitHub CLI login from the provider');
    await expect(page.getByRole('textbox', { label: 'Repository', value: 'happier-dev/happier' })).resolves.toBeDefined();
    await press('Save scope');
    expect(administrations[1]).toEqual({ v: 1, kind: 'reconfigure', sourceInstanceId, draft: { ...draft, configuration } });
  });

  it('asks its own plugin what it can reach, and the target for the rest', async () => {
    await mountSettings();

    expect(recorded.map((entry) => entry.action)).toEqual([
      { pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_TRIAGE_ACTION_IDS_V1.listInstances },
      { ...TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1 },
    ]);
    // Both mount reads are reads: opening a settings page must never configure
    // anything.
    expect(recorded.map((entry) => entry.input)).toEqual([{ v: 1 }, { v: 1 }]);
  });

  it('names this source the way its own descriptor spells it', async () => {
    const page = await mountSettings();

    const heading = `${GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1.displayName} in PRs & Issues`;
    await expect(page.getByText(heading)).resolves.toEqual({ content: heading });
  });
});
