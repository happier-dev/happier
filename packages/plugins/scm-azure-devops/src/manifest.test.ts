import { ingestPluginManifestV2 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';
import {
  AZURE_DEVOPS_ACCOUNT_NETWORK_HOST_ACCESS_ID,
  AZURE_DEVOPS_CONNECTED_ACCOUNT_ID,
  AZURE_DEVOPS_NETWORK_HOST_ACCESS_ID,
  AZURE_DEVOPS_TRIAGE_PURPOSE,
} from './triage/descriptor.js';
import { AZURE_DEVOPS_TRIAGE_MUTATION_ACTION_IDS } from './triage/mutationActions.js';

describe('Azure DevOps network authority', () => {
  it('grants exactly the verbs its declared Actions consume, and no others', () => {
    const network = PLUGIN_MANIFEST.hostAccess.required.filter((entry): entry is Extract<
      (typeof PLUGIN_MANIFEST.hostAccess.required)[number],
      { capability: 'network' }
    > => entry.capability === 'network');

    expect(network.map((entry) => entry.id)).toEqual([
      AZURE_DEVOPS_NETWORK_HOST_ACCESS_ID,
      AZURE_DEVOPS_ACCOUNT_NETWORK_HOST_ACCESS_ID,
    ]);

    // `GET` serves every read and every confirming re-read. `PATCH` serves the three writes Azure
    // expresses as an update of an existing resource — complete, abandon and reactivate on the
    // pull request itself, plus a thread's status — and `POST` serves exactly one: the documented
    // bulk additive reviewer route `request-review` uses. The host revalidates origin AND method
    // at dispatch, so without a verb its Action is rejected before reaching Azure and no unit test
    // below this line could see it. `DELETE` stays absent: no declared Action removes anything —
    // `request-review` never removes a reviewer — and a granted verb nothing exercises is
    // authority the user approved for nothing.
    expect(network.find((entry) => entry.id === AZURE_DEVOPS_NETWORK_HOST_ACCESS_ID)?.scope)
      .toMatchObject({
        targets: [{ kind: 'scmProviderOrigin', provider: 'azure-devops' }],
        methods: ['GET', 'PATCH', 'POST'],
      });
    expect(network.find((entry) => entry.id === AZURE_DEVOPS_ACCOUNT_NETWORK_HOST_ACCESS_ID)?.scope)
      .toMatchObject({
        targets: [{ kind: 'connectedAccountOrigin', service: AZURE_DEVOPS_CONNECTED_ACCOUNT_ID }],
        methods: ['GET', 'PATCH', 'POST'],
        privateNetwork: true,
      });
  });

  it('allows private reach only for the exact configured account origin', () => {
    const network = PLUGIN_MANIFEST.hostAccess.required.filter((entry): entry is Extract<
      (typeof PLUGIN_MANIFEST.hostAccess.required)[number],
      { capability: 'network' }
    > => entry.capability === 'network');
    const byId = new Map(network.map((entry) => [entry.id, entry]));

    // `privateNetwork` is scope-level. Keeping it on the grant that also names the fixed SCM
    // provider origin would let a private DNS answer for a public Azure cloud origin through the
    // same scope. The account grant is the only scope that may admit a private Server origin.
    expect(byId.get(AZURE_DEVOPS_ACCOUNT_NETWORK_HOST_ACCESS_ID)?.scope.privateNetwork).toBe(true);
    expect(byId.get(AZURE_DEVOPS_NETWORK_HOST_ACCESS_ID)?.scope.privateNetwork).not.toBe(true);
    for (const entry of network) {
      if (entry.scope.privateNetwork !== true) continue;
      expect(entry.scope.targets.filter((target) => target.kind === 'scmProviderOrigin')).toEqual([]);
    }
  });

  it('remains an ingestible manifest with that authority', () => {
    expect(ingestPluginManifestV2(PLUGIN_MANIFEST)).toMatchObject({ ok: true });
  });
});

describe('Azure DevOps pull-request write declarations', () => {
  const declarations = Object.values(AZURE_DEVOPS_TRIAGE_MUTATION_ACTION_IDS).map((id) => {
    const declaration = PLUGIN_MANIFEST.contributes.actions.find((action) => action.id === id);
    if (declaration === undefined) throw new Error(`${id} must be declared in the manifest`);
    return declaration;
  });

  it('keeps every write unreachable from any agent surface and behind a host confirmation', () => {
    for (const declaration of declarations) {
      // The human gate is reachability, not a prompt. A `danger` level plus an agent surface would
      // only floor an agent invocation to an approval prompt; omitting the surface means there is
      // no tool, no prompt and no exposure at all.
      expect(declaration.surfaces).toContain('ui');
      // `plugin` is REACHABILITY, and its absence is silent: a mounted plugin
      // surface always dispatches as a plugin caller, so `executeContributedAction`
      // resolves `actionSurface` to `plugin` and refuses anything that does not
      // declare it. Without this line the whole write is dead on arrival with a
      // green suite — removing `plugin` was verified to pass every other test.
      expect(declaration.surfaces).toContain('plugin');
      expect(declaration.surfaces).not.toContain('agent');
      expect(declaration.surfaces).not.toContain('mcp');
      expect(declaration.surfaces).not.toContain('cli');
      expect(declaration.dangerLevel).not.toBe('safe');
      expect(declaration.confirmation?.title).toBeTypeOf('string');
    }
  });

  it('binds every write to the network grant and to the exact configured account', () => {
    for (const declaration of declarations) {
      expect(declaration.hostAccess).toContain(AZURE_DEVOPS_NETWORK_HOST_ACCESS_ID);
      expect(declaration.hostAccess).toContain(AZURE_DEVOPS_ACCOUNT_NETWORK_HOST_ACCESS_ID);
      expect(declaration.connectedAccountPurposeBindings)
        .toEqual([{ path: 'instance.binding.account', purpose: AZURE_DEVOPS_TRIAGE_PURPOSE }]);
    }
  });
});
