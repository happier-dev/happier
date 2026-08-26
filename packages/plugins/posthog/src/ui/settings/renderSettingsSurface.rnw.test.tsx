// @vitest-environment jsdom
import { act } from 'react';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1 } from '@happier-dev/triage-protocol/v1';
import { afterEach, describe, expect, it } from 'vitest';

import {
  POSTHOG_ACTION_IDS,
  POSTHOG_PLUGIN_ID,
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
let configuredScanWindow: unknown = { kind: 'relative', durationMs: 2_592_000_000 };
let configuredDetailWindow: unknown = { kind: 'relative', durationMs: 2_592_000_000 };
let capabilityResult: () => Promise<JsonValue> = async () => ({ kind: 'available' });
type ConfigurationRequest = Readonly<{
  kind?: string;
  organizationUuid?: string;
  page?: Readonly<{ kind?: string; next?: string }>;
}>;
let configurationResult: ((input: Readonly<{
  request: ConfigurationRequest;
  signal: AbortSignal;
}>) => Promise<JsonValue>) | null = null;
const ORGANIZATIONS_NEXT = 'https://eu.posthog.com/api/organizations/?limit=754&offset=754';
const ENVIRONMENTS_NEXT = 'https://eu.posthog.com/api/organizations/00000000-0000-4000-8000-0000000000a1/projects/?limit=754&offset=754';

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
        binding: {
          purpose: 'posthog-api',
          account: {
            service: { pluginId: POSTHOG_PLUGIN_ID, localId: 'posthog-api' },
            accountId: 'account-1',
          },
        },
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
  if (ref.localId === POSTHOG_ACTION_IDS.capability) return await capabilityResult();
  if (ref.localId === 'sources/administer-v1') {
    return { kind: 'active', sourceInstanceId: '11111111-1111-4111-8111-111111111111' };
  }
  return { kind: 'read', status: 'complete', instances: [] };
}

async function mountSettings(): Promise<PluginUiTestkit> {
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: {
        pluginId: POSTHOG_PLUGIN_ID,
        pluginVersion: '0.0.0',
        viewId: 'triage-sources',
        generation: 'triage-sources-mount',
      },
      surface: renderSurface,
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        executeAction: async ({ action, input, signal }) => await executeAction({ action, input, signal }),
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
  capabilityResult = async () => ({ kind: 'available' });
  configurationResult = null;
  for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('the mounted PostHog PRs & Issues settings page', () => {
  it('asks its own plugin what it can reach, and the target for the rest', async () => {
    await mountSettings();

    expect(recorded.map((entry) => entry.action)).toEqual([
      { pluginId: POSTHOG_PLUGIN_ID, localId: POSTHOG_ACTION_IDS.listInstances },
      { ...TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1 },
    ]);
    // Both mount reads are reads: opening a settings page must never configure
    // anything.
    expect(recorded.map((entry) => entry.input)).toEqual([{ v: 1 }, { v: 1 }]);
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

    await expect(page.getByText('Choose PostHog environments')).resolves.toBeDefined();
    expect(recorded.some((entry) => (
      (entry.action as Readonly<{ localId?: string }>).localId === 'sources/administer-v1'
    ))).toBe(false);
  });

  it('checks the selected Error Tracking capability before it administers the draft', async () => {
    const page = await mountSettings();
    await act(async () => {
      await page.press(await page.getByRole('button', {
        name: 'Add Example organization to PRs & Issues',
      }));
    });
    const save = await page.findByRole('button', { name: 'Save PostHog configuration' });
    await act(async () => { await page.press(save); });

    const actionIds = recorded.map((entry) => (
      entry.action as Readonly<{ localId?: string }>
    ).localId);
    expect(actionIds.indexOf(POSTHOG_ACTION_IDS.capability)).toBeGreaterThan(-1);
    expect(actionIds.indexOf('sources/administer-v1'))
      .toBeGreaterThan(actionIds.indexOf(POSTHOG_ACTION_IDS.capability));
  });

  it('does not administer a draft when a capability check settles after the editor unmounts', async () => {
    let release!: (value: JsonValue) => void;
    capabilityResult = async () => await new Promise<JsonValue>((resolve) => {
      release = resolve;
    });
    const page = await mountSettings();
    await act(async () => {
      await page.press(await page.getByRole('button', {
        name: 'Add Example organization to PRs & Issues',
      }));
    });
    const save = await page.findByRole('button', { name: 'Save PostHog configuration' });
    await act(async () => {
      await page.press(save);
      await Promise.resolve();
    });
    await act(async () => {
      await page.press(await page.getByRole('button', { name: 'Cancel' }));
    });
    await act(async () => {
      release({ kind: 'available' });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(recorded.some((entry) => (
      (entry.action as Readonly<{ localId?: string }>).localId === 'sources/administer-v1'
    ))).toBe(false);
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
      await page.press(await page.findByRole('button', { name: 'Save PostHog configuration' }));
    });
    const capability = recorded.find((entry) => (
      (entry.action as Readonly<{ localId?: string }>).localId === POSTHOG_ACTION_IDS.capability
    ));
    const token = (
      capability?.input as Readonly<{
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

  it('keeps a new organization current when its predecessor environment page settles late', async () => {
    const organizationA = '00000000-0000-4000-8000-0000000000a1';
    const organizationB = '00000000-0000-4000-8000-0000000000a2';
    let resolveB!: (value: JsonValue) => void;
    let observeB!: () => void;
    const startedB = new Promise<void>((resolve) => { observeB = resolve; });
    let staleSignal!: AbortSignal;
    configurationResult = async ({ request, signal }) => {
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
      if (request.organizationUuid === organizationB) {
        staleSignal = signal;
        observeB();
        return await new Promise<JsonValue>((resolve) => { resolveB = resolve; });
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
    await startedB;

    await act(async () => {
      await page.press(await page.getByRole('radio', { name: 'Organization A' }));
    });
    expect(staleSignal.aborted).toBe(true);

    await act(async () => {
      resolveB({
        kind: 'environments',
        organizationUuid: organizationB,
        rows: [{
          teamPathId: 4822,
          teamUuid: '00000000-0000-4000-8000-0000000000d2',
          parentProjectId: 4820,
          displayName: 'Environment B',
        }],
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    await expect(page.queryByRole('checkbox', { name: 'Environment B' })).resolves.toBeUndefined();
  });

  it('cancels an in-flight environment page when the editor unmounts', async () => {
    const organizationA = '00000000-0000-4000-8000-0000000000a1';
    const organizationB = '00000000-0000-4000-8000-0000000000a2';
    let environmentSignal!: AbortSignal;
    let observeEnvironment!: () => void;
    const environmentStarted = new Promise<void>((resolve) => { observeEnvironment = resolve; });
    configurationResult = async ({ request, signal }) => {
      if (request.kind === 'organizations') {
        return {
          kind: 'organizations',
          rows: [{
            organizationUuid: organizationA,
            displayName: 'Example organization',
            localInstanceKey: `posthog-org:https://eu.posthog.com:${organizationA}`,
          }, {
            organizationUuid: organizationB,
            displayName: 'Organization B',
            localInstanceKey: `posthog-org:https://eu.posthog.com:${organizationB}`,
          }],
        };
      }
      environmentSignal = signal;
      observeEnvironment();
      return await new Promise<JsonValue>(() => {
        // The provider boundary deliberately ignores abort; mounted currentness still
        // must withdraw the request and make its late settlement inert.
      });
    };

    const page = await mountSettings();
    await act(async () => {
      await page.press(await page.getByRole('button', {
        name: 'Add Example organization to PRs & Issues',
      }));
    });
    await act(async () => {
      await page.press(await page.findByRole('radio', { name: 'Organization B' }));
    });
    await environmentStarted;

    await act(async () => {
      await page.press(await page.getByRole('button', { name: 'Cancel' }));
    });
    expect(environmentSignal.aborted).toBe(true);
  });
});
