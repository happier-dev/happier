import { PluginActionContributionV2Schema, ingestPluginManifestV2 } from '@happier-dev/protocol';
import { checkTriageSourceContributionV1 } from '@happier-dev/triage-protocol/testing/v1';
import {
  TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
  TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
  TriageSourceDescriptorV1Schema,
} from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import {
  AZURE_DEVOPS_TRIAGE_DETAIL_ARTIFACT_ID,
  AZURE_DEVOPS_TRIAGE_DETAIL_RENDERER_ID,
  PLUGIN_MANIFEST,
} from '../manifest.js';
import { AZURE_DEVOPS_BASE_CONFIGURATION_FIELD } from '../auth/azureDevopsConnectedAccountRuntime.js';
import { AZURE_DEVOPS_TRIAGE_ACTION_IDS } from './actions.js';
import { AZURE_DEVOPS_TRIAGE_DETAIL_ACTION_IDS } from './detailActions.js';
import {
  AZURE_DEVOPS_CONNECTED_ACCOUNT_ID,
  AZURE_DEVOPS_NETWORK_HOST_ACCESS_ID,
  AZURE_DEVOPS_TRIAGE_DESCRIPTOR,
  AZURE_DEVOPS_TRIAGE_PURPOSE,
} from './descriptor.js';

/**
 * The manifest as the host actually receives it.
 *
 * A bundled plugin is admitted from the `.happier-plugin/plugin.json` bytes the build emits, never
 * from this in-memory value, so conformance is checked against the serialized form. It is also the
 * only form the canonical parser currently accepts: `definePlugin` brands its projected manifest
 * with a non-enumerable `Symbol.for(...)` carrier, and the ingest guard in
 * `packages/protocol/src/plugins/manifest/ingest.ts` rejects any symbol own-key before it checks
 * enumerability — so a value that JSON round-trips perfectly is refused as "not JSON
 * serializable". That is a defect at that owner, not here, and it does not change what ships.
 */
function serializedManifest(): unknown {
  return JSON.parse(JSON.stringify(PLUGIN_MANIFEST));
}

describe('Azure DevOps Triage source contribution conformance', () => {
  it('declares the descriptor, protocol identity and all three required role Actions', () => {
    const result = checkTriageSourceContributionV1(serializedManifest());

    // Admission is the whole contribution, not a subset of it: a source whose detail surface is
    // unbound is rejected outright, so a manifest that conforms "except for the renderer"
    // contributes nothing at all. The error list is asserted rather than only the boolean so a
    // regression names itself.
    expect(result.ok ? [] : result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('is admitted by the canonical manifest parser with its account descriptor and system tool', () => {
    // The Triage contribution's `connectedAccounts` grant is resolved against
    // `contributes.connectedAccountDescriptors`, so a purpose declared without its descriptor is a
    // manifest that passes source conformance and then fails host admission.
    expect(ingestPluginManifestV2(serializedManifest())).toMatchObject({ ok: true });
    expect(PLUGIN_MANIFEST.contributes.connectedAccountDescriptors.map((entry) => entry.id))
      .toEqual([AZURE_DEVOPS_CONNECTED_ACCOUNT_ID]);
    expect(PLUGIN_MANIFEST.contributes.systemTools.map((tool) => tool.id)).toEqual(['azure-cli']);
    expect(PLUGIN_MANIFEST.contributes.scmHostingProviders.map((provider) => provider.id))
      .toEqual(['azure-devops']);
  });

  it('declares each source-native detail plane as a plugin-surfaced account-bound read', () => {
    const actions = new Map(PLUGIN_MANIFEST.contributes.actions.map((action) => [action.id, action]));

    for (const actionId of Object.values(AZURE_DEVOPS_TRIAGE_DETAIL_ACTION_IDS)) {
      const action = actions.get(actionId);
      // Declared at all: a mounted detail body invoking an undeclared Action is
      // refused by the host, and the panel would report a contract break the
      // user cannot act on.
      expect(action, `${actionId} must be declared`).toBeDefined();
      // `plugin` only: these are this source's own reads, not a surface the
      // aggregate or another plugin may call.
      expect(action?.surfaces).toEqual(['plugin']);
      expect(action?.dangerLevel).toBe('safe');
      expect(action?.hostAccess)
        .toEqual([AZURE_DEVOPS_NETWORK_HOST_ACCESS_ID, AZURE_DEVOPS_TRIAGE_PURPOSE]);
      // Every detail plane carries a configured instance, so every one binds the
      // exact account leaf the host revalidates.
      expect(action?.connectedAccountPurposeBindings).toEqual([{
        path: 'instance.binding.account',
        purpose: AZURE_DEVOPS_TRIAGE_PURPOSE,
      }]);
    }
    // They are NOT source-protocol roles: the contribution binds three operations
    // and adding a fourth here would publish GitLab-style vocabulary into a
    // shared contract that has no such role.
    const contribution = PLUGIN_MANIFEST.contributes.targetedPluginContributions[0];
    expect(Object.keys(contribution?.operations ?? {}).sort())
      .toEqual(['get', 'listInstances', 'scan']);
  });

  it('declares the deployment field as a configured service base, not a bare origin', () => {
    // Every Azure DevOps REST path lives beneath an organization (Services) or collection (Server)
    // path segment, so the origin semantic — which the host normalizer rejects any path on — could
    // never carry the one routing fact this source needs.
    const descriptor = PLUGIN_MANIFEST.contributes.connectedAccountDescriptors[0];
    const mode = descriptor?.authentication.modes[0];
    const configuration = mode && 'configuration' in mode ? mode.configuration : undefined;

    expect(configuration?.scope).toBe('account');
    expect(configuration?.fields).toEqual([expect.objectContaining({
      id: AZURE_DEVOPS_BASE_CONFIGURATION_FIELD,
      semantic: 'connectedAccountBase',
      required: true,
    })]);
    expect(configuration?.fields[0]).not.toHaveProperty('originByValue');
  });

  it('declares one pull-request kind and no Azure Boards work-item kind', () => {
    const descriptor = TriageSourceDescriptorV1Schema.parse(AZURE_DEVOPS_TRIAGE_DESCRIPTOR);

    expect(descriptor.kinds.map((kind) => kind.id)).toEqual(['pull-request']);
    expect(descriptor.kinds[0]?.workflowSubject).toBe('pullRequest');
    expect(descriptor.purpose).toBe(AZURE_DEVOPS_TRIAGE_PURPOSE);
    // §6.3: Azure Boards is a separate product domain, and `WorkItem*` is a forbidden prefix here.
    const declared = JSON.stringify(PLUGIN_MANIFEST.contributes.targetedPluginContributions);
    expect(declared).not.toContain('issue');
    expect(declared).not.toContain('WorkItem');
  });

  it('binds each role Action to the exact published schemas and both read grants', () => {
    const contribution = PLUGIN_MANIFEST.contributes.targetedPluginContributions[0];
    const actions = new Map(PLUGIN_MANIFEST.contributes.actions.map((action) => [action.id, action]));

    expect(contribution?.target).toEqual({
      pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
      pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
    });
    expect(contribution?.protocol).toEqual({ id: 'happier.triage/sources', version: 1 });
    expect(Object.values(contribution?.operations ?? {}).sort())
      .toEqual([...Object.values(AZURE_DEVOPS_TRIAGE_ACTION_IDS)].sort());
    for (const actionId of Object.values(contribution?.operations ?? {})) {
      const action = actions.get(actionId);
      expect(action?.surfaces).toEqual(['plugin']);
      expect(action?.dangerLevel).toBe('safe');
      expect(action?.hostAccess)
        .toEqual([AZURE_DEVOPS_NETWORK_HOST_ACCESS_ID, AZURE_DEVOPS_TRIAGE_PURPOSE]);
    }
    // §3.1: both account-reaching roles carry the exact account path, so both declare the purpose
    // binding the host cross-checks at declaration time. `listInstances` produces account refs
    // rather than consuming one, so it has no account input leaf to bind.
    const expectedAccountBindings = [{
      path: 'instance.binding.account',
      purpose: AZURE_DEVOPS_TRIAGE_PURPOSE,
    }];
    expect(actions.get(AZURE_DEVOPS_TRIAGE_ACTION_IDS.get)?.connectedAccountPurposeBindings)
      .toEqual(expectedAccountBindings);
    expect(actions.get(AZURE_DEVOPS_TRIAGE_ACTION_IDS.scan)?.connectedAccountPurposeBindings)
      .toEqual(expectedAccountBindings);
    expect(actions.get(AZURE_DEVOPS_TRIAGE_ACTION_IDS.listInstances))
      .not.toHaveProperty('connectedAccountPurposeBindings');
  });

  it('binds the scan account leaf under a declaration that can actually fail', () => {
    const actions = new Map(PLUGIN_MANIFEST.contributes.actions.map((action) => [action.id, action]));
    const scan = actions.get(AZURE_DEVOPS_TRIAGE_ACTION_IDS.scan);
    const get = actions.get(AZURE_DEVOPS_TRIAGE_ACTION_IDS.get);
    const listInstances = actions.get(AZURE_DEVOPS_TRIAGE_ACTION_IDS.listInstances);
    if (!scan || !get || !listInstances) {
      throw new Error('The three Triage reads must be declared before their bindings can be judged.');
    }

    // `scan`'s published input is a two-arm union, and the declaration is accepted only because
    // both arms carry the same exact credential-ref leaf at the bound path.
    expect(() => PluginActionContributionV2Schema.parse(scan)).not.toThrow();

    // A binding that cannot fail proves nothing. The same declaration is re-checked against a
    // union whose second arm — `listInstances`' own published input — never reaches the bound
    // path; only arm coverage differs from the accepted declaration.
    expect(() => PluginActionContributionV2Schema.parse({
      ...scan,
      inputSchema: { anyOf: [get.inputSchema, listInstances.inputSchema] },
    })).toThrow(
      'Connected Account purpose bindings must target one exact qualified credential-ref input leaf in every declared input arm.',
    );

    // And a leaf only the initial-page arm declares is rejected for the same reason.
    expect(() => PluginActionContributionV2Schema.parse({
      ...scan,
      connectedAccountPurposeBindings: [
        { path: 'page.limit', purpose: AZURE_DEVOPS_TRIAGE_PURPOSE },
      ],
    })).toThrow(
      'Connected Account purpose bindings must target one exact qualified credential-ref input leaf in every declared input arm.',
    );
  });

  it('binds the declared detail surface to a renderer this plugin actually declares', () => {
    const contribution = PLUGIN_MANIFEST.contributes.targetedPluginContributions[0];

    expect(JSON.stringify(contribution?.surfaces)).toContain(AZURE_DEVOPS_TRIAGE_DETAIL_RENDERER_ID);
    expect(PLUGIN_MANIFEST.contributes.ui.renderers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: AZURE_DEVOPS_TRIAGE_DETAIL_RENDERER_ID,
        kind: 'reactNative',
        artifact: AZURE_DEVOPS_TRIAGE_DETAIL_ARTIFACT_ID,
      }),
    ]));
  });
});
