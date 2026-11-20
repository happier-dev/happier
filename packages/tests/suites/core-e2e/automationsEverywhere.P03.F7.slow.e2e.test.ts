import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ActionPolicyOutputSchemas } from '@happier-dev/protocol/actions/actionPolicyActionFamily';
import { SessionSpawnNewActionResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest/v2';
import { applyTrustedLocalPluginFixture } from '../../src/testkit/externalSessionLiveLifecycleFixture';
import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { fetchSessionV2 } from '../../src/testkit/sessions';
import { createIsolatedFakeClaudeControlShim } from '../../src/testkit/fakeClaude';

describe('Shared approval profiles: contributed target admission', () => {
  let fixture: TeamSetupFFixture | undefined;
  let provider: Server | undefined;
  afterEach(async () => {
    try { await fixture?.stop(); } finally {
      fixture = undefined;
      await new Promise<void>((resolve, reject) => provider ? provider.close(error => error ? reject(error) : resolve()) : resolve());
      provider = undefined;
    }
  }, 0);

  it('AE.P03.F7-admission applies Ask and Allowed to the contributed target without Artifact reads', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'ae-p03-contributed-profile-'));
    let effects = 0;
    // Only the external deployment provider is replaced. The installed plugin,
    // Action executor, approvals, server, PostgreSQL and daemon remain real.
    provider = createServer((request, response) => {
      if (request.method !== 'POST' || request.url !== '/deploy') { response.writeHead(404).end(); return; }
      effects += 1;
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ deployed: true }));
    });
    await new Promise<void>(resolve => provider!.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    if (!address || typeof address === 'string') throw new Error('Provider fixture did not bind');
    const providerUrl = `http://127.0.0.1:${address.port}/deploy`;
    fixture = await startTeamSetupFFixture({ testDir, observeActionRequests: true });
    const actor = await fixture.createAccount('actor');
    const agent = await createIsolatedFakeClaudeControlShim({ testDir: join(testDir, 'agent'),
      invocationId: 'profile-contributed-admission', captureEnvironmentKeys: [], logFullStdin: false });
    const machine = await fixture.enrollDaemon(actor, { env: { HAPPIER_SERVER_URL: fixture.actionServerApiUrl,
      HAPPIER_CLAUDE_PATH: agent.executablePath } });
    await fixture.assertKnownGoodSessionControl(actor, machine);
    const spawned = await actor.execute('session.spawn_new', { executionTarget: machine.target,
      directory: { kind: 'path', path: machine.workspaceDir }, terminal: { mode: 'plain' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } });
    expect(spawned.ok, JSON.stringify(spawned)).toBe(true);
    if (!spawned.ok) throw new Error(spawned.errorCode);
    const session = SessionSpawnNewActionResultV1Schema.parse(spawned.result);
    if (session.type !== 'success') throw new Error('Contributed profile Session did not start');
    const action = { pluginId: 'acme.approval-profile-deploy', localId: 'deploy' };
    const actionId = formatQualifiedPluginActionId(action);
    const pluginRoot = join(testDir, 'deploy-plugin');
    await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
    await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({ name: action.pluginId, version: '1.0.0', type: 'module' }));
    await writeFile(join(pluginRoot, '.happier-plugin/plugin.json'), JSON.stringify(PluginManifestV2Schema.parse({
      schemaVersion: 2, id: action.pluginId, version: '1.0.0', displayName: 'Approval profile deploy fixture',
      engines: { happier: '^0.3.0' }, runtime: { apiVersion: 1 },
      entrypoints: { daemon: './daemon.mjs', development: './daemon.mjs' },
      contributes: { actions: [{ id: action.localId, title: 'Deploy fixture', scopes: ['global'],
        surfaces: ['cli', 'agent', 'mcp', 'plugin'], execution: { target: 'daemon' }, dangerLevel: 'writesRemote',
        confirmation: { title: 'Deploy fixture', body: 'Deploy through the external fixture provider.' },
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        resultSchema: { type: 'object', required: ['deployed'], properties: { deployed: { type: 'boolean' } }, additionalProperties: false },
      }] } })));
    await writeFile(join(pluginRoot, 'daemon.mjs'), `export function activate(api) {
      api.actions.register('deploy', async () => {
        const response = await fetch(${JSON.stringify(providerUrl)}, { method: 'POST' });
        if (!response.ok) throw new Error('fixture_provider_failed');
        return await response.json();
      });
    }\n`);
    const plugin = { daemonPort: machine.daemon.state.httpPort, controlToken: machine.daemon.state.controlToken,
      pluginRoot, pluginId: action.pluginId };
    await applyTrustedLocalPluginFixture({ ...plugin, interactionId: 'profile-deploy-install' });
    // A raw Account read would allow this operation. The Ask profile must
    // change the result, independently of the manifest's dangerous default.
    const accountPolicy = await actor.executeAsPerson('actions.policy.set', { actionId, audience: 'agent', mode: 'allowed' });
    expect(accountPolicy, JSON.stringify(accountPolicy))
      .toMatchObject({ ok: true, result: { actionId, mode: 'allowed', enabled: true, actionEnabled: true } });
    const profiles: string[] = [];
    for (let index = 0; index < 50; index += 1) {
      const ask = index === 0;
      const off = index === 2;
      const created = await actor.executeAsPerson('actions.policy.set', { profileChange: { kind: 'create', profile: {
        name: ask ? 'Deploy asks' : `Deploy allowed ${index}`,
        actions: { [actionId]: { approvalRequiredSurfaces: ask ? ['agent', 'mcp', 'plugin'] : [],
          ...(off ? { disabledSurfaces: ['agent', 'mcp', 'plugin'] } : {}) } },
        ...(ask || off ? {} : { approvalWaivedSurfaces: { [actionId]: ['agent', 'mcp', 'plugin'] } }),
      } } });
      expect(created.ok, JSON.stringify(created)).toBe(true);
      if (!created.ok) throw new Error(created.errorCode);
      const change = ActionPolicyOutputSchemas['actions.policy.set'].parse(created.result);
      if (!('profileChange' in change) || change.profileChange.kind !== 'create') throw new Error('Profile creation did not return an Artifact');
      profiles.push(change.profileChange.id);
    }
    const input = { action, input: {} };
    // The Session's real MCP host owns daemon placement and caller provenance.
    // A test-process Account executor has no local daemon or native turn.
    const invoke = () => fixture!.executeSessionMcpAction(actor,
      { sessionId: session.sessionId, logPath: agent.logPath }, 'action.invoke', input);
    async function pickProfile(approvalProfileId: string) {
      const stored = await fetchSessionV2(fixture!.server.baseUrl, actor.credentials.token, session.sessionId);
      expect(await actor.executeAsPerson('session.approval_profile.set', { sessionId: session.sessionId,
        serverId: fixture!.serverId, expectedMetadataRevision: stored.metadataVersion, approvalProfileId }))
        .toMatchObject({ ok: true });
    }
    await pickProfile(profiles[0]!);
    const asked = await invoke();
    expect(asked.ok, JSON.stringify(asked)).toBe(true);
    if (!asked.ok) throw new Error(asked.errorCode);
    const pending = ActionApprovalRequestCreatedResultSchema.parse(asked.result);
    expect(effects).toBe(0);
    expect(await actor.executeAsPerson('approval.request.decide', { artifactId: pending.artifactId, decision: 'reject' }))
      .toMatchObject({ ok: true });
    // Warm the catalog before measuring repeated admissions: this admission is
    // also the positive control that the external effect is actually reachable.
    await pickProfile(profiles[1]!);
    expect(await invoke())
      .toMatchObject({ ok: true, result: { deployed: true } });
    expect(effects).toBe(1);
    fixture.takeRequestObservations();
    for (let admission = 0; admission < 3; admission += 1) {
      expect(await invoke())
        .toMatchObject({ ok: true, result: { deployed: true } });
    }
    expect(effects).toBe(4);
    expect(fixture.takeRequestObservations().filter(({ method, path }) => method === 'GET'
      && /^\/v[12]\/artifacts(?:\/|\?|$)/u.test(path))).toEqual([]);
    await pickProfile(profiles[2]!);
    const disabled = await invoke();
    expect(disabled.ok).toBe(false);
    if (!disabled.ok) expect(['action_disabled', 'plugin_action_unavailable']).toContain(disabled.errorCode);
    expect(effects).toBe(4);
  }, 0);
});
