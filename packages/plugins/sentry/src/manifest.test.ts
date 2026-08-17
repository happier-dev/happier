import { readFile } from 'node:fs/promises';

import { definePlugin } from '@happier-dev/plugin-sdk';
import { TriageSourcesContributionProtocolV1 } from '@happier-dev/triage-protocol/v1';
import { assertTriageSourceContributionV1 } from '@happier-dev/triage-protocol/testing/v1';
import { describe, expect, it } from 'vitest';

import {
  SENTRY_ACCOUNT_NETWORK_HOST_ACCESS_ID,
  SENTRY_CLOUD_NETWORK_HOST_ACCESS_ID,
  SENTRY_CLOUD_REGION_ORIGINS,
  SENTRY_CONNECTED_ACCOUNT_ID,
  SENTRY_CONNECTED_ACCOUNT_PURPOSE,
} from './sentryContracts.js';

import {
  PLUGIN_MANIFEST,
  SENTRY_ACTION_IDS,
  SENTRY_DETAIL_FALLBACK_RENDERER_ID,
  SENTRY_DETAIL_RENDERER_ID,
} from './manifest.js';

type SentryNetworkGrant = Extract<
  (typeof PLUGIN_MANIFEST)['hostAccess']['required'][number],
  { capability: 'network' }
>;

describe('Sentry plugin manifest', () => {
  it('publishes the manifest subpath consumed by the bundled-plugin registry', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as Readonly<{ exports: Readonly<Record<string, unknown>> }>;

    expect(packageJson.exports['./manifest']).toEqual({
      types: './dist/manifest.d.ts',
      default: './dist/manifest.js',
    });
  });

  it('does not declare Protocol as a direct package dependency', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as Readonly<{ dependencies: Readonly<Record<string, string>> }>;

    expect(packageJson.dependencies['@happier-dev/protocol']).toBeUndefined();
  });

  it('declares one conforming Triage source contribution bound to its own renderer', () => {
    expect(() => assertTriageSourceContributionV1(PLUGIN_MANIFEST)).not.toThrow();

    const [contribution] = PLUGIN_MANIFEST.contributes.targetedPluginContributions;
    expect(contribution?.target).toEqual({ pluginId: 'happier.triage', pointId: 'sources' });
    expect(contribution?.operations).toEqual({
      listInstances: SENTRY_ACTION_IDS.listInstances,
      scan: SENTRY_ACTION_IDS.scan,
      get: SENTRY_ACTION_IDS.get,
    });
    expect(contribution?.surfaces).toEqual({
      detail: {
        renderer: SENTRY_DETAIL_RENDERER_ID,
        fallbackRenderers: [SENTRY_DETAIL_FALLBACK_RENDERER_ID],
      },
    });
  });

  it('contributes no Composer surface and no review-workspace role', () => {
    const contributes = PLUGIN_MANIFEST.contributes as Readonly<Record<string, unknown>>;
    for (const family of ['composerReferences', 'composerAttachments', 'composerControls']) {
      expect(contributes[family] ?? []).toEqual([]);
    }
    const [contribution] = PLUGIN_MANIFEST.contributes.targetedPluginContributions;
    // `prepareReviewWorkspace` is the optional pull-request role. An error
    // group has no branch to materialize, so it is deliberately unbound.
    expect(contribution?.operations).not.toHaveProperty('prepareReviewWorkspace');
  });

  it('admits both Cloud deployments and the account origin for read-only requests', () => {
    expect(PLUGIN_MANIFEST.hostAccess.required).toEqual(expect.arrayContaining([{
      id: SENTRY_CLOUD_NETWORK_HOST_ACCESS_ID,
      capability: 'network',
      reason: expect.any(String),
      scope: {
        targets: [
          { kind: 'fixedOrigin', origin: SENTRY_CLOUD_REGION_ORIGINS.us },
          { kind: 'fixedOrigin', origin: SENTRY_CLOUD_REGION_ORIGINS.de },
        ],
        methods: ['GET'],
      },
    }, {
      id: SENTRY_ACCOUNT_NETWORK_HOST_ACCESS_ID,
      capability: 'network',
      reason: expect.any(String),
      scope: {
        targets: [{ kind: 'connectedAccountOrigin', service: SENTRY_CONNECTED_ACCOUNT_ID }],
        methods: ['GET'],
        privateNetwork: true,
      },
    }, {
      id: SENTRY_CONNECTED_ACCOUNT_PURPOSE,
      capability: 'connectedAccounts',
      reason: expect.any(String),
      scope: {
        serviceRefs: [SENTRY_CONNECTED_ACCOUNT_ID],
        operations: ['use'],
        materializationKinds: ['httpHeaders'],
      },
    }]));
  });

  it('grants private-network reach to the configured account origin and to nothing else', () => {
    const network = PLUGIN_MANIFEST.hostAccess.required.filter(
      (request): request is SentryNetworkGrant => request.capability === 'network',
    );
    expect(network.map((request) => request.id)).toEqual([
      SENTRY_CLOUD_NETWORK_HOST_ACCESS_ID,
      SENTRY_ACCOUNT_NETWORK_HOST_ACCESS_ID,
    ]);
    const byId = new Map(network.map((request) => [request.id, request]));

    // A self-hosted Sentry may live on a private network, so the grant holding
    // only the host-published account origin declares it...
    expect(byId.get(SENTRY_ACCOUNT_NETWORK_HOST_ACCESS_ID)?.scope.privateNetwork).toBe(true);
    // ...and the grant holding the two Cloud origins must not. Declaring the
    // flag on a scope that also carries a fixed public origin is the DNS
    // rebinding case the flag exists to prevent, and is precisely what a
    // one-line fix to the previously single grant would have produced.
    expect(byId.get(SENTRY_CLOUD_NETWORK_HOST_ACCESS_ID)?.scope.privateNetwork).not.toBe(true);

    // The same invariant stated independently of the two ids, so a later grant
    // cannot reintroduce the pairing under a different name.
    for (const request of network) {
      if (request.scope.privateNetwork !== true) continue;
      expect(request.scope.targets.filter((target) => target.kind === 'fixedOrigin')).toEqual([]);
    }

    // Neither split widened anything else: both remain read-only, and the two
    // documented Cloud deployments stay exactly as reachable as before.
    expect(network.flatMap((request) => request.scope.methods ?? [])).toEqual(['GET', 'GET']);
    expect(network.flatMap((request) => request.scope.targets)).toEqual([
      { kind: 'fixedOrigin', origin: SENTRY_CLOUD_REGION_ORIGINS.us },
      { kind: 'fixedOrigin', origin: SENTRY_CLOUD_REGION_ORIGINS.de },
      { kind: 'connectedAccountOrigin', service: SENTRY_CONNECTED_ACCOUNT_ID },
    ]);
  });

  it('binds every read Action to the exact account and both grants', () => {
    const actions = new Map(PLUGIN_MANIFEST.contributes.actions.map((action) => [
      action.id,
      action,
    ]));
    for (const id of Object.values(SENTRY_ACTION_IDS)) {
      const action = actions.get(id);
      if (action === undefined) continue;
      // Both halves of the split network grant are declared on every read: the
      // host authorizes scopes by the exact ids an Action names, so omitting
      // the account half would leave a self-hosted read with no allowed origin.
      expect(action.hostAccess).toEqual([
        SENTRY_CONNECTED_ACCOUNT_PURPOSE,
        SENTRY_CLOUD_NETWORK_HOST_ACCESS_ID,
        SENTRY_ACCOUNT_NETWORK_HOST_ACCESS_ID,
      ]);
      expect(action.dangerLevel).toBe('safe');
    }
    // Every Action that receives an account declares where that account is,
    // including `scan`: the canonical Action parser now walks a union-shaped
    // input, so the published two-arm scan input is addressable at the exact
    // path both arms carry.
    for (const id of [
      SENTRY_ACTION_IDS.get,
      SENTRY_ACTION_IDS.scan,
      SENTRY_ACTION_IDS.readIssue,
      SENTRY_ACTION_IDS.listIssueEvents,
      SENTRY_ACTION_IDS.listTagValues,
    ]) {
      expect(actions.get(id)?.connectedAccountPurposeBindings).toEqual([{
        path: 'instance.binding.account',
        purpose: SENTRY_CONNECTED_ACCOUNT_PURPOSE,
      }]);
    }
    // Discovery produces account references rather than receiving one.
    expect(actions.get(SENTRY_ACTION_IDS.listInstances)?.connectedAccountPurposeBindings)
      .toBeUndefined();
  });

  it('has its scan purpose binding enforced, not merely tolerated', () => {
    const sources = TriageSourcesContributionProtocolV1;
    const declare = (path: string): unknown => definePlugin({
      id: 'happier.sentry',
      version: '0.0.0',
      displayName: 'Sentry',
      description: 'Declaration-time check of the union-input purpose binding.',
      engines: { happier: '^0.0.0' },
      runtime: { apiVersion: 1 },
      entrypoints: { daemon: './dist/index.js' },
      hostAccess: { required: [], optional: [] },
      actions: {
        [SENTRY_ACTION_IDS.scan]: {
          title: 'Scan Sentry issues',
          description: 'Reads one page of the configured Sentry organization issue walk.',
          scopes: ['global'],
          surfaces: sources.operations.scan.declaration.surfaces,
          dangerLevel: sources.operations.scan.declaration.dangerLevel,
          inputSchema: sources.operations.scan.declaration.input.schema.jsonSchema,
          resultSchema: sources.operations.scan.declaration.resultSchema.jsonSchema,
          connectedAccountPurposeBindings: [{
            path,
            purpose: SENTRY_CONNECTED_ACCOUNT_PURPOSE,
          }],
          run: async () => ({ kind: 'failed', failure: { class: 'unknown', code: 'x' } }),
        },
      },
    });

    // The published scan input is a two-arm union. The account path both arms
    // carry is accepted...
    expect(() => declare('instance.binding.account')).not.toThrow();
    // ...and a path that is not an exact credential ref in every arm is
    // refused, which is what makes the accepted declaration meaningful rather
    // than a field the parser walked past.
    expect(() => declare('page.continuation.token')).toThrow(
      /Connected Account purpose bindings/u,
    );
  });

  it('declares the four source-native detail reads the detail body invokes', () => {
    const actions = new Map(PLUGIN_MANIFEST.contributes.actions.map((action) => [
      action.id,
      action,
    ]));
    for (const id of [
      SENTRY_ACTION_IDS.readIssue,
      SENTRY_ACTION_IDS.listIssueEvents,
      SENTRY_ACTION_IDS.readEvent,
      SENTRY_ACTION_IDS.listTagValues,
    ]) {
      const action = actions.get(id);
      expect(action?.surfaces).toEqual(['plugin']);
      expect(action?.inputSchema).toBeDefined();
      expect(action?.resultSchema).toBeDefined();
      // Every detail read reaches the provider through the exact selected
      // account, so each declares both grants and the binding that names it.
      expect(action?.connectedAccountPurposeBindings)
        .toEqual([{ path: 'instance.binding.account', purpose: 'sentry-account-use' }]);
    }
  });

  it('declares the exact deployment as host-owned Connected Account origin configuration', () => {
    const descriptor = PLUGIN_MANIFEST.contributes.connectedAccountDescriptors
      ?.find((entry) => entry.id === SENTRY_CONNECTED_ACCOUNT_ID);
    const modes = new Map((descriptor?.authentication.modes ?? []).map((mode) => [mode.id, mode]));
    expect([...modes.keys()]).toEqual(['auth-token', 'self-hosted-auth-token']);
    for (const mode of modes.values()) {
      expect(mode.configuration?.scope).toBe('account');
      expect(mode.configuration?.changeBehavior).toBe('reconnect');
    }

    // Cloud is a closed named choice, never a typed URL: the user picks a region
    // and the descriptor — not this source, and not a response — declares the
    // exactly one origin that choice routes to.
    expect(modes.get('auth-token')?.configuration?.fields).toEqual([expect.objectContaining({
      id: 'region',
      semantic: 'connectedAccountFixedOrigin',
      schema: expect.objectContaining({ type: 'string', enum: ['us', 'de'] }),
      originByValue: {
        us: SENTRY_CLOUD_REGION_ORIGINS.us,
        de: SENTRY_CLOUD_REGION_ORIGINS.de,
      },
      required: true,
      secret: false,
    })]);

    // A self-hosted deployment has no closed choice set, so it stays the exact
    // configured origin the host normalizes and republishes.
    expect(modes.get('self-hosted-auth-token')?.configuration?.fields)
      .toEqual([expect.objectContaining({
        id: 'origin',
        semantic: 'connectedAccountOrigin',
        required: true,
        secret: false,
      })]);
    // The bearer credential is the only secret, and it is never configuration.
    expect(JSON.stringify(descriptor)).not.toContain('Bearer');
  });

  it('binds the detail surface to a declarative fallback beside the native renderer', () => {
    const renderers = new Map(
      (PLUGIN_MANIFEST.contributes.ui?.renderers ?? []).map((renderer) => [renderer.id, renderer]),
    );
    expect(renderers.get(SENTRY_DETAIL_RENDERER_ID)?.kind).toBe('reactNative');

    // A host that cannot mount the React Native artifact must still see a
    // truthful region rather than an empty one.
    const fallback = renderers.get(SENTRY_DETAIL_FALLBACK_RENDERER_ID);
    expect(fallback?.kind).toBe('declarative');
    expect(JSON.stringify(fallback)).toContain('plugins.sentry.detail.fallback.body');

    const [contribution] = PLUGIN_MANIFEST.contributes.targetedPluginContributions;
    expect(contribution?.surfaces).toEqual({
      detail: {
        renderer: SENTRY_DETAIL_RENDERER_ID,
        fallbackRenderers: [SENTRY_DETAIL_FALLBACK_RENDERER_ID],
      },
    });
  });
});
