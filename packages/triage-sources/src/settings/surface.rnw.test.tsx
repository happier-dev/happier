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
} from '@happier-dev/triage-protocol/v1';
import { afterEach, describe, expect, it } from 'vitest';

import { createTriageSourceSettingsSurface } from './surface.js';

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
 *
 * The identity below is deliberately not one of the six shipped sources. This
 * page is the same page for every source, so a case that only passes because it
 * says "GitHub" would be testing a coincidence; the six packages each own one
 * small case proving they hand this factory their own identity.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PLUGIN_ID = 'example.tracker';
const LIST_INSTANCES_LOCAL_ACTION_ID = 'triage-list-instances-v1';
const SOURCE_DISPLAY_NAME = 'Example Tracker';
const PURPOSE = 'tracker-connected-account';
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';

const renderSurface = createTriageSourceSettingsSurface({
  pluginId: PLUGIN_ID,
  listInstancesLocalActionId: LIST_INSTANCES_LOCAL_ACTION_ID,
  sourceDisplayName: SOURCE_DISPLAY_NAME,
});

function binding(accountId: string): JsonValue {
  return {
    purpose: PURPOSE,
    account: {
      service: { pluginId: PLUGIN_ID, localId: 'tracker-account' },
      accountId,
    },
  };
}

function candidate(scope: string, accountId = 'account-1'): JsonValue {
  return {
    v: 1,
    binding: binding(accountId),
    localInstanceKey: scope,
    keyStability: 'stable',
    configuration: { v: 1, token: `source:${scope}` },
    locator: { v: 1, displayLabel: scope, displayPath: scope },
  };
}

/**
 * One configured instance exactly as the target's caller-scoped read publishes
 * it, so what the page learns on mount comes through the same bytes the real
 * Action returns.
 */
function configuredRecord(
  scope: string,
  lifecycle: 'active' | 'retired',
  accountId = 'account-1',
): JsonValue {
  return {
    v: 1,
    lifecycle,
    configured: {
      v: 1,
      instance: {
        source: { pluginId: PLUGIN_ID, localId: 'tracker' },
        sourceInstanceId: INSTANCE_ID,
      },
      binding: binding(accountId),
      localInstanceKey: scope,
      configuration: { v: 1, token: `source:${scope}` },
      locator: { v: 1, displayLabel: scope, displayPath: scope },
    },
  };
}

type Recorded = Readonly<{ action: unknown; input: unknown }>;

type Confirmation = Readonly<{ message: string; title?: string }>;

function createHarness(options: Readonly<{
  discovery: JsonValue;
  /**
   * What the user answers the removal question. `unavailable` mounts a host that
   * does not advertise `confirm` at all, which is how a page reaches the arm
   * where the question could never be put.
   */
  confirm?: boolean | 'unavailable';
  /**
   * What the target says this source has already configured. Defaults to nothing
   * configured, which is the state a first visit is in.
   */
  configured?: JsonValue;
  /** What that read answers from the second time onward, i.e. after a Refresh. */
  configuredAgain?: JsonValue;
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
  let configuredReads = 0;

  async function executeAction(
    { action, input }: Readonly<{ action: unknown; input: unknown }>,
  ): Promise<JsonValue> {
    recorded.push({ action, input });
    const ref = action as Readonly<{ pluginId?: string; localId?: string }>;
    if (ref.localId === LIST_INSTANCES_LOCAL_ACTION_ID) return options.discovery;
    if (
      ref.pluginId === TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1.pluginId
      && ref.localId === TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1.localId
    ) {
      const answer = configuredReads === 0
        ? options.configured
        : options.configuredAgain ?? options.configured;
      configuredReads += 1;
      return answer ?? { kind: 'read', status: 'complete', instances: [] };
    }
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

  const confirmations: Confirmation[] = [];
  const confirm = options.confirm ?? true;
  const confirmHandler = confirm === 'unavailable'
    ? undefined
    : (input: Readonly<{ message: string; title?: string }>): boolean => {
      confirmations.push({
        message: input.message,
        ...(input.title === undefined ? {} : { title: input.title }),
      });
      return confirm;
    };

  return { recorded, executeAction, administrations, confirmations, confirmHandler };
}

const mounted: PluginUiTestkit[] = [];

async function mountSettings(
  harness: ReturnType<typeof createHarness>,
  translations: Readonly<Record<string, string>> = {},
): Promise<PluginUiTestkit> {
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: {
        pluginId: PLUGIN_ID,
        pluginVersion: '0.0.0',
        viewId: 'triage-sources',
        generation: 'triage-sources-mount',
      },
      surface: renderSurface,
      surfaceContext: createSurfaceContextFixture({ translations }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        executeAction: async ({ action, input }) => await harness.executeAction({ action, input }),
        // Installed only when the case wants a host that advertises `confirm`.
        // The testkit advertises exactly the methods it was given a handler for,
        // so omitting it is the real "this host cannot ask" mount.
        ...(harness.confirmHandler === undefined ? {} : { confirm: harness.confirmHandler }),
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

describe('the mounted PRs & Issues source settings page', () => {
  it('asks the exact source it was handed, and the target for the rest', async () => {
    const harness = createHarness({
      discovery: { kind: 'complete', candidates: [candidate('acme/api')], failures: [] },
    });
    await mountSettings(harness);

    // The three identity facts are the whole of what a source contributes. A page
    // that enumerated through some other plugin's Action would list scopes the
    // user cannot configure here.
    expect(harness.recorded.map((entry) => entry.action)).toContainEqual({
      pluginId: PLUGIN_ID,
      localId: LIST_INSTANCES_LOCAL_ACTION_ID,
    });
    expect(harness.recorded.map((entry) => entry.action))
      .toContainEqual({ ...TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1 });
  });

  it('lists what this source can reach and configures the one the user chose', async () => {
    const harness = createHarness({
      discovery: { kind: 'complete', candidates: [candidate('acme/api')], failures: [] },
    });
    const page = await mountSettings(harness);

    await expect(page.getByText('acme/api')).resolves.toEqual({ content: 'acme/api' });

    await pressControl(page, 'Add acme/api to PRs & Issues');

    // Admitted by the published schema the target itself parses, so a draft this
    // page would send but the target would reject cannot pass here.
    const administrations = harness.administrations();
    expect(administrations).toHaveLength(1);
    expect(administrations[0]).toMatchObject({
      v: 1,
      kind: 'create',
      draft: { binding: binding('account-1'), localInstanceKey: 'acme/api' },
    });
    await expect(page.getByText('Added to PRs & Issues.'))
      .resolves.toEqual({ content: 'Added to PRs & Issues.' });
  });

  it('never asks the target to configure anything merely by opening the page', async () => {
    const harness = createHarness({
      discovery: { kind: 'complete', candidates: [candidate('acme/api')], failures: [] },
    });
    await mountSettings(harness);

    // Both mount reads are reads. A page that configured a discovered candidate
    // on mount would turn "look at my accounts" into a durable Account write.
    expect(new Set(harness.recorded.map((entry) => (
      (entry.action as Readonly<{ localId?: string }>).localId
    )))).toEqual(new Set([
      LIST_INSTANCES_LOCAL_ACTION_ID,
      TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1.localId,
    ]));
    expect(harness.administrations()).toEqual([]);
  });

  it('knows what an earlier visit configured before the user presses anything', async () => {
    const harness = createHarness({
      discovery: { kind: 'complete', candidates: [candidate('acme/api')], failures: [] },
      configured: {
        kind: 'read',
        status: 'complete',
        instances: [configuredRecord('acme/api', 'active')],
      },
    });
    const page = await mountSettings(harness);

    // This is the remount: nothing was pressed here, and the exact-row arms are
    // reachable anyway because the target itself named the row.
    await expect(page.getByText('In PRs & Issues.')).resolves.toBeDefined();
    await expect(page.queryByRole('button', { name: 'Add acme/api to PRs & Issues' }))
      .resolves.toBeUndefined();
    await pressControl(page, 'Remove acme/api from PRs & Issues');
    expect(harness.administrations()).toEqual([
      { v: 1, kind: 'remove', sourceInstanceId: INSTANCE_ID },
    ]);
  });

  it('asks before removing a configured source, and names what removal costs', async () => {
    const harness = createHarness({
      discovery: { kind: 'complete', candidates: [candidate('acme/api')], failures: [] },
      configured: {
        kind: 'read',
        status: 'complete',
        instances: [configuredRecord('acme/api', 'active')],
      },
      administration: [{ kind: 'removed', sourceInstanceId: INSTANCE_ID }],
    });
    const page = await mountSettings(harness);

    await pressControl(page, 'Remove acme/api from PRs & Issues');

    // The question names the exact row, not just the source: a person with
    // several scopes configured from one account is choosing between rows.
    expect(harness.confirmations).toHaveLength(1);
    expect(harness.confirmations[0]?.title).toBe('Remove acme/api from PRs & Issues?');
    const asked = harness.confirmations[0]?.message ?? '';
    expect(asked).toContain('acme/api');
    expect(asked).toContain(SOURCE_DISPLAY_NAME);
    // Both halves of the blast radius, because either one alone misleads: a
    // question that only said "entries leave" reads as data loss and stops
    // people removing a source at all.
    expect(asked).toContain('entries leave the list');
    expect(asked).toContain('pins and Session links you made stay');

    // Approved, so the arm ran exactly once and named that row.
    expect(harness.administrations()).toEqual([
      { v: 1, kind: 'remove', sourceInstanceId: INSTANCE_ID },
    ]);
  });

  it('removes nothing when the user declines the question', async () => {
    const harness = createHarness({
      discovery: { kind: 'complete', candidates: [candidate('acme/api')], failures: [] },
      configured: {
        kind: 'read',
        status: 'complete',
        instances: [configuredRecord('acme/api', 'active')],
      },
      confirm: false,
    });
    const page = await mountSettings(harness);

    await pressControl(page, 'Remove acme/api from PRs & Issues');

    // Removal is irreversible from this page's side, so a decline must reach the
    // target as nothing at all rather than as a request it settles.
    expect(harness.confirmations).toHaveLength(1);
    expect(harness.administrations()).toEqual([]);
    // The row is untouched: still configured, still removable.
    await expect(page.getByText('In PRs & Issues.')).resolves.toBeDefined();
    await expect(page.getByRole('button', { name: 'Remove acme/api from PRs & Issues' }))
      .resolves.toBeDefined();
  });

  it('removes nothing, and says so, when the question could not be put to the user', async () => {
    const harness = createHarness({
      discovery: { kind: 'complete', candidates: [candidate('acme/api')], failures: [] },
      configured: {
        kind: 'read',
        status: 'complete',
        instances: [configuredRecord('acme/api', 'active')],
      },
      confirm: 'unavailable',
    });
    const page = await mountSettings(harness);

    await pressControl(page, 'Remove acme/api from PRs & Issues');

    // A host that cannot ask is not a user who said yes, and it is not a user who
    // said no either. Nothing is removed, and the row says what happened rather
    // than leaving a pressed button with no visible effect.
    expect(harness.administrations()).toEqual([]);
    await expect(page.getByText('This removal could not be confirmed, so nothing was removed. Try again.'))
      .resolves.toBeDefined();
    await expect(page.getByRole('button', { name: 'Remove acme/api from PRs & Issues' }))
      .resolves.toBeDefined();
  });

  it('restores what an earlier visit removed, under the exact ref the target named', async () => {
    const harness = createHarness({
      discovery: { kind: 'complete', candidates: [candidate('acme/api')], failures: [] },
      configured: {
        kind: 'read',
        status: 'complete',
        instances: [configuredRecord('acme/api', 'retired')],
      },
      administration: [{ kind: 'reactivated', sourceInstanceId: INSTANCE_ID }],
    });
    const page = await mountSettings(harness);

    // A source the user removed must not reappear as a fresh Add: that asks the
    // target to mint a sibling row for one intent, and it refuses with `conflict`.
    await expect(page.queryByRole('button', { name: 'Add acme/api to PRs & Issues' }))
      .resolves.toBeUndefined();
    await pressControl(page, 'Restore acme/api to PRs & Issues');

    expect(harness.administrations()).toEqual([
      { v: 1, kind: 'reactivate', sourceInstanceId: INSTANCE_ID, draft: candidate('acme/api') },
    ]);
    await expect(page.getByText('Restored to PRs & Issues.')).resolves.toBeDefined();
  });

  it('lets a Refresh replace what its own presses taught it', async () => {
    const harness = createHarness({
      discovery: { kind: 'complete', candidates: [candidate('acme/api')], failures: [] },
      configured: {
        kind: 'read',
        status: 'complete',
        instances: [configuredRecord('acme/api', 'active')],
      },
      // Another device put it back between the two reads.
      configuredAgain: {
        kind: 'read',
        status: 'complete',
        instances: [configuredRecord('acme/api', 'active')],
      },
      administration: [{ kind: 'removed', sourceInstanceId: INSTANCE_ID }],
    });
    const page = await mountSettings(harness);

    await pressControl(page, 'Remove acme/api from PRs & Issues');
    await expect(page.getByRole('button', { name: 'Restore acme/api to PRs & Issues' }))
      .resolves.toBeDefined();

    await pressControl(page, 'Refresh');

    // The re-read observes these rows after that press committed, so it is the
    // newer fact. A press result kept beside it is how a row that changed on
    // another device keeps showing this page's stale answer.
    await expect(page.getByRole('button', { name: 'Remove acme/api from PRs & Issues' }))
      .resolves.toBeDefined();
    await expect(page.queryByRole('button', { name: 'Restore acme/api to PRs & Issues' }))
      .resolves.toBeUndefined();
  });

  it('keeps the target answer when a press it made was refused', async () => {
    const harness = createHarness({
      discovery: { kind: 'complete', candidates: [candidate('acme/api')], failures: [] },
      configured: {
        kind: 'read',
        status: 'complete',
        instances: [configuredRecord('acme/api', 'retired')],
      },
      administration: [{ kind: 'currentnessConflict' }],
    });
    const page = await mountSettings(harness);

    await pressControl(page, 'Restore acme/api to PRs & Issues');

    // A refused press says nothing about what the row is. Recording it as
    // knowledge would drop the row back to Add and lose the only control that can
    // bring the user's own configuration back.
    await expect(page.getByText('Something changed while this was saving. Try again.'))
      .resolves.toBeDefined();
    await expect(page.getByRole('button', { name: 'Restore acme/api to PRs & Issues' }))
      .resolves.toBeDefined();
    await expect(page.queryByRole('button', { name: 'Add acme/api to PRs & Issues' }))
      .resolves.toBeUndefined();
  });

  it('shows the account the source itself named alongside the class remedy, not instead of it', async () => {
    const harness = createHarness({
      discovery: {
        kind: 'complete',
        candidates: [candidate('acme/api')],
        failures: [{
          binding: binding('account-2'),
          failure: {
            class: 'permission',
            code: 'scope-not-visible',
            detail: 'acme/private is not visible to this account.',
          },
        }],
      },
    });
    const page = await mountSettings(harness);

    // The source knows WHICH scope failed and this page does not, so its words
    // must survive. But the class sentence carries the REMEDY, and this is the
    // page the reader came to in order to fix the connection — so the two are
    // rendered together. Substituting one for the other drops either the fact
    // the reader can act on or the action they can take.
    await expect(page.getByText(
      'The connected account cannot see this scope. Grant it access at the provider.'
      + ' (acme/private is not visible to this account.)',
    )).resolves.toBeDefined();
    // Neither half renders alone.
    await expect(page.queryByText('acme/private is not visible to this account.'))
      .resolves.toBeUndefined();
  });

  it('renders a declared failure sentence in the reader own language', async () => {
    const harness = createHarness({
      discovery: {
        kind: 'complete',
        candidates: [candidate('acme/api')],
        failures: [{
          binding: binding('account-2'),
          failure: { class: 'authentication', code: 'token-expired' },
        }],
      },
    });
    const page = await mountSettings(harness, {
      'plugins.triage.sourceSettings.failure.authentication':
        'Le compte connecté n’est plus autorisé. Reconnectez-le dans Comptes connectés.',
    });

    await expect(page.getByText('Le compte connecté n’est plus autorisé. Reconnectez-le dans Comptes connectés.'))
      .resolves.toBeDefined();
  });

  it('keeps a configured account it can no longer reach visible and removable', async () => {
    const harness = createHarness({
      discovery: {
        kind: 'complete',
        candidates: [],
        failures: [{
          binding: binding('account-1'),
          failure: { class: 'authentication', code: 'provider-token-expired' },
        }],
      },
      configured: {
        kind: 'read',
        status: 'complete',
        instances: [configuredRecord('acme/api', 'active')],
      },
      administration: [{ kind: 'removed', sourceInstanceId: INSTANCE_ID }],
    });
    const page = await mountSettings(harness);

    // A disconnected account stops producing candidates. The configured instance
    // is still real, still in the product, and still the user's to remove — so it
    // gets an unusable state and the one arm that does not need a fresh draft.
    await expect(page.getByText(
      `In PRs & Issues, but ${SOURCE_DISPLAY_NAME} can no longer reach it. Its entries stop arriving until the account or scope comes back.`,
    )).resolves.toBeDefined();
    await expect(page.queryByRole('button', { name: 'Update acme/api from the provider' }))
      .resolves.toBeUndefined();
    await pressControl(page, 'Remove acme/api from PRs & Issues');
    expect(harness.administrations()).toEqual([
      { v: 1, kind: 'remove', sourceInstanceId: INSTANCE_ID },
    ]);
  });

  it('says it could not read what is configured instead of silently offering Add', async () => {
    const harness = createHarness({
      discovery: { kind: 'complete', candidates: [candidate('acme/api')], failures: [] },
      configured: { kind: 'currentnessConflict' },
    });
    const page = await mountSettings(harness);

    await expect(page.getByText('This page read while something was changing'))
      .resolves.toBeDefined();
    // Add stays available — the target refuses a duplicate safely — but the page
    // never implies that nothing is configured.
    await expect(page.getByRole('button', { name: 'Add acme/api to PRs & Issues' }))
      .resolves.toBeDefined();
  });

  it('offers no exact-row control until the target has named the row', async () => {
    const harness = createHarness({
      discovery: { kind: 'complete', candidates: [candidate('acme/api')], failures: [] },
    });
    const page = await mountSettings(harness);

    // Remove, Update and Restore each name one exact configured row. The target's
    // read named none here, so offering any of them would be a control that
    // cannot be honoured.
    await expect(page.queryByRole('button', { name: 'Remove acme/api from PRs & Issues' }))
      .resolves.toBeUndefined();
    await expect(page.queryByRole('button', { name: 'Update acme/api from the provider' }))
      .resolves.toBeUndefined();
    await expect(page.queryByRole('button', { name: 'Restore acme/api to PRs & Issues' }))
      .resolves.toBeUndefined();
  });

  it('takes a configured source back out again, and can bring it back', async () => {
    const harness = createHarness({
      discovery: { kind: 'complete', candidates: [candidate('acme/api')], failures: [] },
      administration: [
        { kind: 'active', sourceInstanceId: INSTANCE_ID },
        { kind: 'reconfigured', sourceInstanceId: INSTANCE_ID },
        { kind: 'removed', sourceInstanceId: INSTANCE_ID },
        { kind: 'reactivated', sourceInstanceId: INSTANCE_ID },
      ],
    });
    const page = await mountSettings(harness);

    await pressControl(page, 'Add acme/api to PRs & Issues');
    await pressControl(page, 'Update acme/api from the provider');
    await pressControl(page, 'Remove acme/api from PRs & Issues');

    // Removal says exactly what it costs. Entries are a projection of what the
    // source can still see, so they go; a pin and a Session link are the user's
    // own state and outlive the configured row.
    await expect(page.getByText(
      'Removed from PRs & Issues. Its entries leave the list; the pins and Session links you made stay.',
    )).resolves.toBeDefined();

    // Restore is the only arm that may revive a retired row, and it names that
    // row's exact stable ref rather than asking for a second one.
    await pressControl(page, 'Restore acme/api to PRs & Issues');
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
      discovery: { kind: 'complete', candidates: [candidate('acme/api')], failures: [] },
      administration: [{ kind: 'conflict' }],
    });
    const page = await mountSettings(harness);

    await pressControl(page, 'Add acme/api to PRs & Issues');

    // A conflict is a retired row this page cannot see. Retrying as reactivate
    // would be this surface deciding a lifecycle the target refused.
    await expect(page.getByText('You removed this earlier. This page cannot bring it back yet.'))
      .resolves.toBeDefined();
    expect(harness.administrations().map((input) => (input as Readonly<{ kind: string }>).kind))
      .toEqual(['create']);
    await expect(page.queryByRole('button', { name: 'Restore acme/api to PRs & Issues' }))
      .resolves.toBeUndefined();
  });

  it('says the list may be short instead of rendering an incomplete listing as the whole truth', async () => {
    const harness = createHarness({
      discovery: {
        kind: 'incomplete',
        candidates: [candidate('acme/api')],
        failures: [],
        failure: { class: 'rateLimit', code: 'provider-secondary-rate-limit' },
      },
    });
    const page = await mountSettings(harness);

    await expect(page.getByText('This list may be incomplete'))
      .resolves.toEqual({ content: 'This list may be incomplete' });
    await expect(page.getByText('acme/api')).resolves.toEqual({ content: 'acme/api' });
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

    await expect(page.getByText(`${SOURCE_DISPLAY_NAME} could not be read`))
      .resolves.toEqual({ content: `${SOURCE_DISPLAY_NAME} could not be read` });
    await expect(page.queryByText(`No ${SOURCE_DISPLAY_NAME} scopes to add`)).resolves.toBeUndefined();
  });

  it('tells the user a source the host no longer admits cannot be configured', async () => {
    const harness = createHarness({
      discovery: { kind: 'complete', candidates: [candidate('acme/api')], failures: [] },
      administration: [{ kind: 'invalidCaller' }],
    });
    const page = await mountSettings(harness);

    await pressControl(page, 'Add acme/api to PRs & Issues');

    await expect(page.getByText(
      `${SOURCE_DISPLAY_NAME} is no longer an admitted PRs & Issues source on this account.`,
    )).resolves.toBeDefined();
  });
});
