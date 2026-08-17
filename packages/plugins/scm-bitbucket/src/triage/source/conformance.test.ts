import { definePlugin } from '@happier-dev/plugin-sdk';
import { checkTriageSourceContributionV1 } from '@happier-dev/triage-protocol/testing/v1';
import {
  TriageSourceDescriptorV1Schema,
  TriageSourcesContributionProtocolV1,
} from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from '../../manifest.js';
import { BITBUCKET_TRIAGE_ACTION_IDS } from './actions.js';
import { BITBUCKET_TRIAGE_DETAIL_ACTION_IDS } from './detailActions.js';
import { BITBUCKET_CONNECTED_ACCOUNT_PURPOSE, BITBUCKET_TRIAGE_DESCRIPTOR } from './descriptor.js';

/**
 * The manifest as the host actually receives it.
 *
 * A bundled plugin is admitted from the `.happier-plugin/plugin.json` bytes the build emits, never
 * from this in-memory value, so conformance is checked against the serialized form: what ships is
 * what is asserted. `definePlugin` additionally brands its projected manifest with a
 * non-enumerable `Symbol.for(...)` semantic carrier that JSON cannot express, so serializing here
 * also proves the contribution needs none of that process-local sidecar to be admitted.
 */
function serializedManifest(): unknown {
  return JSON.parse(JSON.stringify(PLUGIN_MANIFEST));
}

/**
 * Conformance is checked with the protocol package's own reader rather than a parallel local one,
 * so a contract change fails here instead of drifting into a second admission opinion.
 */
describe('Bitbucket Triage source contribution conformance', () => {
  it('declares the descriptor, protocol identity and all three required role Actions', () => {
    const result = checkTriageSourceContributionV1(serializedManifest());

    // Admission is the whole contribution, not a subset of it: a source whose detail surface is
    // unbound is rejected outright, so a manifest that conforms "except for the renderer"
    // contributes nothing at all. The error list is asserted rather than only the boolean so a
    // regression names itself.
    expect(result.ok ? [] : result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('declares one pull-request kind and no Bitbucket Cloud issue kind', () => {
    const descriptor = TriageSourceDescriptorV1Schema.parse(BITBUCKET_TRIAGE_DESCRIPTOR);

    expect(descriptor.kinds.map((kind) => kind.id)).toEqual(['pull-request']);
    expect(descriptor.kinds[0]?.workflowSubject).toBe('pullRequest');
    expect(descriptor.purpose).toBe('bitbucket-connected-account');
    expect(JSON.stringify(PLUGIN_MANIFEST.contributes.targetedPluginContributions))
      .not.toContain('issue');
  });

  it('binds each role Action to the exact published input and result schemas', () => {
    const contribution = PLUGIN_MANIFEST.contributes.targetedPluginContributions[0];
    const actions = new Map(PLUGIN_MANIFEST.contributes.actions.map((action) => [action.id, action]));

    expect(contribution?.target).toEqual({ pluginId: 'happier.triage', pointId: 'sources' });
    expect(contribution?.protocol).toEqual({ id: 'happier.triage/sources', version: 1 });
    for (const actionId of Object.values(contribution?.operations ?? {})) {
      const action = actions.get(actionId);
      expect(action?.surfaces).toEqual(['plugin']);
      expect(action?.dangerLevel).toBe('safe');
      expect(action?.hostAccess).toEqual(['bitbucket-api', 'bitbucket-connected-account']);
    }
  });

  it('declares each source-native detail plane as a plugin-surfaced account-bound read', () => {
    const actions = new Map(PLUGIN_MANIFEST.contributes.actions.map((action) => [action.id, action]));

    for (const id of Object.values(BITBUCKET_TRIAGE_DETAIL_ACTION_IDS)) {
      const action = actions.get(id);
      // Declared at all: a mounted detail body invoking an undeclared Action is
      // refused by the host, and the panel would report a contract break the user
      // cannot act on.
      expect(action, `${id} must be declared`).toBeDefined();
      // `plugin` only: these are this source's own reads, not a surface the
      // aggregate or another plugin may call.
      expect(action?.surfaces).toEqual(['plugin']);
      expect(action?.dangerLevel).toBe('safe');
      expect(action?.hostAccess).toEqual(['bitbucket-api', 'bitbucket-connected-account']);
      // Every detail plane carries a configured instance, so every one binds the
      // exact account leaf the host revalidates.
      expect(action?.connectedAccountPurposeBindings).toEqual([{
        path: 'instance.binding.account',
        purpose: BITBUCKET_CONNECTED_ACCOUNT_PURPOSE,
      }]);
    }
    // They are NOT source-protocol roles: the contribution binds three operations,
    // and adding a fourth would publish Bitbucket vocabulary into a shared
    // contract that has no such role.
    const contribution = PLUGIN_MANIFEST.contributes.targetedPluginContributions[0];
    expect(Object.keys(contribution?.operations ?? {}).sort())
      .toEqual(['get', 'listInstances', 'scan']);
  });

  it('binds the exact account path on every read Action that receives one', () => {
    const actions = new Map(PLUGIN_MANIFEST.contributes.actions.map((action) => [action.id, action]));
    const binding = [{
      path: 'instance.binding.account',
      purpose: BITBUCKET_CONNECTED_ACCOUNT_PURPOSE,
    }];

    for (const id of [BITBUCKET_TRIAGE_ACTION_IDS.scan, BITBUCKET_TRIAGE_ACTION_IDS.get]) {
      expect(actions.get(id)?.connectedAccountPurposeBindings).toEqual(binding);
    }
    // Discovery produces account references rather than receiving one, so it has no account path
    // to bind and declaring one would name an input leaf that does not exist.
    expect(actions.get(BITBUCKET_TRIAGE_ACTION_IDS.listInstances)?.connectedAccountPurposeBindings)
      .toBeUndefined();
  });

  it('has its scan purpose binding enforced, not merely tolerated', () => {
    const sources = TriageSourcesContributionProtocolV1;
    const declare = (path: string): unknown => definePlugin({
      id: 'happier.scm.forge.bitbucket',
      version: '0.0.0',
      displayName: 'Bitbucket',
      description: 'Declaration-time check of the union-input purpose binding.',
      engines: { happier: '^0.0.0' },
      runtime: { apiVersion: 1 },
      entrypoints: { daemon: './dist/index.js' },
      hostAccess: { required: [], optional: [] },
      actions: {
        [BITBUCKET_TRIAGE_ACTION_IDS.scan]: {
          title: 'Scan Bitbucket Cloud pull requests',
          description: 'Reads one bounded page of pull requests for one configured workspace.',
          scopes: ['global'],
          surfaces: sources.operations.scan.declaration.surfaces,
          dangerLevel: sources.operations.scan.declaration.dangerLevel,
          inputSchema: sources.operations.scan.declaration.input.schema.jsonSchema,
          resultSchema: sources.operations.scan.declaration.resultSchema.jsonSchema,
          connectedAccountPurposeBindings: [{ path, purpose: BITBUCKET_CONNECTED_ACCOUNT_PURPOSE }],
          run: async () => ({ kind: 'failed', failure: { class: 'unknown', code: 'x' } }),
        },
      },
    });

    // The published scan input is a two-arm union. The account path both arms carry is accepted...
    expect(() => declare('instance.binding.account')).not.toThrow();
    // ...and a path that is not an exact credential ref in every arm is refused, which is what
    // makes the accepted declaration a proven cross-check rather than a field the parser walked
    // past.
    expect(() => declare('page.continuation.token')).toThrow(
      /Connected Account purpose bindings/u,
    );
  });
});
