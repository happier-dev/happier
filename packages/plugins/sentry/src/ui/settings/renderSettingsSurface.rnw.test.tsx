// @vitest-environment jsdom
import { act } from 'react';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1, TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1, TriageSourceAdministrationActionInputV1Schema } from '@happier-dev/triage-protocol/v1';
import { afterEach, describe, expect, it } from 'vitest';

import {
  SENTRY_ACTION_IDS,
  SENTRY_CONNECTED_ACCOUNT_PURPOSE,
  SENTRY_CONTRIBUTION_ID,
  SENTRY_PLUGIN_ID,
  SENTRY_SCOPE_SEPARATOR,
  SENTRY_SOURCE_DISPLAY_NAME,
} from '../../sentryContracts.js';

import { renderSurface } from './renderSettingsSurface.js';
import { decodeSentryInstanceConfiguration, encodeSentryInstanceConfiguration } from '../../instances/sentryInstanceConfiguration.js';

/**
 * What Sentry contributes to the shared PRs & Issues settings page.
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

async function executeAction(
  { action, input }: Readonly<{ action: unknown; input: unknown }>,
  discovery?: JsonValue,
): Promise<JsonValue> {
  recorded.push({ action, input });
  const ref = action as Readonly<{ pluginId?: string; localId?: string }>;
  if (ref.localId === SENTRY_ACTION_IDS.listInstances) {
    return discovery ?? { kind: 'complete', candidates: [], failures: [] };
  }
  if (ref.localId === SENTRY_ACTION_IDS.listScopeUnits) return {
    kind: 'page', status: 'complete', selection: { kind: 'all' },
    units: [{ id: '9001', label: 'Checkout' }],
  };
  if (ref.localId === TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1.localId) {
    TriageSourceAdministrationActionInputV1Schema.parse(input);
    return { kind: 'active', sourceInstanceId: '2f1c9c4e-8c1f-4a53-9c2a-4c9a7b1d3e05' };
  }
  return { kind: 'read', status: 'complete', instances: [] };
}

async function mountSettings(discovery?: JsonValue): Promise<PluginUiTestkit> {
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-172', mountNonce: 'fixture-mount-172' },
      authorPlugin: { id: SENTRY_PLUGIN_ID, version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        executeAction: async ({ action, input }) => await executeAction({ action, input }, discovery),
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

describe('the mounted Sentry PRs & Issues settings page', () => {
  it('saves the default All projects selection without changing the discovered organization', async () => {
    const draft = {
      v: 1, binding: { purpose: SENTRY_CONNECTED_ACCOUNT_PURPOSE, account: {
        service: { pluginId: SENTRY_PLUGIN_ID, localId: 'sentry-account' }, accountId: 'account-1',
      } },
      localInstanceKey: `https://us.sentry.io${SENTRY_SCOPE_SEPARATOR}4501`,
      keyStability: 'locatorDerived', locator: { v: 1, displayLabel: 'Example Org' },
      configuration: { v: 1, token: encodeSentryInstanceConfiguration({
        v: 1, organizationId: '4501', projectScope: { kind: 'all' }, environmentScope: { kind: 'all' },
      }) },
    };
    const page = await mountSettings({ kind: 'complete', candidates: [draft], failures: [] });
    await act(async () => { await page.press(await page.getByRole('button', { name: 'Add Example Org to PRs & Issues' })); });
    await act(async () => { await page.press(await page.getByRole('button', { name: 'Save selection' })); });
    const request = TriageSourceAdministrationActionInputV1Schema.parse(recorded.find(({ action }) => (
      (action as { localId: string }).localId === TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1.localId
    ))?.input);
    expect(request).toMatchObject({ kind: 'create', draft: {
      binding: draft.binding, localInstanceKey: draft.localInstanceKey, locator: draft.locator,
    } });
    if (request.kind !== 'create') throw new Error('expected configuration creation');
    expect(decodeSentryInstanceConfiguration(request.draft.configuration.token)).toEqual({
      ok: true, configuration: {
        v: 1, organizationId: '4501', projectScope: { kind: 'all' }, environmentScope: { kind: 'all' },
      },
    });
  });

  it('configures project selection through the shared control while retaining the organization binding', async () => {
    const draft = {
      v: 1, binding: { purpose: SENTRY_CONNECTED_ACCOUNT_PURPOSE, account: {
        service: { pluginId: SENTRY_PLUGIN_ID, localId: 'sentry-account' }, accountId: 'account-1',
      } },
      localInstanceKey: `https://us.sentry.io${SENTRY_SCOPE_SEPARATOR}7701`,
      keyStability: 'locatorDerived', locator: { v: 1, displayLabel: 'Organization' },
      configuration: { v: 1, token: JSON.stringify({
        v: 1, organizationId: '7701', projectScope: { kind: 'allAccessible' }, environmentScope: { kind: 'all' },
      }) },
    };
    const page = await mountSettings({ kind: 'complete', candidates: [draft], failures: [] });
    await act(async () => { await page.press(await page.getByRole('button', { name: 'Add Organization to PRs & Issues' })); });
    expect(recorded.some(({ action }) => (action as { localId: string }).localId === TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1.localId)).toBe(false);
    await act(async () => { await page.press(await page.getByRole('radio', { name: 'Selected…' })); });
    await act(async () => { await page.press(await page.getByRole('checkbox', { name: 'Checkout' })); });
    await act(async () => { await page.press(await page.getByRole('button', { name: 'Save selection' })); });
    const request = TriageSourceAdministrationActionInputV1Schema.parse(recorded.find(({ action }) => (
      (action as { localId: string }).localId === TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1.localId
    ))?.input);
    expect(request).toMatchObject({ kind: 'create', draft: { binding: draft.binding, localInstanceKey: draft.localInstanceKey, locator: draft.locator } });
    if (request.kind !== 'create') throw new Error('expected configuration creation');
    expect(decodeSentryInstanceConfiguration(request.draft.configuration.token)).toMatchObject({
      ok: true, configuration: { organizationId: '7701', projectScope: { kind: 'selected', unitIds: ['9001'] }, projectUnits: [{ id: '9001', label: 'Checkout' }] },
    });
  });

  it('asks its own plugin what it can reach, and the target for the rest', async () => {
    await mountSettings();

    expect(recorded.map((entry) => entry.action)).toEqual([
      { pluginId: SENTRY_PLUGIN_ID, localId: SENTRY_ACTION_IDS.listInstances },
      { ...TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1 },
    ]);
    expect(recorded.map((entry) => entry.input)).toEqual([
      { v: 1 },
      { v: 1, source: { pluginId: SENTRY_PLUGIN_ID, localId: SENTRY_CONTRIBUTION_ID } },
    ]);
  });

  it('names this source the way its own descriptor spells it', async () => {
    const page = await mountSettings();

    const heading = `${SENTRY_SOURCE_DISPLAY_NAME} in PRs & Issues`;
    await expect(page.getByText(heading)).resolves.toEqual({ content: heading });
  });
});
