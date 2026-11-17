import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { MachinePresetActionOutputSchemasV1 } from '@happier-dev/protocol/machines/managed/machinePresetActionsV1';
import { ManagedMachinePresetRecipientCensusResultV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { sealManagedMachinePresetContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { MachineIsolationGetResultV1Schema } from '@happier-dev/protocol/machines/machineIsolationPolicyV1';
import { ManagedListOutputV1Schema, unwrapManagedMachineReadV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { readSessionTitleInMetadata } from '@happier-dev/protocol/sessions/metadata/sessionTitle';
import { ExecutionRunStartResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { startProjectDaemonFixture, type ProjectDaemonFixture } from '../../src/testkit/daemon/projectDaemon';
import { PluginManifestV2LoadSchema } from '@happier-dev/protocol/plugins/manifest';
import { projectBundledPluginUiDeclaration } from '../../../../apps/cli/scripts/build-owned/bundledPlugins/uiDeclarations.mjs';
import { installBundledPluginUiDeclarationsForTests } from '../../../../apps/ui/sources/dev/testkit/mocks/bundledPluginUiAssets';
import { startDatabaseWorkbenchPostgres } from '../../src/testkit/process/databaseWorkbenchPostgres';
import { replaceTestDaemonWithoutStoppingSessions, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { repoRootDir } from '../../src/testkit/paths';
import { waitFor } from '../../src/testkit/timing';
import { connectUiPersonActionClient } from '@happier-tests/ui-action-client';

// A native vendor boundary runs inside the real product-created Docker target.
// PostgreSQL, signed-in person, admission, daemon, holder and MCP relay stay real.
it('L12 placed Session and Run use their own MCP registrations, readable native files and survive daemon replacement', async () => {
  const testDir = await mkdtemp(join(tmpdir(), 'l12-placed-mcp-'));
  const database = await startDatabaseWorkbenchPostgres({ preloadStatistics: false });
  let fixture: ProjectDaemonFixture | undefined;
  let replacement: StartedDaemon | undefined;
  let person: Awaited<ReturnType<typeof connectUiPersonActionClient>> | undefined;
  let cleanup: (() => Promise<void>) | undefined;
  let restorePackagedDeclarations: (() => void) | undefined;
  try {
    // The Node UI harness replaces Expo assets. Supply the same declaration
    // producer used by the app build, while retaining real provider admission.
    const manifest = PluginManifestV2LoadSchema.parse(JSON.parse(await readFile(resolve(repoRootDir(),
      'apps/cli/assets/bundled-plugin-manifests/devcontainer.json'), 'utf8')));
    restorePackagedDeclarations = installBundledPluginUiDeclarationsForTests([await projectBundledPluginUiDeclaration({
      packageName: '@happier-dev/plugins-devcontainer', packageVersion: manifest.version, manifest, artifactGraphs: [],
    })]);
    fixture = await startProjectDaemonFixture({ testDir, dbProvider: 'postgres', serverEnv: { ...process.env, DATABASE_URL: database.homeDatabaseUrl } });
    const account = await fixture.createAccount('placed-mcp-owner');
    const fakeAgent = join(testDir, 'claude');
    await copyFile(resolve(repoRootDir(), 'packages/tests/fixtures/machines/mcp-claude.cjs'), fakeAgent);
    await chmod(fakeAgent, 0o755);
    const cliLaunchSpec = { command: process.execPath, args: [resolve(repoRootDir(), 'apps/cli/src/index.ts')], cwd: resolve(repoRootDir(), 'apps/cli') };
    const machine = await fixture.enrollDaemon(account, { cliLaunchSpec, env: { ...process.env, HAPPIER_CLAUDE_PATH: fakeAgent } });
    const home = fixture;
    person = await connectUiPersonActionClient({ serverUrl: home.server.baseUrl, accountSecret: account.auth.accountSigningSeed });
    await waitFor(() => person!.isAccountReady() && person!.isMachineActive(machine.target.machineId),
      { timeoutMs: 60_000, context: 'signed-in person sees enrolled controller ready' });
    const target = { serverId: person.serverId, machineId: machine.target.machineId };
    const action = async (id: ActionId, input: unknown) => {
      const result = await person!.executeConfirmed(id, input, { surface: 'ui', authority: 'present_user',
        actionCaller: { kind: 'host' }, serverId: person!.serverId, serverIdentityId: home.serverId, actionRequestId: randomUUID() });
      expect(result, `${id}: ${JSON.stringify(result)}`).toMatchObject({ ok: true });
      if (!result.ok) throw new Error(`${id}: ${result.errorCode}`);
      return result.result;
    };
    let presetId: string | undefined;
    const resources = async () => ManagedListOutputV1Schema.parse(await action('machines.managed.list', { homeId: home.serverId,
      ...(presetId ? { presetId } : {}) }))
      .machines.map(unwrapManagedMachineReadV1);
    const managedIds = new Set<string>();
    let sessionId: string | undefined;
    cleanup = async () => {
      if (sessionId) await action('session.stop', { sessionId });
      for (const managed of await resources()) if (presetId || managedIds.has(managed.id)) {
        await action('machines.managed.delete', { homeId: home.serverId, managedId: managed.id, when: 'now',
          expectedRevision: managed.intentRevision, intent: 'delete', reviewedDependencies: true });
      }
    };
    const listed = await action('machines.list', { serverId: target.serverId });
    const row = (listed as { items: { machineId: string; installationId: string }[] }).items.find(item => item.machineId === machine.target.machineId);
    if (!row) throw new Error(`Enrolled controller identity missing: ${JSON.stringify(listed)}`);
    const controller = { machineId: row.machineId, installationId: row.installationId };
    const owner = { kind: 'account' as const, accountId: readAccountIdFromToken(account.credentials.token)! };
    const response = await fetch(`${home.server.baseUrl}/v1/machines/presets/recipient-census`, {
      method: 'POST', headers: { Authorization: `Bearer ${account.credentials.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ homeId: home.serverId, owner, controller }),
    });
    expect(response.status).toBe(200);
    const census = ManagedMachinePresetRecipientCensusResultV1Schema.parse(await response.json());
    if (census.kind !== 'ready') throw new Error(`Preset recipient census: ${census.code}`);
    const id = randomUUID();
    const contribution = { pluginId: 'happier.devcontainer', localId: 'devcontainer' };
    const content = { v: 1 as const, name: 'MCP journey', launch: { provider: contribution, schemaVersion: 1, name: 'MCP journey',
      choices: { runtime: 'docker', configuration: { kind: 'image', image: process.env.HAPPIER_TEST_SANDBOX_IMAGE ?? 'node:22-bookworm' } } } };
    const sealed = sealManagedMachinePresetContentV1({ presetId: id, mode: 'e2ee', content, recipientCensus: census.recipients,
      randomBytes: length => new Uint8Array(randomBytes(length)) });
    const saved = MachinePresetActionOutputSchemasV1['machines.presets.create'].parse(await action('machines.presets.create', {
      id, homeId: home.serverId, owner, controller, contentEncryptionMode: 'e2ee', ...sealed,
    }));
    if (saved.kind !== 'saved') throw new Error(`Preset not saved: ${saved.kind}`);
    presetId = saved.preset.id;
    const current = MachineIsolationGetResultV1Schema.parse(await action('machines.isolation.get', target));
    if (current.status !== 'ready') throw new Error(`Isolation policy: ${current.status}`);
    await action('machines.isolation.set', { ...target, expectedPolicy: current.policy, expectedMetadataVersion: current.metadataVersion,
      policy: { ...current.policy, configuredSandboxes: { mcp: { provisioner: contribution, presetId: saved.preset.id } },
        workKinds: { ...current.policy.workKinds, sessions: { kind: 'sandbox', configuredSandboxId: 'mcp', lifecycle: 'fresh' } } } });
    const created = SessionSpawnNewResultV1Schema.parse(await action('session.spawn_new', {
      executionTarget: target, directory: { kind: 'path', path: machine.workspaceDir }, terminal: { mode: 'plain' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
      initialInput: { text: 'Use your own Happier MCP and report ready.' },
    }));
    for (const managed of await resources()) managedIds.add(managed.id);
    expect(created, JSON.stringify(created)).toMatchObject({ type: 'success' });
    if (created.type !== 'success') throw new Error('Placed Session did not start');
    sessionId = created.sessionId;
    await waitFor(async () => readSessionTitleInMetadata(await account.readSessionMetadata(sessionId!)) === 'Placed MCP reached own Session',
      { timeoutMs: 60_000, context: 'placed parent MCP changes its own Session title' });
    const managed = (await resources()).find(item => managedIds.has(item.id));
    if (!managed) throw new Error('Placed target not retained');
    const containers = execFileSync('docker', ['ps', '--filter', `label=happier.managed-machine=${managed.id}`, '--format', '{{.ID}}'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    expect(containers).toHaveLength(1);
    const observations = () => execFileSync('docker', ['exec', containers[0]!, 'sh', '-c', 'find / -name mcp-observations.jsonl -type f -exec cat {} + 2>/dev/null'], { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { registration?: string; nativeFiles: number; pid: number; completed: boolean });
    const first = observations().filter(item => !item.completed);
    expect(first).toHaveLength(1);
    expect(first[0]!.nativeFiles).toBeGreaterThan(0);
    expect(first[0]!.registration).toMatch(/^[a-f0-9]{64}$/);
    const run = ExecutionRunStartResponseSchema.parse(await action('execution.run.start', { sessionId, intent: 'agent',
      backendTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
      instructions: 'RUN_MCP: use your own Happier MCP and report its typed unselected-Session refusal.', permissionMode: 'read_only', retentionPolicy: 'ephemeral',
      runClass: 'bounded', ioMode: 'request_response', waitForCompletion: true }));
    expect(run.wait).toMatchObject({ ok: true, status: 'succeeded' });
    const afterRun = observations().filter(item => !item.completed);
    expect(afterRun).toHaveLength(2);
    expect(new Set(afterRun.map(item => item.registration)).size).toBe(2);
    expect(afterRun.every(item => item.nativeFiles > 0)).toBe(true);
    replacement = await replaceTestDaemonWithoutStoppingSessions({ testDir, happyHomeDir: machine.homeDir, originalDaemon: machine.daemon,
      cliLaunchSpec, env: { ...process.env, CI: '1', HAPPIER_VARIANT: 'dev', HAPPIER_HOME_DIR: machine.homeDir,
        HAPPIER_SERVER_URL: home.server.baseUrl, HAPPIER_WEBAPP_URL: home.server.baseUrl, NODE_OPTIONS: home.sourceOptions,
        HAPPIER_CLAUDE_PATH: fakeAgent, HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1', HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1' } });
    expect(replacement.state.pid).not.toBe(machine.daemon.state.pid);
    const completedBefore = observations().filter(item => item.completed && item.pid === first[0]!.pid).length;
    await action('session.message.send', { sessionId, message: 'Use MCP once more after daemon restart.' });
    await waitFor(() => observations().filter(item => item.completed && item.pid === first[0]!.pid).length > completedBefore,
      { timeoutMs: 60_000, context: 'same placed Agent completes another real MCP call after daemon replacement' });
    expect(observations().filter(item => !item.completed && item.pid === first[0]!.pid)).toEqual(first);
  } finally {
    try { await cleanup?.(); }
    finally {
      try { await person?.close(); }
      finally { try { await replacement?.stop(); } finally { try { await fixture?.stop(); } finally {
        try { await database.stop(); } finally { restorePackagedDeclarations?.(); }
      } } }
    }
  }
}, 0);
