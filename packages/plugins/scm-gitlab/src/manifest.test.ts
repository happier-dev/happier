import { assertTriageSourceContributionV1 } from '@happier-dev/triage-protocol/testing/v1';
import { ingestPluginManifestV2 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';
import {
  GITLAB_CONNECTED_ACCOUNT_ID,
  GITLAB_CONNECTED_ACCOUNT_PURPOSE,
  GITLAB_NETWORK_HOST_ACCESS_ID,
  GITLAB_TRIAGE_ACTION_IDS,
  GITLAB_TRIAGE_DETAIL_ACTION_IDS,
  GITLAB_TRIAGE_DETAIL_RENDERER_ID,
  GITLAB_TRIAGE_MUTATION_ACTION_IDS,
} from './triage/contribution.js';
import { GITLAB_ADDITIONAL_UI_TRANSLATIONS } from './ui/additionalTranslations.js';

const INSTANCE_ACCOUNT_BINDING = {
  path: 'instance.binding.account',
  purpose: GITLAB_CONNECTED_ACCOUNT_PURPOSE,
};

/** The published manifest with only the `scan` Action's binding substituted. */
function withScanBinding(binding: Readonly<{ path: string; purpose: string }>): unknown {
  return {
    ...PLUGIN_MANIFEST,
    contributes: {
      ...PLUGIN_MANIFEST.contributes,
      actions: PLUGIN_MANIFEST.contributes.actions.map((action) => (
        action.id === GITLAB_TRIAGE_ACTION_IDS.scan
          ? { ...action, connectedAccountPurposeBindings: [binding] }
          : action
      )),
    },
  };
}

describe('GitLab plugin manifest', () => {
  it('declares one conforming Triage source contribution with GitLab vocabulary', () => {
    expect(() => assertTriageSourceContributionV1(PLUGIN_MANIFEST)).not.toThrow();

    const [contribution] = PLUGIN_MANIFEST.contributes.targetedPluginContributions;
    expect(contribution?.descriptor.kinds.map((kind) => kind.id))
      .toEqual(['merge-request', 'issue']);
    // Flattening GitLab's word into GitHub's is the first step toward flattening
    // the rest of its vocabulary.
    expect(JSON.stringify(contribution?.descriptor)).not.toContain('pull-request');
    expect(contribution?.surfaces.detail.renderer).toBe(GITLAB_TRIAGE_DETAIL_RENDERER_ID);
    expect(PLUGIN_MANIFEST.contributes.ui.renderers.map(({ id }) => id))
      .toContain(GITLAB_TRIAGE_DETAIL_RENDERER_ID);
  });

  it('remains an ingestible manifest that still declares the incumbent hosting provider', () => {
    expect(ingestPluginManifestV2(PLUGIN_MANIFEST)).toMatchObject({ ok: true });
    expect(PLUGIN_MANIFEST.contributes.scmHostingProviders.map(({ id }) => id)).toEqual(['gitlab']);
    // The `authService` cut that rebinds the existing `glab` CLI pull-request
    // path is the forge-activation unit's atomic change, not this one's.
    expect(PLUGIN_MANIFEST.contributes.scmHostingProviders[0])
      .not.toHaveProperty('authService');
  });

  it('authorizes exact account materialization and never a caller-chosen selection', () => {
    expect(PLUGIN_MANIFEST.hostAccess.required).toEqual(expect.arrayContaining([{
      id: GITLAB_CONNECTED_ACCOUNT_PURPOSE,
      capability: 'connectedAccounts',
      reason: expect.any(String),
      scope: {
        serviceRefs: [GITLAB_CONNECTED_ACCOUNT_ID],
        operations: ['use'],
        materializationKinds: ['httpHeaders'],
      },
    }]));

    const actions = new Map(PLUGIN_MANIFEST.contributes.actions.map((action) => [action.id, action]));
    for (const id of Object.values(GITLAB_TRIAGE_ACTION_IDS)) {
      expect(actions.get(id)?.hostAccess)
        .toEqual(['gitlab-api', GITLAB_CONNECTED_ACCOUNT_PURPOSE]);
    }
    expect(actions.get(GITLAB_TRIAGE_ACTION_IDS.get)?.connectedAccountPurposeBindings)
      .toEqual([INSTANCE_ACCOUNT_BINDING]);
  });

  it('declares each source-native detail plane as a plugin-surfaced account-bound read', () => {
    const actions = new Map(PLUGIN_MANIFEST.contributes.actions.map((action) => [action.id, action]));

    for (const id of Object.values(GITLAB_TRIAGE_DETAIL_ACTION_IDS)) {
      const action = actions.get(id);
      // Declared at all: a mounted detail body invoking an undeclared Action is
      // refused by the host, and the panel would report a contract break the user
      // cannot act on.
      expect(action, `${id} must be declared`).toBeDefined();
      // `plugin` only: these are this source's own reads, not a surface the
      // aggregate or another plugin may call.
      expect(action?.surfaces).toEqual(['plugin']);
      expect(action?.dangerLevel).toBe('safe');
      expect(action?.hostAccess).toEqual(['gitlab-api', GITLAB_CONNECTED_ACCOUNT_PURPOSE]);
      // Every detail plane carries a configured instance, so every one binds the
      // exact account leaf the host revalidates.
      expect(action?.connectedAccountPurposeBindings).toEqual([INSTANCE_ACCOUNT_BINDING]);
    }
    // They are NOT source-protocol roles. The contribution binds exactly three
    // operations, and adding a fourth would publish GitLab vocabulary into a
    // shared contract that has no such role.
    const contribution = PLUGIN_MANIFEST.contributes.targetedPluginContributions[0];
    expect(Object.keys(contribution?.operations ?? {}).sort())
      .toEqual(['get', 'listInstances', 'scan']);
  });

  it('binds the configured-instance account leaf on every read, including the union-shaped scan', () => {
    const actions = new Map(PLUGIN_MANIFEST.contributes.actions.map((action) => [action.id, action]));
    // `scan` publishes a two-arm union input. Both arms carry the same configured
    // instance, so the leaf is proven for every representable input and the host
    // binds and revalidates it exactly as it does for the single-arm `get`.
    expect(actions.get(GITLAB_TRIAGE_ACTION_IDS.scan)?.connectedAccountPurposeBindings)
      .toEqual([INSTANCE_ACCOUNT_BINDING]);
    // `listInstances` reaches no account: producing account references is what it
    // performs. Its published input has no position a binding could name.
    expect(actions.get(GITLAB_TRIAGE_ACTION_IDS.listInstances))
      .not.toHaveProperty('connectedAccountPurposeBindings');
  });

  it.each([
    // A real leaf that is not a qualified credential ref.
    'instance.binding',
    // A leaf only one union arm can reach, so it proves nothing about the other.
    'page.limit',
  ])('refuses admission when the scan binding names %s instead of a credential-ref leaf', (path) => {
    const rejected = ingestPluginManifestV2(withScanBinding({
      path,
      purpose: GITLAB_CONNECTED_ACCOUNT_PURPOSE,
    }));

    expect(rejected).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([expect.objectContaining({
        code: 'plugin_manifest_invalid',
        message: 'Connected Account purpose bindings must target one exact qualified'
          + ' credential-ref input leaf in every declared input arm.',
      })]),
    });
    // The same substitution with the real leaf is admitted, so the rejection is the
    // path being wrong rather than the substitution itself being malformed.
    expect(ingestPluginManifestV2(withScanBinding(INSTANCE_ACCOUNT_BINDING)))
      .toMatchObject({ ok: true });
  });

  it('carries no credential, token or composer surface in its declaration', () => {
    const declaration = JSON.stringify(PLUGIN_MANIFEST);
    expect(declaration).not.toContain('glpat-');
    expect(declaration).not.toContain('composerReferences');
    expect(declaration).not.toContain('composerControls');
  });
});

describe('GitLab network authority', () => {
  it('grants exactly the verbs the declared Actions consume, in the one existing scope', () => {
    const network = PLUGIN_MANIFEST.hostAccess.required
      .filter((entry) => entry.capability === 'network');

    // One scope, widened in place. A second network grant, or an
    // Action-specific bypass, would be a second authority over the same origin.
    expect(network.map(({ id }) => id)).toEqual([GITLAB_NETWORK_HOST_ACCESS_ID]);
    // `PUT` is the merge and the close transition, `POST` the GraphQL draft
    // transition, `GET` every read. The host revalidates the origin AND the
    // method at dispatch, so a write missing here is refused before it reaches
    // GitLab — and no unit test would see it.
    expect(network[0]?.scope).toMatchObject({ methods: ['GET', 'POST', 'PUT'] });
    // A verb with no declaring Action is not granted for symmetry: nothing in
    // this plugin deletes or patches over the host network.
    const methods = (network[0]?.scope as { methods?: readonly string[] }).methods ?? [];
    expect(methods).not.toContain('DELETE');
    expect(methods).not.toContain('PATCH');
  });
});

describe('GitLab merge-request mutation Actions', () => {
  const actions = new Map(PLUGIN_MANIFEST.contributes.actions.map((action) => [action.id, action]));

  it('declares each write with the danger level and confirmation its effect earns', () => {
    // Row-for-row with the forge mutation contract: merge is irreversible on the
    // forge, mark-ready's reviewer notification fan-out IS the write, and close
    // is an ordinary remote write.
    const expected = [
      [GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestMerge, 'destructive'],
      [GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestMarkReady, 'externalSideEffect'],
      [GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestClose, 'writesRemote'],
    ] as const;

    for (const [id, dangerLevel] of expected) {
      const action = actions.get(id);
      expect(action, `${id} must be declared`).toBeDefined();
      expect(action?.dangerLevel).toBe(dangerLevel);
      // The manifest grammar refuses a non-safe human-surfaced Action without
      // it, and the copy is per Action because the fact worth confirming is.
      expect(action?.confirmation?.title).toBeDefined();
      expect(action?.hostAccess)
        .toEqual([GITLAB_NETWORK_HOST_ACCESS_ID, GITLAB_CONNECTED_ACCOUNT_PURPOSE]);
      expect(action?.connectedAccountPurposeBindings).toEqual([INSTANCE_ACCOUNT_BINDING]);
    }
  });

  it('never exposes a forge mutation on agent or mcp', () => {
    const ids = Object.values(GITLAB_TRIAGE_MUTATION_ACTION_IDS);
    // Enumerated, not sampled. The OMISSIONS are the gate: with no `agent` and no
    // `mcp` surface the Action is not agent-reachable at all, where a danger level
    // plus `agent: true` would only floor it to a prompt.
    //
    // Asserted as omissions rather than as an exact array. The exact-array form
    // this replaces read as the stricter check and was in fact the weaker one: it
    // pinned `['ui']`, and `['ui']` alone makes these writes reachable by NOBODY.
    // The only thing that renders them is this source's own mounted detail
    // artifact, which dispatches as a `plugin` caller, so the host's
    // `evaluateTargetActionPolicy` refused every press with
    // `plugin_action_surface_unavailable` before the handler ran. `plugin` is
    // therefore required, and it grants an agent nothing.
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const surfaces = actions.get(id)?.surfaces;
      expect(surfaces, id).toContain('ui');
      expect(surfaces, id).toContain('plugin');
      expect(surfaces, id).not.toContain('agent');
      expect(surfaces, id).not.toContain('mcp');
      expect(surfaces, id).not.toContain('cli');
      expect(surfaces, id).not.toContain('voice');
    }
  });

  it('resolves every confirmation key in every locale the plugin ships', () => {
    const locales = PLUGIN_MANIFEST.contributes.ui.translations.map(({ locale }) => locale);
    expect(locales.length).toBeGreaterThan(1);

    const keys = Object.values(GITLAB_TRIAGE_MUTATION_ACTION_IDS).flatMap((id) => {
      const confirmation = actions.get(id)?.confirmation;
      return [confirmation?.title, confirmation?.body, confirmation?.confirmLabel]
        .filter((value): value is { key: string; fallback: string } =>
          typeof value === 'object' && value !== null && 'key' in value)
        .map(({ key }) => key);
    });
    expect(keys).toHaveLength(9);

    for (const locale of locales) {
      const messages = GITLAB_ADDITIONAL_UI_TRANSLATIONS[
        locale as keyof typeof GITLAB_ADDITIONAL_UI_TRANSLATIONS
      ];
      for (const key of keys) {
        // A referenced-but-undefined key renders the fallback in one language
        // for everybody, which is the silent half of a missing translation.
        expect(messages?.[key as keyof typeof messages], `${locale}/${key}`).toBeTruthy();
      }
    }
  });
});
