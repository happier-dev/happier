// @happier-test-preparation source
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import { startStackDevTargets } from './supervisor.mjs';
import { resolveDevTargetMutagenRuntime } from './mutagen_runtime.mjs';
import {
  renderMutagenProject,
  resolveMutagenSessionName,
} from './mutagen_project.mjs';
import { prepareDevTargetOpenSsh } from './sync_project.mjs';
import { resolveRemoteStackStatePaths } from './remote_commands.mjs';
import { resolveDevTargetsConfigPath } from './config.mjs';
import { waitForServerReady } from '../server/server.mjs';
import { proveStackHomeIdentityTransition } from '../stack/server_profile_reconciliation.mjs';
import { applyStackActiveServerScopeEnv } from '../auth/stable_scope_id.mjs';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';

const execFileAsync = promisify(execFile);
const repoDir = fileURLToPath(new URL('../../../../../', import.meta.url));
const stackName = 'agent-qa-split';
const runtimeMode = 'source-snapshot';
const established = 'srv_shared_source';
const minted = 'srv_stack_own_minted';
const daemonHostServerUrl = 'http://127.0.0.1:43971';

const recordPathOn = (target) =>
  join(
    resolveRemoteStackStatePaths(target, { stackName, runtimeMode })
      .serverLightDataDir,
    'runtime',
    'server.identity',
  );

// The daemon host's CLI profile still names the Home it established before its stack's own
// server minted a private identity (2129113c152).
async function writeDaemonHostProfile(target) {
  const paths = resolveRemoteStackStatePaths(target, {
    stackName,
    runtimeMode,
  });
  const serverId = paths.activeServerId;
  await mkdir(join(paths.cliHomeDir, 'servers', serverId), { recursive: true });
  await writeFile(
    join(paths.cliHomeDir, 'servers', serverId, 'access.key'),
    JSON.stringify({ token: 'daemon-host-token' }),
  );
  await writeFile(
    join(paths.cliHomeDir, 'settings.json'),
    JSON.stringify({
      schemaVersion: 6,
      activeServerId: serverId,
      servers: {
        [serverId]: {
          id: serverId,
          serverUrl: daemonHostServerUrl,
          webappUrl: daemonHostServerUrl,
          homeConnectionDescriptor: {
            v: 1,
            homeServerIdentityId: established,
            revision: 4,
            canonicalServerUrl: daemonHostServerUrl,
            endpoints: [{ kind: 'https', url: daemonHostServerUrl }],
          },
        },
      },
    }),
  );
  return {
    serverId,
    env: {
      HAPPIER_STACK_STORAGE_DIR: paths.stackStorageDir,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_CLI_HOME_DIR: paths.cliHomeDir,
      HAPPIER_SERVER_LIGHT_DATA_DIR: paths.serverLightDataDir,
      HAPPIER_STACK_SHARED_DB_SOURCE_STACK: 'repo-dev',
    },
    cliHomeDir: paths.cliHomeDir,
  };
}

// RU2 #176 / agent-qa-providers (18-11): a shared-database stack whose server runs on nl3 and whose
// daemons run on nl1. The server writes its own Home identity record on nl3; the nl1 daemon runner's
// readiness reads the record on nl1, found none, and refused "does not match the established Home".
// SSH (remote command execution) is the mocked boundary: each remote command runs for real against
// that target's state directory; supervisor sequencing and the daemon host's readiness stay real.
for (const scenario of [
  'split',
  'split-old-revision',
  'co-located',
  'not-consumer',
]) {
  test(
    `split-host Home identity: ${scenario}`,
    { timeout: 20_000, skip: process.platform === 'win32' },
    async (t) => {
      const { root } = await createTempFixture(t, {
        prefix: 'hstack-split-home-identity-',
      });
      const targetNames = scenario === 'co-located' ? ['nl3'] : ['nl3', 'nl1'];
      const targets = targetNames.map((name) => ({
        name,
        platform: 'posix',
        ssh: `${name}-ssh`,
        repoDir, // the probe imports this checkout's own stack owners
        cliHomeDir: join(root, name, 'home'),
      }));
      const [serverTarget] = targets;
      const daemonTarget = targets.at(-1);
      for (const target of targets)
        await mkdir(
          resolveRemoteStackStatePaths(target, { stackName, runtimeMode })
            .stackBaseDir,
          { recursive: true },
        );
      const consumer = scenario !== 'not-consumer';
      // A server that predates 2129113c152 records nothing and keeps publishing the established Home.
      const mintsOwnIdentity = consumer && scenario !== 'split-old-revision';
      const served = mintsOwnIdentity ? minted : established;
      const daemonHost = await writeDaemonHostProfile(daemonTarget);
      if (!consumer) delete daemonHost.env.HAPPIER_STACK_SHARED_DB_SOURCE_STACK;

      const syncStackBaseDir = join(root, 'sync');
      const env = {
        HAPPIER_STACK_AUTH_FLOW: '1',
        HAPPIER_STACK_STORAGE_DIR: syncStackBaseDir,
        HAPPIER_STACK_STACK: stackName,
        ...(consumer
          ? {
              HAPPIER_STACK_SHARED_DB_SOURCE_STACK: 'repo-dev',
              HAPPIER_STACK_SHARED_DB_SOURCE_ENV_FILE: join(root, 'shared-db.env'),
            }
          : {}),
      };
      // The shared-database admission owner reads the stack's own server placement.
      const configPath = resolveDevTargetsConfigPath({ stackName, env, useExecutionOverride: false });
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(configPath, JSON.stringify({ version: 3, targets,
        runtimePlacement: { server: { mode: 'prefer-target', target: serverTarget.name, fallback: 'error' },
          daemon: { mode: 'prefer-target', target: daemonTarget.name, fallback: 'local' } } }));
      const runtime = resolveDevTargetMutagenRuntime({
        stackBaseDir: syncStackBaseDir,
        sourceDir: repoDir,
        env,
      });
      await mkdir(dirname(runtime.projectFile), { recursive: true });
      await writeFile(
        runtime.projectFile,
        renderMutagenProject({
          sourceDir: repoDir,
          targets,
          ownerId: 'producer',
        }),
      );
      await prepareDevTargetOpenSsh({
        targets,
        mutagenDir: runtime.mutagenDir,
        env,
      });

      const order = [];
      const recordCommands = [];
      let announceMinted;
      const serverMinted = new Promise((resolve) => {
        announceMinted = resolve;
      });
      let daemonHostReadiness = null;
      let settle;
      const settled = new Promise((resolve) => {
        settle = resolve;
      });
      const originalFetch = globalThis.fetch;
      t.mock.method(globalThis, 'fetch', async (url, options) =>
        String(url).startsWith(daemonHostServerUrl)
          ? Response.json({
              features: {},
              capabilities: { serverIdentity: { serverIdentityId: served } },
              homeConnectionDescriptor: {
                v: 1,
                homeServerIdentityId: served,
                revision: 5,
                canonicalServerUrl: daemonHostServerUrl,
                endpoints: [{ kind: 'https', url: daemonHostServerUrl }],
              },
            })
          : await originalFetch(url, options),
      );

      const controller = await startStackDevTargets(
        {
          stackName,
          stackBaseDir: join(root, 'consumer'),
          syncStackBaseDir,
          sourceDir: repoDir,
          sourceSnapshot: true,
          localServerPort: 3005,
          publicServerUrl: 'http://127.0.0.1:3005',
          canonicalServerUrl: 'http://happier-agent-qa-split.localhost:3005',
          remoteServerRuntimeConfig: {
            serverComponentName: 'happier-server-light',
            dbProvider: 'sqlite',
            environment: {},
          },
          targetPlans: targets.map((target) => ({
            target,
            services: {
              server: target === serverTarget,
              daemon: target === daemonTarget,
              expo: false,
            },
          })),
          onTargetStateChange: async (state) => {
            if (
              state.name === daemonTarget.name &&
              ['running', 'degraded', 'failed'].includes(state.status)
            )
              settle(state);
          },
          env,
        },
        {
          runProcess: async (input) => {
            const command = String(input.args?.at(-1) ?? '');
            if (
              input.command === 'ssh' &&
              command.includes('server.identity')
            ) {
              recordCommands.push(
                targets.find((target) => input.args.includes(target.ssh)).name,
              );
              const result = await execFileAsync('/bin/bash', ['-c', command]);
              return { code: 0, out: result.stdout };
            }
            if (
              input.command === 'ssh' &&
              command.includes('selectStackServicePort')
            )
              return { code: 0, out: JSON.stringify({ port: 3006 }) };
            if (
              input.command === 'ssh' &&
              command.includes('sourceRuntimeIdentities')
            ) {
              const result = await execFileAsync('/bin/bash', ['-c', command]);
              return { code: 0, out: result.stdout };
            }
            return {
              code: 0,
              out: JSON.stringify(
                targets.map((target) => ({
                  name: resolveMutagenSessionName(target.name, repoDir),
                  paused: false,
                  status: 'watching',
                  conflicts: [],
                  excludedConflicts: 0,
                  successfulCycles: 1,
                  alpha: { connected: true, scanned: true },
                  beta: { connected: true, scanned: true },
                })),
              ),
            };
          },
          runCommand: async () => ({
            code: 0,
            out: JSON.stringify({ retainedRemoteData: true }),
          }),
          spawnProcess: (input) => {
            const child = { ...input, pid: process.pid, exitCode: null };
            // SSH's forward confirmation is the transport boundary's own readiness event.
            if (input.command === 'ssh' && input.args.includes('-N')) {
              queueMicrotask(() => input.onLine?.({ stream: 'stderr', line: input.args.includes('-R')
                ? 'debug1: forwarding_success: all expected forwarding replies received'
                : 'debug1: Entering interactive session.' }));
              return child;
            }
            const command = String(input.args?.at(-1) ?? '');
            if (input.command !== 'ssh' || !command.includes('stack start'))
              return child;
            const target = targets.find((candidate) =>
              input.args.includes(candidate.ssh),
            );
            const paths = resolveRemoteStackStatePaths(target, {
              stackName,
              runtimeMode,
            });
            writeFileSync(
              join(paths.stackBaseDir, 'stack.runtime.json'),
              JSON.stringify({
                sourceRuntimeIdentities: Object.fromEntries(
                  ['server', 'daemon']
                    .filter(
                      (component) =>
                        command.includes(
                          component === 'server'
                            ? '--no-server'
                            : '--no-daemon',
                        ) === false,
                    )
                    .map((component) => [
                      component,
                      {
                        selected: `${target.name}-${component}`,
                        loaded: `${target.name}-${component}`,
                      },
                    ]),
                ),
                ...(target === serverTarget
                  ? { sourceUi: 'export', sourceUiLaunch: { uiDir: join(root, 'server-export', 'ui') } }
                  : {}),
              }),
            );
            if (target === serverTarget) {
              order.push(`${target.name}:server-start`);
              // The server mints and records its own identity during startup, then serves.
              if (mintsOwnIdentity) {
                const recordPath = recordPathOn(serverTarget);
                mkdir(dirname(recordPath), { recursive: true })
                  .then(() => writeFile(recordPath, `${minted}\n`))
                  .then(announceMinted);
              } else announceMinted();
            }
            if (target === daemonTarget) {
              order.push(`${target.name}:daemon-start`);
              // The daemon host's runner: the real readiness owner against its own state directory.
              // A co-located runner waits for the server it started before its daemon reads the record.
              daemonHostReadiness = (target === serverTarget ? serverMinted : Promise.resolve()).then(() => waitForServerReady(daemonHostServerUrl, {
                env: daemonHost.env,
                cliHomeDir: daemonHost.cliHomeDir,
                serverId: daemonHost.serverId,
                intervalMs: 0,
                timeoutMs: 2_000,
              })).then(
                (value) => ({ value }),
                (error) => ({ error }),
              );
            }
            return child;
          },
          stopProcess: async (child) => {
            child.exitCode = 0;
          },
          waitForProcess: async () => await new Promise(() => {}),
          waitForServerReady: async () => {
            await serverMinted;
            order.push('server-ready');
          },
          waitForDaemonReady: async () => {
            const { error } = await daemonHostReadiness;
            if (error) throw error;
          },
          waitForRetry: async () => await new Promise(() => {}),
          logger: { error() {}, info() {} },
        },
      );
      try {
        const state = await settled;
        const { value, error } = await daemonHostReadiness;
        assert.equal(
          error,
          undefined,
          `daemon host readiness: ${error?.message}`,
        );
        assert.equal(state.status, 'running');
        const daemonRecordPath = recordPathOn(daemonTarget);
        if (scenario === 'split') {
          assert.deepEqual(
            value,
            { status: 'ready', homeIdentityRecordPath: daemonRecordPath },
            "the daemon host admits its own server's recorded identity and hands its local record to the CLI",
          );
          assert.equal(readFileSync(daemonRecordPath, 'utf8').trim(), minted);
          assert.ok(
            order.indexOf('server-ready') <
              order.indexOf(`${daemonTarget.name}:daemon-start`),
            'the daemon worker starts after its server minted and served its identity',
          );
          // A later `stack daemon <stack> start --identity=<name>` runs on the daemon host long after
          // the reload: that identity's own reconciliation reads the copy the reload left there.
          const paths = resolveRemoteStackStatePaths(daemonTarget, { stackName, runtimeMode });
          const named = applyStackActiveServerScopeEnv({ env: daemonHost.env, stackName, cliIdentity: 'qa-b' });
          const namedHome = join(paths.stackBaseDir, 'cli-identities', 'qa-b');
          const namedServerId = named.HAPPIER_ACTIVE_SERVER_ID;
          await mkdir(join(namedHome, 'servers', namedServerId), { recursive: true });
          await writeFile(join(namedHome, 'servers', namedServerId, 'access.key'), JSON.stringify({ token: 'named-token' }));
          await writeFile(join(namedHome, 'settings.json'), JSON.stringify({ schemaVersion: 6, activeServerId: namedServerId,
            servers: { [namedServerId]: { id: namedServerId, serverUrl: daemonHostServerUrl, webappUrl: daemonHostServerUrl,
              homeConnectionDescriptor: { v: 1, homeServerIdentityId: established, revision: 4,
                canonicalServerUrl: daemonHostServerUrl, endpoints: [{ kind: 'https', url: daemonHostServerUrl }] } } } }));
          assert.equal(await proveStackHomeIdentityTransition({ env: named, cliHomeDir: namedHome, serverId: namedServerId,
            serverUrl: daemonHostServerUrl, timeoutMs: 2_000 }), daemonRecordPath);
        } else if (scenario === 'co-located') {
          // A single-host stack reads the record its own server wrote beside it, exactly as before.
          assert.deepEqual(value, { status: 'ready', homeIdentityRecordPath: daemonRecordPath });
        } else {
          assert.deepEqual(value, { status: 'ready' });
        }
        if (scenario === 'split-old-revision')
          assert.equal(
            existsSync(daemonRecordPath),
            false,
            'no record is invented',
          );
        if (scenario === 'co-located' || scenario === 'not-consumer') {
          assert.deepEqual(
            recordCommands,
            [],
            'a single-host or non-consumer stack carries nothing',
          );
        }
      } finally {
        await controller.close();
      }
    },
  );
}
