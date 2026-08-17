// @vitest-environment jsdom
import { act } from 'react';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import {
  TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1,
  TriageSourceAdministrationActionInputV1Schema,
} from '@happier-dev/triage-protocol/v1';
import { afterEach, describe, expect, it } from 'vitest';

import { BITBUCKET_PLUGIN_ID } from '../../bitbucketContracts.js';
import { BITBUCKET_TRIAGE_ACTION_IDS } from '../../triage/source/actions.js';

import { renderSurface } from './renderSettingsSurface.js';

/**
 * The settings page, mounted the way the host mounts it.
 *
 * Nothing between the press and the target is stood in for: the surface reaches
 * the published Actions through the SDK's own mounted Host API client, and the
 * administration request is admitted by the SAME published schema the target
 * parses. That is the whole point of these cases — a page whose own tests
 * import its component directly proves nothing about whether the host can reach
 * it, and a page that sends a draft the target would reject would still look
 * green under a hand-rolled assertion on its fields.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PURPOSE = 'bitbucket-connected-account';
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';

function binding(accountId: string): JsonValue {
  return {
    purpose: PURPOSE,
    account: {
      service: { pluginId: BITBUCKET_PLUGIN_ID, localId: 'bitbucket-account' },
      accountId,
    },
  };
}

function candidate(nameWithOwner: string, accountId = 'account-1'): JsonValue {
  return {
    v: 1,
    binding: binding(accountId),
    localInstanceKey: nameWithOwner,
    keyStability: 'stable',
    configuration: { v: 1, token: `source:${nameWithOwner}` },
    locator: { v: 1, displayLabel: nameWithOwner, displayPath: nameWithOwner },
  };
}

type Recorded = Readonly<{ action: unknown; input: unknown }>;

function createHarness(options: Readonly<{
  discovery: JsonValue;
  /**
   * One answer, or one answer per administration press in order. The lifecycle
   * cases need a sequence because the whole point is that the row's next
   * control depends on the arm the target returned for the previous press.
   */
  administration?: readonly JsonValue[];
}>) {
  const recorded: Recorded[] = [];
  const answers: readonly JsonValue[] = options.administration
    ?? [{ kind: 'active', sourceInstanceId: INSTANCE_ID }];
  let administered = 0;

  async function executeAction(
    { action, input }: Readonly<{ action: unknown; input: unknown }>,
  ): Promise<JsonValue> {
    recorded.push({ action, input });
    const ref = action as Readonly<{ pluginId?: string; localId?: string }>;
    if (ref.localId === BITBUCKET_TRIAGE_ACTION_IDS.listInstances) return options.discovery;
    if (
      ref.pluginId === TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1.pluginId
      && ref.localId === TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1.localId
    ) {
      const answer = answers[Math.min(administered, answers.length - 1)];
      administered += 1;
      if (answer === undefined) throw new Error('no administration answer configured');
      return answer;
    }
    throw new Error(`unexpected action ${JSON.stringify(action)}`);
  }

  /** Every administration request, admitted by the schema the target parses. */
  function administrations(): readonly unknown[] {
    return recorded
      .filter((entry) => (
        (entry.action as Readonly<{ localId?: string }>).localId
          === TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1.localId
      ))
      .map((entry) => TriageSourceAdministrationActionInputV1Schema.parse(entry.input));
  }

  return { recorded, executeAction, administrations };
}

const mounted: PluginUiTestkit[] = [];

async function mountSettings(harness: ReturnType<typeof createHarness>): Promise<PluginUiTestkit> {
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: {
        pluginId: BITBUCKET_PLUGIN_ID,
        pluginVersion: '0.0.0',
        viewId: 'triage-sources',
        generation: 'triage-sources-mount',
      },
      surface: renderSurface,
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        executeAction: async ({ action, input }) => await harness.executeAction({ action, input }),
      },
    });
  });
  mounted.push(fixture);
  return fixture;
}

async function pressControl(page: PluginUiTestkit, name: string): Promise<void> {
  await act(async () => {
    await page.press(await page.getByRole('button', { name }));
  });
}

afterEach(async () => {
  for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('the mounted Bitbucket Cloud PRs & Issues settings page', () => {
  it('lists what this source can reach and configures the one the user chose', async () => {
    const harness = createHarness({
      discovery: { kind: 'complete', candidates: [candidate('acme-workspace')], failures: [] },
    });
    const page = await mountSettings(harness);

    await expect(page.getByText('acme-workspace')).resolves.toEqual({ content: 'acme-workspace' });

    await pressControl(page, 'Add acme-workspace to PRs & Issues');

    // Admitted by the published schema the target itself parses, so a draft this
    // page would send but the target would reject cannot pass here.
    const administrations = harness.administrations();
    expect(administrations).toHaveLength(1);
    expect(administrations[0]).toMatchObject({
      v: 1,
      kind: 'create',
      draft: { binding: binding('account-1'), localInstanceKey: 'acme-workspace' },
    });
    await expect(page.getByText('Added to PRs & Issues.'))
      .resolves.toEqual({ content: 'Added to PRs & Issues.' });
  });

  it('never asks the target to configure anything merely by opening the page', async () => {
    const harness = createHarness({
      discovery: { kind: 'complete', candidates: [candidate('acme-workspace')], failures: [] },
    });
    await mountSettings(harness);

    // Discovery is read-only. A page that configured a discovered candidate on
    // mount would turn "look at my accounts" into a durable Account write.
    expect(harness.recorded.map((entry) => (entry.action as Readonly<{ localId?: string }>).localId))
      .toEqual([BITBUCKET_TRIAGE_ACTION_IDS.listInstances]);
  });

  it('offers no exact-row control until the target has named the row', async () => {
    const harness = createHarness({
      discovery: { kind: 'complete', candidates: [candidate('acme-workspace')], failures: [] },
    });
    const page = await mountSettings(harness);

    // Remove, Update and Restore each name one exact configured row. Offering
    // any of them before the target returned an id would be a control that
    // cannot be honoured — and this page cannot read the rows it did not write.
    await expect(page.queryByRole('button', { name: 'Remove acme-workspace from PRs & Issues' }))
      .resolves.toBeUndefined();
    await expect(page.queryByRole('button', { name: 'Update acme-workspace from the provider' }))
      .resolves.toBeUndefined();
    await expect(page.queryByRole('button', { name: 'Restore acme-workspace to PRs & Issues' }))
      .resolves.toBeUndefined();
  });

  it('takes a configured source back out again, and can bring it back', async () => {
    const harness = createHarness({
      discovery: { kind: 'complete', candidates: [candidate('acme-workspace')], failures: [] },
      administration: [
        { kind: 'active', sourceInstanceId: INSTANCE_ID },
        { kind: 'reconfigured', sourceInstanceId: INSTANCE_ID },
        { kind: 'removed', sourceInstanceId: INSTANCE_ID },
        { kind: 'reactivated', sourceInstanceId: INSTANCE_ID },
      ],
    });
    const page = await mountSettings(harness);

    await pressControl(page, 'Add acme-workspace to PRs & Issues');
    await pressControl(page, 'Update acme-workspace from the provider');
    await pressControl(page, 'Remove acme-workspace from PRs & Issues');

    // Removal says exactly what it costs. Entries are a projection of what the
    // source can still see, so they go; a pin and a Session link are the user's
    // own state and outlive the configured row.
    await expect(page.getByText(
      'Removed from PRs & Issues. Its entries leave the list; the pins and Session links you made stay.',
    )).resolves.toBeDefined();

    // Restore is the only arm that may revive a retired row, and it names that
    // row's exact stable ref rather than asking for a second one.
    await pressControl(page, 'Restore acme-workspace to PRs & Issues');
    await expect(page.getByText('Restored to PRs & Issues.')).resolves.toBeDefined();

    expect(harness.administrations().map((input) => {
      const arm = input as Readonly<{ kind: string; sourceInstanceId?: string }>;
      return [arm.kind, arm.sourceInstanceId ?? null];
    })).toEqual([
      ['create', null],
      ['reconfigure', INSTANCE_ID],
      ['remove', INSTANCE_ID],
      ['reactivate', INSTANCE_ID],
    ]);
  });

  it('never turns a create the target refused into a silent revival', async () => {
    const harness = createHarness({
      discovery: { kind: 'complete', candidates: [candidate('acme-workspace')], failures: [] },
      administration: [{ kind: 'conflict' }],
    });
    const page = await mountSettings(harness);

    await pressControl(page, 'Add acme-workspace to PRs & Issues');

    // A conflict is a retired row this page cannot see. Retrying as reactivate
    // would be this surface deciding a lifecycle the target refused.
    await expect(page.getByText('You removed this earlier. This page cannot bring it back yet.'))
      .resolves.toBeDefined();
    expect(harness.administrations().map((input) => (input as Readonly<{ kind: string }>).kind))
      .toEqual(['create']);
    await expect(page.queryByRole('button', { name: 'Restore acme-workspace to PRs & Issues' }))
      .resolves.toBeUndefined();
  });

  it('says the list may be short instead of rendering an incomplete listing as the whole truth', async () => {
    const harness = createHarness({
      discovery: {
        kind: 'incomplete',
        candidates: [candidate('acme-workspace')],
        failures: [],
        failure: { class: 'rateLimit', code: 'provider-secondary-rate-limit' },
      },
    });
    const page = await mountSettings(harness);

    await expect(page.getByText('This list may be incomplete'))
      .resolves.toEqual({ content: 'This list may be incomplete' });
    await expect(page.getByText('acme-workspace')).resolves.toEqual({ content: 'acme-workspace' });
  });

  it('names the account that stopped working rather than dropping it from the page', async () => {
    const harness = createHarness({
      discovery: {
        kind: 'complete',
        candidates: [],
        failures: [{
          binding: binding('account-2'),
          localInstanceKey: 'acme/legacy',
          failure: { class: 'authentication', code: 'provider-token-expired' },
        }],
      },
    });
    const page = await mountSettings(harness);

    await expect(page.getByText('acme/legacy')).resolves.toEqual({ content: 'acme/legacy' });
    await expect(page.getByText(
      'The connected account is no longer authorized. Reconnect it in Connected Accounts.',
    )).resolves.toBeDefined();
  });

  it('reports a source that could not be reached rather than an empty list', async () => {
    const harness = createHarness({
      discovery: { kind: 'failed', failure: { class: 'transient', code: 'provider-unreachable' } },
    });
    const page = await mountSettings(harness);

    await expect(page.getByText('Bitbucket Cloud could not be read'))
      .resolves.toEqual({ content: 'Bitbucket Cloud could not be read' });
    await expect(page.queryByText('No Bitbucket Cloud scopes to add')).resolves.toBeUndefined();
  });

  it('tells the user a source the host no longer admits cannot be configured', async () => {
    const harness = createHarness({
      discovery: { kind: 'complete', candidates: [candidate('acme-workspace')], failures: [] },
      administration: [{ kind: 'invalidCaller' }],
    });
    const page = await mountSettings(harness);

    await pressControl(page, 'Add acme-workspace to PRs & Issues');

    await expect(page.getByText(
      'Bitbucket Cloud is no longer an admitted PRs & Issues source on this account.',
    )).resolves.toBeDefined();
  });
});
