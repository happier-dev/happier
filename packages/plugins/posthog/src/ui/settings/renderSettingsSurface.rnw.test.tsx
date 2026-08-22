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

async function executeAction(
  { action, input }: Readonly<{ action: unknown; input: unknown }>,
): Promise<JsonValue> {
  recorded.push({ action, input });
  const ref = action as Readonly<{ pluginId?: string; localId?: string }>;
  if (ref.localId === POSTHOG_ACTION_IDS.listInstances) {
    return { kind: 'complete', candidates: [], failures: [] };
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
        executeAction: async ({ action, input }) => await executeAction({ action, input }),
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
});
