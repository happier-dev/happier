import { copyFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';

import { createRunDirs } from '../../src/testkit/runDir';
import { repoRootDir } from '../../src/testkit/paths';
import { resolveCliTestLaunchSpec } from '../../src/testkit/process/cliLaunchSpec';
import { sanitizeCliTestEnv } from '../../src/testkit/process/cliTestEnv';
import { readLoggedCommandProcessOutcome, runLoggedCommandWithOutcome } from '../../src/testkit/process/spawnProcess';
import { waitFor } from '../../src/testkit/timing';

/**
 * Opt in with HAPPIER_E2E_SSH_HOST, HAPPIER_E2E_SSH_USER,
 * HAPPIER_E2E_SSH_IDENTITY_FILE and HAPPIER_E2E_SSH_WORKSPACE.
 * The selected user/host must be disposable: enrollment installs the Home CLI,
 * pairs this fresh Account and starts its real user daemon service. The host
 * owner disposes the installation afterwards. No shared-user localhost fallback.
 *
 * Home: HAPPIER_TEST_POSTGRES_DATABASE_URL. Source-server preparation supplies
 * the standalone SSH controller's local payload for the disposable guest.
 * The fixture publishes guest-reachable TLS on the selected controller
 * interface. The disposable SSH user must be able to reach that interface and
 * run Claude. Optional SSH port: HAPPIER_E2E_SSH_PORT.
 * HAPPIER_E2E_SSH_HOME_CA_FILE may name the public CA file mounted by a
 * disposable guest. Its host controls how the guest trusts that file.
 */
it.skipIf(!process.env.HAPPIER_E2E_SSH_HOST)(
  'J5 SSH first-use trust and Account pairing reaches Online, then starts a Session on that Machine',
  async () => {
    const required = (key: string) => {
      const value = process.env[key]?.trim();
      if (!value) throw new Error(`SSH journey requires ${key}`);
      return value;
    };
    const host = required('HAPPIER_E2E_SSH_HOST');
    const user = required('HAPPIER_E2E_SSH_USER');
    const identityFile = required('HAPPIER_E2E_SSH_IDENTITY_FILE');
    const workspace = required('HAPPIER_E2E_SSH_WORKSPACE');
    const port = process.env.HAPPIER_E2E_SSH_PORT?.trim();
    const serverEnv = {
      DATABASE_URL: required('HAPPIER_TEST_POSTGRES_DATABASE_URL'),
      HAPPIER_DEV_GUEST_CLI_EXPORT: '1',
    };
    const [{ startTeamSetupFFixture }, { connectUiPersonActionClient },
      { FeaturesResponseSchema, SystemTaskEventSchema, SystemTaskResultSchema },
      { SessionSpawnNewActionResultV1Schema }, { createOpenSshHappierJsonExecutor },
      { runOpenSshRemoteCommand }, { buildSshTarget }] = await Promise.all([
      import('../../src/testkit/teamSetupF'),
      import('@happier-tests/ui-action-client'), import('@happier-dev/protocol'),
      import('@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1'),
      import('@happier-dev/cli-common/systemTasks/nativeRemoteSshBootstrap'),
      import('@happier-dev/cli-common/ssh'), import('@happier-dev/cli-common/systemTasks'),
    ]);
    const run = createRunDirs({ runLabel: 'ssh-enrollment-journey' });
    const testDir = run.testDir('ssh-enroll-online-session');
    // Publish the same guest-reachable Home ingress used by the native managed
    // journey. A remote SSH target must receive a real non-loopback Home
    // descriptor; the production carrier policy must remain unchanged.
    const fixture = await startTeamSetupFFixture({ testDir, dbProvider: 'postgres',
      guestReachableHome: { host }, serverEnv });
    let ui: Awaited<ReturnType<typeof connectUiPersonActionClient>> | undefined;
    let sessionId: string | undefined;
    let remote: ReturnType<typeof createOpenSshHappierJsonExecutor> | undefined;
    let enrolled = false;
    const failures: unknown[] = [];
    try {
      const homeCaPath = fixture.guestHomeCaCertificatePath;
      if (!homeCaPath) throw new Error('SSH journey did not publish a guest Home CA');
      const guestCliPayloadRoot = fixture.server.guestCliPayloadRoot;
      if (!guestCliPayloadRoot) throw new Error('SSH journey did not prepare its controller-local guest payload');
      const guestHomeCaFile = process.env.HAPPIER_E2E_SSH_HOME_CA_FILE?.trim();
      if (guestHomeCaFile) {
        await copyFile(homeCaPath, guestHomeCaFile);
      }
      const account = await fixture.createAccount('ssh-owner');
      const local = await fixture.enrollDaemon(account);
      // Keep the signed-in CLI Home while the journey enrolls its remote target.
      await local.daemon.stop();
      const features = await fetch(`${fixture.server.baseUrl}/v1/features`);
      expect(features.status).toBe(200);
      expect(FeaturesResponseSchema.parse(await features.json()).capabilities.guestCli?.source,
        'SSH enrollment must consume the selected Home payload').toBe('home-payload');
      const knownHostsPath = join(testDir, 'known_hosts');
      const target = buildSshTarget({ username: user, host });
      if (!target) throw new Error('SSH journey requires a valid SSH target');
      const ssh = { target, ...(port ? { port: Number(port) } : {}), auth: 'keyfile' as const,
        identityFile, knownHostsPath };
      remote = createOpenSshHappierJsonExecutor({ ssh, auth: { mode: 'keyFile', privateKeyPath: identityFile },
        knownHostsMode: 'app', channel: 'publicdev',
        runRemoteText: ({ remoteCommand, signal, timeoutMs, onStdoutChunk, includeStdoutInError, input }) =>
          runOpenSshRemoteCommand({ target, auth: { mode: 'keyFile', privateKeyPath: identityFile },
            ...(port ? { port: Number(port) } : {}), knownHostsPath, knownHostsMode: 'app',
            remoteCommand: [remoteCommand], signal, timeoutMs, onStdoutChunk, includeStdoutInError, input }),
      });
      const env = sanitizeCliTestEnv({ ...process.env, NODE_OPTIONS: fixture.sourceOptions, NODE_EXTRA_CA_CERTS: homeCaPath,
        HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT: guestCliPayloadRoot,
        CI: '1', HAPPIER_HOME_DIR: local.homeDir, HAPPIER_SERVER_URL: fixture.server.baseUrl,
        HAPPIER_WEBAPP_URL: fixture.server.baseUrl, HAPPIER_DISABLE_CAFFEINATE: '1', HAPPIER_VARIANT: 'dev',
        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1', HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1' });
      const launch = await resolveCliTestLaunchSpec({ testDir, env },
        { snapshotDir: join(testDir, 'cli-dist'), preferSourceEntrypoint: true });
      const stdoutPath = join(testDir, 'cli.ssh-enroll.stdout.log');
      let commandError: unknown;
      try {
        await runLoggedCommandWithOutcome({ command: launch.command,
          args: [...launch.args, 'machine', 'enroll', '--ssh-host', host, '--ssh-user', user,
            ...(port ? ['--ssh-port', port] : []), '--ssh-auth', 'keyfile', '--identity-file', identityFile,
            '--known-hosts-path', knownHostsPath, '--dev', '--yes', '--json'],
          cwd: launch.cwd ?? repoRootDir(), env: { ...env, ...launch.env }, stdoutPath,
          stderrPath: join(testDir, 'cli.ssh-enroll.stderr.log'), timeoutMs: null });
      } catch (error) {
        if (!readLoggedCommandProcessOutcome(error)) throw error;
        commandError = error;
      } finally { await launch.cleanup?.(); }
      // machine enroll emits SystemTask events and a final SystemTaskResult,
      // rather than the ordinary CLI { kind, ok, data } JSON envelope.
      const records = (await readFile(stdoutPath, 'utf8')).split(/\r?\n/).flatMap(line => {
        try { return [JSON.parse(line) as unknown]; } catch { return []; }
      });
      const result = SystemTaskResultSchema.safeParse(records.at(-1));
      if (!result.success) throw commandError ?? result.error;
      expect(result.data, 'real SSH enrollment terminal result').toMatchObject({ ok: true });
      if (!result.data.ok) throw new Error(`SSH enrollment refused: ${result.data.error.code}`);
      enrolled = true;
      if (commandError) throw commandError;
      const data = result.data.data;
      if (!data || typeof data !== 'object' || !('machineId' in data) || typeof data.machineId !== 'string') {
        throw new Error('SSH enrollment omitted its registered Machine identity');
      }
      const machineId = data.machineId;
      expect(records.some(record => {
        const event = SystemTaskEventSchema.safeParse(record);
        const prompt = event.success ? event.data.data : null;
        return event.success && event.data.type === 'prompt' && prompt && typeof prompt === 'object'
          && 'kind' in prompt && prompt.kind === 'ssh.trustHost';
      }), 'fresh known-hosts store must exercise actual first-use SSH trust').toBe(true);
      ui = await connectUiPersonActionClient({ serverUrl: fixture.actionServerApiUrl,
        accountSecret: account.auth.accountSigningSeed });
      await waitFor(() => ui!.isAccountReady() && ui!.isMachineActive(machineId)
        && ui!.isMachineControlReady(machineId), { timeoutMs: 60_000, context: 'SSH-enrolled Machine Online and control ready' });
      await fixture.assertKnownGoodMachineControl(account, { target: { serverId: fixture.serverId, machineId } });
      const updatedAtMs = Date.now();
      const started = await account.executeAsPerson('session.spawn_new', {
        executionTarget: { serverId: fixture.serverId, machineId }, directory: { kind: 'path', path: workspace },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        permissionMode: 'read-only', approvalProfileId: null,
        configuration: { mode: { value: null, updatedAtMs }, model: { value: null, updatedAtMs, selectionSource: 'explicit' },
          permissionIntent: { value: 'read-only', updatedAtMs }, options: {} },
        connectedServices: { v: 2, bindingsByServiceId: {} }, terminal: { mode: 'plain' },
      });
      expect(started, 'Start through the production person Action must reach the SSH-enrolled daemon').toMatchObject({ ok: true });
      if (!started.ok) throw new Error(`SSH Session Start refused: ${started.errorCode}`);
      const session = SessionSpawnNewActionResultV1Schema.parse(started.result);
      expect(session, 'SSH Machine Session result').toMatchObject({ type: 'success' });
      if (session.type !== 'success') throw new Error(`SSH Session Start did not settle: ${session.type}`);
      sessionId = session.sessionId;
      expect(await account.readSessionMetadata(sessionId)).toMatchObject({ machineId, path: workspace });
    } catch (error) { failures.push(error); }
    finally {
      if (sessionId && ui) {
        try { expect(await ui.execute('session.stop', { sessionId })).toMatchObject({ ok: true }); }
        catch (error) { failures.push(error); }
      }
      // Keep failed enrollment evidence and its host intact for diagnosis. After
      // success, consume the daemon owner's lifecycle result: platforms without
      // a user service manager use the production process fallback.
      if (enrolled && remote) {
        try {
          const status = await remote.runHappierJson(['daemon', 'status', '--json']);
          if (!status || typeof status !== 'object' || !('daemon' in status)
            || !status.daemon || typeof status.daemon !== 'object' || !('serviceManaged' in status.daemon)) {
            throw new Error('SSH cleanup requires the daemon owner lifecycle status');
          }
          if (status.daemon.serviceManaged === false) {
            expect((await remote.runHappierText(['daemon', 'stop', '--json'])).status).toBe(0);
          } else {
            await remote.runHappierJson(['daemon', 'service', 'stop', '--json']);
          }
        }
        catch (error) { failures.push(error); }
      }
      try { await ui?.close(); } catch (error) { failures.push(error); }
      try { await fixture.stop(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, `SSH journey failed; artifacts: ${testDir}`);
  }, 0,
);
