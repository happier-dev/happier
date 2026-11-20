import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { TriageGetResultV1Schema, TriageScanResultV1Schema } from '@happier-dev/triage-protocol/v1';
import { TriageListInstancesResultV1Schema, TriageSourceCredentialInputsV1 } from '@happier-dev/triage-protocol/v1';
import { GITHUB_PLUGIN } from '../manifest.js';
import { activate as activateAccountArtifact } from '../accountRuntime.js';
import { GITHUB_CONNECTED_ACCOUNT_PURPOSE, GITHUB_PLUGIN_ID } from '../observations/githubProviderContracts.js';
import { GITHUB_TRIAGE_ACTION_IDS_V1 } from './contribution.js';
import { encodeGithubTriageConfiguration } from './configuration.js';
import { GITHUB_ACCOUNT_EXECUTION, githubNativeReadActionId } from './readActions.js';
import { GITHUB_FIXTURE_OWNER, GITHUB_FIXTURE_REPOSITORY, GITHUB_FIXTURE_REPOSITORY_ID,
  GITHUB_PULL_REQUEST_RESPONSE, GITHUB_REPOSITORY_RESPONSE, GITHUB_SEARCH_PULL_REQUEST_ITEM,
  githubSearchResponse } from './__fixtures__/githubResponses.js';
import { createStubGithubTransport, GITHUB_TEST_ACCOUNT, githubChecksBatchResponse } from './testkit/githubTriage.test-support.js';

const repository = `${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}`.toLowerCase();

describe('GitHub Account placement through contributed Action dispatch with zero Machines', () => {
  it('reads Account Session relationships through the Account Channels transport with zero Machines', async () => {
    const transport = createStubGithubTransport({ respond: () => undefined,
      // Cross-plugin Action dispatch is the host transport boundary. The
      // composed UI test separately exercises the real Channels reader.
      async executeAction(target, input) {
        expect(target).toEqual({ pluginId: 'happier.channels', localId: 'session-pull-request-relations-v1' });
        expect(input).toMatchObject({ kind: 'readRelations', credentialRef: GITHUB_TEST_ACCOUNT });
        return { kind: 'relations', links: [] };
      },
    });
    const github = await createPluginTestkit({ manifest: GITHUB_PLUGIN.manifest, module: GITHUB_PLUGIN,
      resolveCurrentPluginMaterializationRef: () => null, services: {
        actions: transport.context.services.actions, connectedAccounts: transport.context.services.connectedAccounts,
      } });
    const fixture = createTriageSourceV1Fixture().configuredInstance;
    const instance = { ...fixture,
      instance: { source: { pluginId: GITHUB_PLUGIN_ID, localId: 'github-forge' }, sourceInstanceId: fixture.instance.sourceInstanceId },
      binding: { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, account: GITHUB_TEST_ACCOUNT }, localInstanceKey: 'github.com',
      configuration: { v: 1, token: encodeGithubTriageConfiguration({ v: 1, scope: { kind: 'account' } })! } };
    try {
      expect(await github.invokeAction(GITHUB_TRIAGE_ACTION_IDS_V1.readSessionLinks, { v: 1, instance,
        localRef: { kindId: 'pull-request', collisionScope: `github:${GITHUB_FIXTURE_REPOSITORY_ID}`, entryId: '1284' } }))
        .toEqual({ kind: 'complete', links: [] });
      expect(transport.requests).toEqual([]);
      expect(transport.materializeCount()).toBe(0);
    } finally { await github.dispose(); }
  });
  it('builds the declared Account artifact with the production portable compiler', async () => {
    // The compiler is a build boundary; production handlers use public SDK ports.
    const { compileUniversalPluginUiCommonJs } = await import('../../../../plugin-sdk/src/ui/build/universalCommonJsCompiler.js');
    const { readWorkspacePackages, packageNameOfSpecifier, resolveWorkspaceSource } = await import('../../../../cli-common/sourceRuntimeEntries.mjs');
    const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
    const packages = await readWorkspacePackages(resolve(projectRoot, '../../..'));
    const artifact = await compileUniversalPluginUiCommonJs({ projectRoot,
      entryPath: resolve(projectRoot, 'src/accountRuntime.ts'), artifactId: 'github-account-runtime',
      requestedExports: ['activate'], exportConditions: ['happier-source'],
      resolveSourceImport: specifier => packages.has(packageNameOfSpecifier(specifier))
        ? resolveWorkspaceSource(packages, specifier, { conditions: ['react-native', 'browser'] }) : undefined,
    });
    expect(artifact.exports).toContain('activate');
  });
  it('retains GitHub rate parking across Account invocations without a daemon activation', async () => {
    const transport = createStubGithubTransport({ respond: () => ({ status: 429,
      headers: { 'retry-after': '60' }, body: { message: 'Too many requests' } }) });
    const github = await createPluginTestkit({ manifest: GITHUB_PLUGIN.manifest,
      // The SDK fixture requires every native registration. Retire its incidental
      // native setup immediately so it cannot supply an Account request lifetime.
      module: { async activate(api) {
        const cleanup = await GITHUB_PLUGIN.activate(api);
        if (typeof cleanup === 'function') await cleanup();
      }, activateAccount: activateAccountArtifact }, resolveCurrentPluginMaterializationRef: () => null });
    const fixture = createTriageSourceV1Fixture().configuredInstance;
    const instance = { ...fixture,
      instance: { source: { pluginId: GITHUB_PLUGIN_ID, localId: 'github-forge' }, sourceInstanceId: fixture.instance.sourceInstanceId },
      binding: { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, account: GITHUB_TEST_ACCOUNT }, localInstanceKey: 'github.com',
      configuration: { v: 1, token: encodeGithubTriageConfiguration({ v: 1, scope: { kind: 'account' } })! } };
    try {
      let firstRequestCount = 0;
      for (let invocation = 0; invocation < 2; invocation += 1) {
        // Each host invocation creates a new purpose port; its identity must not
        // reset the existing provider-directed parking state.
        const result = await github.invokeAction(GITHUB_TRIAGE_ACTION_IDS_V1.scan,
          { v: 1, instance, page: { kind: 'initial', limit: 64 } }, { services: {
            http: transport.context.services.http, connectedAccounts: { ...transport.context.services.connectedAccounts },
          } });
        expect(result).toMatchObject({ kind: 'failed', failure: { code: 'github_rate_limited' } });
        if (invocation === 0) firstRequestCount = transport.requests.length;
      }
      expect(firstRequestCount).toBeGreaterThan(0);
      expect(transport.requests).toHaveLength(firstRequestCount);
    } finally { await github.dispose(); }
  });
  it('searches and reads with the selected Account credential', async () => {
    let nativeMaterializations = 0;
    const transport = createStubGithubTransport({ respond(request) {
      const path = new URL(request.url).pathname;
      if (path === '/search/issues') return { status: 200, body: githubSearchResponse({ items: [GITHUB_SEARCH_PULL_REQUEST_ITEM] }) };
      if (path === '/graphql') return githubChecksBatchResponse(request);
      if (path === `/repositories/${GITHUB_FIXTURE_REPOSITORY_ID}`) return { status: 200, body: GITHUB_REPOSITORY_RESPONSE };
      if (path === `/repos/${repository}/pulls/1284`) return { status: 200, body: GITHUB_PULL_REQUEST_RESPONSE };
      if (path === '/user') return { status: 200, body: { login: GITHUB_FIXTURE_OWNER } };
      return undefined;
    }, listing: { status: 'complete', accounts: [{ account: GITHUB_TEST_ACCOUNT, displayName: 'Fixture', state: 'connected',
      connectedAccountOrigins: ['https://api.github.com'], connectedAccountBases: [] }] },
    nativeMaterialization() { nativeMaterializations += 1; throw new Error('Account reads must not acquire native credentials'); } });
    const github = await createPluginTestkit({ manifest: GITHUB_PLUGIN.manifest, module: GITHUB_PLUGIN,
      resolveCurrentPluginMaterializationRef: () => null,
      services: { http: transport.context.services.http, connectedAccounts: transport.context.services.connectedAccounts } });
    const callerDefinition = definePlugin({ id: 'test.github-account-caller', version: '1.0.0', actions: {
      scan: { title: 'Search', surfaces: ['plugin'], execution: GITHUB_ACCOUNT_EXECUTION, run: async (input, context) =>
        context.services.actions.execute({ pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_TRIAGE_ACTION_IDS_V1.scan }, input) },
      get: { title: 'Read', surfaces: ['plugin'], execution: GITHUB_ACCOUNT_EXECUTION, run: async (input, context) =>
        context.services.actions.execute({ pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_TRIAGE_ACTION_IDS_V1.get }, input) },
      discover: { title: 'Discover', surfaces: ['plugin'], execution: GITHUB_ACCOUNT_EXECUTION, run: async (input, context) =>
        context.services.actions.execute({ pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_TRIAGE_ACTION_IDS_V1.listInstances }, input) },
    } });
    const caller = await createPluginTestkit({ manifest: callerDefinition.manifest, module: callerDefinition,
      resolveCurrentPluginMaterializationRef: () => null, actionTargets: [github] });
    const fixture = createTriageSourceV1Fixture().configuredInstance;
    const instance = { ...fixture,
      instance: { source: { pluginId: GITHUB_PLUGIN_ID, localId: 'github-forge' }, sourceInstanceId: fixture.instance.sourceInstanceId },
      binding: { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, account: GITHUB_TEST_ACCOUNT }, localInstanceKey: 'github.com',
      configuration: { v: 1, token: encodeGithubTriageConfiguration({ v: 1, scope: { kind: 'repository', repositoryKey: repository } })! } };
    try {
      const scan = TriageScanResultV1Schema.parse(await caller.invokeAction('scan', { v: 1, instance, query: 'fix', page: { kind: 'initial', limit: 64 } }));
      expect(scan.kind).toBe('complete');
      if (scan.kind === 'failed') throw new Error(scan.failure.code);
      expect(scan.observations.some(row => row.kind === 'present' && row.localRef.entryId === '1284')).toBe(true);
      const get = TriageGetResultV1Schema.parse(await caller.invokeAction('get', { v: 1, instance,
        localRef: { kindId: 'pull-request', collisionScope: `github:${GITHUB_FIXTURE_REPOSITORY_ID}`, entryId: '1284' } }));
      expect(get.kind).toBe('present');
      const discovery = TriageListInstancesResultV1Schema.parse(await caller.invokeAction('discover', { v: 1 }));
      expect(discovery).toMatchObject({ kind: 'complete', candidates: [{ binding: { account: GITHUB_TEST_ACCOUNT } }] });
      expect(transport.materializations.every(request => request.account.accountId === GITHUB_TEST_ACCOUNT.accountId)).toBe(true);
      expect(transport.materializeCount()).toBe(3);
      expect(nativeMaterializations).toBe(0);
    } finally { await caller.dispose(); await github.dispose(); }
  });

  it('keeps a native-gh source on the daemon and returns typed machine_required', async () => {
    let relay: Awaited<ReturnType<typeof createPluginTestkit>>;
    const transport = createStubGithubTransport({ binding: null, respond: () => undefined,
      // The SDK fixture host does not index self-targets. This host-transport
      // adapter re-enters its real contributed dispatcher; it never fabricates
      // a placement failure or replaces the native handler/admission logic.
      async executeAction(target, input) {
        if (typeof target === 'string') throw new Error('Expected a contributed GitHub Action target');
        expect(target.pluginId).toBe(GITHUB_PLUGIN_ID);
        if (target.localId === githubNativeReadActionId(GITHUB_TRIAGE_ACTION_IDS_V1.listInstances)) {
          return relay.invokeAction('native-discover', TriageSourceCredentialInputsV1.listInstances.parse(input));
        }
        if (target.localId === githubNativeReadActionId(GITHUB_TRIAGE_ACTION_IDS_V1.readSessionLinks)) {
          return relay.invokeAction('native-links', TriageSourceCredentialInputsV1.readSessionLinks.parse(input));
        }
        expect(target.localId).toBe(githubNativeReadActionId(GITHUB_TRIAGE_ACTION_IDS_V1.scan));
        return relay.invokeAction('native-scan', TriageSourceCredentialInputsV1.scan.parse(input));
      },
    });
    const github = await createPluginTestkit({ manifest: GITHUB_PLUGIN.manifest, module: GITHUB_PLUGIN,
      resolveCurrentPluginMaterializationRef: () => null, services: {
        http: transport.context.services.http, connectedAccounts: transport.context.services.connectedAccounts,
        actions: transport.context.services.actions,
      } });
    const definition = definePlugin({ id: 'test.github-native-caller', version: '1.0.0', actions: {
      scan: { title: 'Search', surfaces: ['plugin'], execution: GITHUB_ACCOUNT_EXECUTION, run: async (input, context) =>
        context.services.actions.execute({ pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_TRIAGE_ACTION_IDS_V1.scan }, input) },
      'native-scan': { title: 'Native host transport', surfaces: ['plugin'], execution: GITHUB_ACCOUNT_EXECUTION, run: async (input, context) =>
        context.services.actions.execute({ pluginId: GITHUB_PLUGIN_ID, localId: githubNativeReadActionId(GITHUB_TRIAGE_ACTION_IDS_V1.scan) }, input) },
      discover: { title: 'Discover', surfaces: ['plugin'], execution: GITHUB_ACCOUNT_EXECUTION, run: async (input, context) =>
        context.services.actions.execute({ pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_TRIAGE_ACTION_IDS_V1.listInstances }, input) },
      'native-discover': { title: 'Native discovery transport', surfaces: ['plugin'], execution: GITHUB_ACCOUNT_EXECUTION, run: async (input, context) =>
        context.services.actions.execute({ pluginId: GITHUB_PLUGIN_ID, localId: githubNativeReadActionId(GITHUB_TRIAGE_ACTION_IDS_V1.listInstances) }, input) },
      links: { title: 'Session relationships', surfaces: ['plugin'], execution: GITHUB_ACCOUNT_EXECUTION, run: async (input, context) =>
        context.services.actions.execute({ pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_TRIAGE_ACTION_IDS_V1.readSessionLinks }, input) },
      'native-links': { title: 'Native relationship transport', surfaces: ['plugin'], execution: GITHUB_ACCOUNT_EXECUTION, run: async (input, context) =>
        context.services.actions.execute({ pluginId: GITHUB_PLUGIN_ID, localId: githubNativeReadActionId(GITHUB_TRIAGE_ACTION_IDS_V1.readSessionLinks) }, input) },
    } });
    relay = await createPluginTestkit({ manifest: definition.manifest, module: definition,
      resolveCurrentPluginMaterializationRef: () => null, actionTargets: [github] });
    const fixture = createTriageSourceV1Fixture().configuredInstance;
    const instance = { ...fixture,
      instance: { source: { pluginId: GITHUB_PLUGIN_ID, localId: 'github-forge' }, sourceInstanceId: fixture.instance.sourceInstanceId },
      binding: { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, source: 'native', service: GITHUB_TEST_ACCOUNT.service },
      localInstanceKey: 'github.com', configuration: { v: 1, token: encodeGithubTriageConfiguration({ v: 1, scope: { kind: 'account' } })! } };
    try {
      await expect(relay.invokeAction('scan', { v: 1, instance, page: { kind: 'initial', limit: 64 } }))
        .rejects.toMatchObject({ code: 'plugin_action_machine_required' });
      await expect(relay.invokeAction('discover', { v: 1 }))
        .rejects.toMatchObject({ code: 'plugin_action_machine_required' });
      await expect(relay.invokeAction('links', { v: 1, instance }))
        .rejects.toMatchObject({ code: 'plugin_action_machine_required' });
      expect(transport.requests).toEqual([]);
      expect(transport.materializeCount()).toBe(0);
    } finally { await relay.dispose(); await github.dispose(); }
  });
});
