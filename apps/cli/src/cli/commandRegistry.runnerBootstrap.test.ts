import fastify from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PluginAvailabilityActionHttpPathsV1 } from '@happier-dev/protocol/plugins/availability';
import { PluginAgentContributionV2Schema } from '@happier-dev/protocol';

import { configuration, reloadConfiguration } from '@/configuration';
import { createRunnerAgentSessionBootstrapAuthorization } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { writeCredentialsTokenOnly } from '@/persistence';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { writeExecutableShim } from '@/testkit/fs/executableShim';
import { acquireSessionRunnerLock } from '@/daemon/sessionRunnerLock';
import { logger } from '@/ui/logger';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY } from '@/agent/runtime/session/process/agentRuntimeRunnerEnvironment';
import { ensureMergedAgentCommandRegistryLoaded, findCommandDispatchDescriptor } from './commandRegistry';
import { dispatchCli } from './dispatch';
import { PLUGIN_MANIFEST as codexManifest } from '../../../../packages/plugins/codex/src/manifest';
import { PLUGIN_MANIFEST as ohMyPiManifest } from '../../../../packages/plugins/ohmypi/src/manifest';

function createRecordedAdmittedBootstrap(backendId: string, manifest: typeof codexManifest | typeof ohMyPiManifest) {
  // Bootstrap dispatch consumes an already-admitted descriptor. Supply that
  // boundary's recorded shape without exercising unrelated Account catalogs.
  const definition = PluginAgentContributionV2Schema.parse(manifest.contributes.agents?.[0]);
  return createRunnerAgentSessionBootstrapAuthorization({
    happyHomeDir: configuration.happyHomeDir,
    publicReleaseRing: configuration.publicReleaseRing,
    descriptor: {
      v: 1, pluginId: manifest.id, pluginVersion: manifest.version,
      agentId: definition.id, backendId, occurrenceId: 'recorded-admitted-runtime',
      sourceCustody: { kind: 'bundled_first_party', packagedRuntime: { kind: 'pinned_runner_snapshot', snapshotId: 'recorded-admitted-runtime' } },
      agentDeclaration: {
        provenance: 'first_party', source: { kind: 'bundled' },
        definition,
      },
    },
  });
}

describe('admitted runner command selection', () => {
  it.each([
    { backendId: 'ohMyPi', command: 'ohmypi', manifest: ohMyPiManifest },
    { backendId: 'codex', command: 'codex', manifest: codexManifest },
  ])('retains the admitted $backendId runtime when dispatching $command', async ({ backendId, command, manifest }) => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-runner-command-identity-'));
    const env = createEnvKeyScope(['HAPPIER_HOME_DIR', HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY]);
    env.patch({ HAPPIER_HOME_DIR: happyHomeDir });
    reloadConfiguration();
    const bootstrap = await createRecordedAdmittedBootstrap(backendId, manifest);
    const sessionId = 'already-running-command-identity';
    const lock = await acquireSessionRunnerLock({ sessionId });
    if (!lock.ok) throw new Error('Unable to establish the running Session fixture');
    const runnerExit = new Error('fixture-runner-exit');
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw runnerExit; });
    const presentation = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fatal = vi.spyOn(logger, 'fatal').mockImplementation(() => {});
    try {
      env.patch({ [HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY]: bootstrap.authorization.bootstrapFilePath });
      // The real bootstrap producer and strict reader feed the real
      // command registry and runner. The existing-session lock stops startup
      // before authentication or native Session creation at a real boundary.
      await expect(dispatchCli({
        args: [command, '--started-by', 'daemon', '--existing-session', sessionId],
        rawArgv: [], terminalRuntime: null,
      })).rejects.toBe(runnerExit);
      expect(presentation.mock.calls.flat().join(' ')).toContain('already running');
    } finally {
      exit.mockRestore();
      presentation.mockRestore();
      fatal.mockRestore();
      await lock.release();
      await bootstrap.cleanupBootstrapFile();
      env.restore();
      reloadConfiguration();
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });

  it('keeps the admitted Codex command when the child cannot perform Account admission', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-runner-command-'));
    const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_ACTIVE_SERVER_ID',
      'PATH', 'HAPPIER_SESSION_AUTOSTART_DAEMON', HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY]);
    env.patch({ HAPPIER_HOME_DIR: happyHomeDir, HAPPIER_SERVER_URL: 'http://runner-command.test', HAPPIER_LOCAL_SERVER_URL: undefined,
      HAPPIER_ACTIVE_SERVER_ID: 'runner-command' });
    reloadConfiguration();
    const bootstrap = await createRecordedAdmittedBootstrap('codex', codexManifest);
    const app = fastify();
    let accountAdmissions = 0;
    // Home authentication is the boundary: a Session runner cannot use the
    // present-user Account plugin endpoint. Its daemon already admitted it.
    app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'], async (_request, reply) => {
      accountAdmissions++;
      return reply.code(403).send({ error: 'credential_scope_denied' });
    });
    await app.ready();
    const restore = installAxiosFastifyAdapter({ app, origin: 'http://runner-command.test' });
    const runnerExit = new Error('fixture-runner-exit');
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw runnerExit; });
    try {
      await writeCredentialsTokenOnly({ token: 'fixture-session-runner' });
      await ensureMergedAgentCommandRegistryLoaded({ happyHomeDir, commandRoot: 'codex' });
      expect(findCommandDispatchDescriptor('codex')).toBeNull();
      expect(accountAdmissions).toBeGreaterThan(0);
      accountAdmissions = 0;
      const binaryDir = join(happyHomeDir, 'bin');
      await writeExecutableShim({ dir: binaryDir, fileName: process.platform === 'win32' ? 'codex.cmd' : 'codex',
        contents: process.platform === 'win32' ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n' });
      env.patch({ PATH: `${binaryDir}${delimiter}${process.env.PATH ?? ''}`, HAPPIER_SESSION_AUTOSTART_DAEMON: '0',
        [HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY]: bootstrap.authorization.bootstrapFilePath });
      // Version passthrough reaches a genuine OS executable without creating a
      // Session. Intercept only the final process exit so Vitest can observe it.
      await expect(dispatchCli({ args: ['codex', '--version', '--started-by', 'daemon'],
        rawArgv: [], terminalRuntime: null })).rejects.toBe(runnerExit);
      expect(exit).toHaveBeenCalledWith(0);
      expect(accountAdmissions).toBe(0);

      // The carrier projects one admitted Agent; it cannot select a different
      // command or discover more Agents through the child's Account credentials.
      await ensureMergedAgentCommandRegistryLoaded({ happyHomeDir, commandRoot: 'claude',
        runnerBootstrapFilePath: bootstrap.authorization.bootstrapFilePath });
      expect(findCommandDispatchDescriptor('claude')).toBeNull();
      expect(accountAdmissions).toBe(0);
    } finally {
      exit.mockRestore();
      restore();
      await app.close();
      await bootstrap.cleanupBootstrapFile();
      env.restore();
      reloadConfiguration();
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });
});
