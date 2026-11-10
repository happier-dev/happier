import { describe, expect, it } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { TriageReadConfiguredSourceInstancesResultV1Schema } from '@happier-dev/triage-protocol/v1';
import { GITHUB_PLUGIN } from '../manifest.js';
import { encodeGithubTriageConfiguration } from '../triage/configuration.js';
import { GITHUB_PLUGIN_ID, GITHUB_CONNECTED_ACCOUNT_PURPOSE } from '../observations/githubProviderContracts.js';
import { createStubGithubTransport, GITHUB_TEST_ACCOUNT } from '../triage/testkit/githubTriage.test-support.js';
import { GITHUB_REPOSITORY_RESPONSE } from '../triage/__fixtures__/githubResponses.js';
import { GITHUB_ACTIONS_PAGE_ID_V1 } from '../ui/forge/surfaceIds.js';
import { GITHUB_TRIAGE_SETTINGS_PAGE_ID_V1 } from '../triage/contribution.js';

const actionId = 'github/actions/project-readiness-read';
const repository = { kind: 'github', deployment: 'https://github.com', repository: 'octo-org/example-app' } as const;

function source(repositoryKey: string, lifecycle: 'active' | 'retired' = 'active') {
  const configured = createTriageSourceV1Fixture().configuredInstance;
  return { v: 1 as const, lifecycle, configured: { ...configured,
    instance: { ...configured.instance, source: { pluginId: GITHUB_PLUGIN_ID, localId: 'github-forge' } },
    localInstanceKey: 'github.com', binding: { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, account: GITHUB_TEST_ACCOUNT },
    configuration: { v: 1 as const, token: encodeGithubTriageConfiguration({ v: 1,
      selection: { kind: 'selected', unitIds: [repositoryKey] }, alerts: { dependabot: true, codeScanning: false } })! },
  } };
}

describe('registered GitHub Project readiness source facts', () => {
  it('reads source presence through the registered Action without run or finding reads', async () => {
    const transport = createStubGithubTransport({
      nativeMaterialization: { kind: 'httpHeaders', headers: { Authorization: 'Bearer fixture' } },
      respond: request => new URL(request.url).pathname === '/repos/octo-org/example-app'
        ? { status: 200, body: GITHUB_REPOSITORY_RESPONSE }
        : ({ status: 200, body: { total_count: 1, workflows: [{ id: 7, name: 'Build',
        path: '.github/workflows/build.yml', state: 'active', html_url: 'https://github.com/octo-org/example-app/actions/workflows/build.yml' }] } }),
      executeAction: () => TriageReadConfiguredSourceInstancesResultV1Schema.parse({ kind: 'read', status: 'complete',
        instances: [source(repository.repository)] }),
    });
    const kit = await createPluginTestkit({ manifest: GITHUB_PLUGIN.manifest, module: GITHUB_PLUGIN,
      services: transport.context.services });
    try {
      expect(await kit.invokeAction(actionId, { repository })).toMatchObject({ repository,
        ci: { status: 'ready', setupSurface: { pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_ACTIONS_PAGE_ID_V1 } },
        security: { status: 'ready', setupSurface: { pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_TRIAGE_SETTINGS_PAGE_ID_V1 } } });
      expect(GITHUB_PLUGIN.manifest.contributes.ui?.views).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: GITHUB_ACTIONS_PAGE_ID_V1, target: { kind: 'project' } }),
      ]));
      expect(GITHUB_PLUGIN.manifest.contributes.ui?.settingsPages).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: GITHUB_TRIAGE_SETTINGS_PAGE_ID_V1 }),
      ]));
      expect(transport.requests.map(request => new URL(request.url).pathname).sort()).toEqual([
        '/repos/octo-org/example-app/actions/workflows', '/repos/octo-org/example-app',
      ].sort());
    } finally { await kit.dispose(); }
  });

  it('distinguishes empty CI and retired or other-repository security sources from ready', async () => {
    let configured = [source(repository.repository, 'retired'), source('octo-org/other')];
    const transport = createStubGithubTransport({
      nativeMaterialization: { kind: 'httpHeaders', headers: { Authorization: 'Bearer fixture' } },
      respond: request => new URL(request.url).pathname === '/repos/octo-org/example-app'
        ? { status: 200, body: GITHUB_REPOSITORY_RESPONSE }
        : { status: 200, body: { total_count: 0, workflows: [] } },
      executeAction: () => TriageReadConfiguredSourceInstancesResultV1Schema.parse({ kind: 'read', status: 'complete',
        instances: configured }),
    });
    const kit = await createPluginTestkit({ manifest: GITHUB_PLUGIN.manifest, module: GITHUB_PLUGIN,
      services: transport.context.services });
    try {
      expect(await kit.invokeAction(actionId, { repository })).toMatchObject({
        ci: { status: 'actionNeeded' }, security: { status: 'actionNeeded' },
      });
      configured = [source(repository.repository)];
      expect(await kit.invokeAction(actionId, { repository })).toMatchObject({
        ci: { status: 'actionNeeded' }, security: { status: 'ready' },
      });
      expect(transport.requests).toHaveLength(3);
    } finally { await kit.dispose(); }
  });

  it('preserves a CI credential refusal while security source presence settles independently', async () => {
    const transport = createStubGithubTransport({
      nativeMaterialization: { kind: 'httpHeaders', headers: { Authorization: 'Bearer fixture' } },
      respond: request => new URL(request.url).pathname === '/repos/octo-org/example-app'
        ? { status: 200, body: GITHUB_REPOSITORY_RESPONSE } : { status: 403 },
      executeAction: () => TriageReadConfiguredSourceInstancesResultV1Schema.parse({ kind: 'read', status: 'complete',
        instances: [source(repository.repository)] }),
    });
    const kit = await createPluginTestkit({ manifest: GITHUB_PLUGIN.manifest, module: GITHUB_PLUGIN,
      services: transport.context.services });
    try {
      expect(await kit.invokeAction(actionId, { repository })).toMatchObject({
        ci: { status: 'unavailable', reason: 'github_forbidden' }, security: { status: 'ready' },
      });
    } finally { await kit.dispose(); }
  });

  it('does not claim an absent security source from an incomplete configured-source read', async () => {
    const transport = createStubGithubTransport({
      nativeMaterialization: { kind: 'httpHeaders', headers: { Authorization: 'Bearer fixture' } },
      respond: () => ({ status: 200, body: { workflows: [] } }),
      executeAction: () => TriageReadConfiguredSourceInstancesResultV1Schema.parse({ kind: 'read', status: 'truncated', instances: [] }),
    });
    const kit = await createPluginTestkit({ manifest: GITHUB_PLUGIN.manifest, module: GITHUB_PLUGIN,
      services: transport.context.services });
    try {
      expect(await kit.invokeAction(actionId, { repository })).toMatchObject({
        ci: { status: 'actionNeeded' }, security: { status: 'unavailable', reason: 'security_source_read_incomplete' },
      });
    } finally { await kit.dispose(); }
  });

  it('requires an All source credential to reach this exact Project repository', async () => {
    const configured = source(repository.repository);
    configured.configured.configuration.token = encodeGithubTriageConfiguration({ v: 1,
      selection: { kind: 'all' }, alerts: { dependabot: true, codeScanning: false } })!;
    const transport = createStubGithubTransport({
      nativeMaterialization: { kind: 'httpHeaders', headers: { Authorization: 'Bearer fixture' } },
      respond: request => new URL(request.url).pathname === '/repos/octo-org/example-app'
        ? { status: 403 } : { status: 200, body: { workflows: [] } },
      executeAction: () => TriageReadConfiguredSourceInstancesResultV1Schema.parse({ kind: 'read', status: 'complete', instances: [configured] }),
    });
    const kit = await createPluginTestkit({ manifest: GITHUB_PLUGIN.manifest, module: GITHUB_PLUGIN,
      services: transport.context.services });
    try {
      expect(await kit.invokeAction(actionId, { repository })).toMatchObject({
        security: { status: 'unavailable', reason: 'github_forbidden' },
      });
    } finally { await kit.dispose(); }
  });

  it('keeps a pending source read pending and retires it with its invocation signal', async () => {
    const controller = new AbortController();
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const transport = createStubGithubTransport({ signal: controller.signal,
      nativeMaterialization: { kind: 'httpHeaders', headers: { Authorization: 'Bearer fixture' } },
      respond: () => ({ status: 200, body: { workflows: [] } }),
      async executeAction() { entered(); await waiting;
        return TriageReadConfiguredSourceInstancesResultV1Schema.parse({ kind: 'read', status: 'complete', instances: [] }); },
    });
    const kit = await createPluginTestkit({ manifest: GITHUB_PLUGIN.manifest, module: GITHUB_PLUGIN,
      services: transport.context.services });
    try {
      let settled = false;
      const pending = kit.invokeAction(actionId, { repository }, { signal: controller.signal })
        .finally(() => { settled = true; });
      await started;
      expect(settled).toBe(false);
      controller.abort(); release();
      await expect(pending).rejects.toMatchObject({ code: 'plugin_action_aborted' });
    } finally { release(); await kit.dispose(); }
  });
});
