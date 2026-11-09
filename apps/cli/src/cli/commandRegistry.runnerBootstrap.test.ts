import fastify from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PluginAvailabilityActionHttpPathsV1 } from '@happier-dev/protocol/plugins/availability';

import { reloadConfiguration } from '@/configuration';
import { prepareRunnerAgentSessionBootstrapForLease } from '@/daemon/spawn/prepareAgentRuntimeSessionBridge';
import { writeCredentialsTokenOnly } from '@/persistence';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { writeExecutableShim } from '@/testkit/fs/executableShim';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY } from '@/agent/runtime/session/process/agentRuntimeRunnerEnvironment';
import { ensureMergedAgentCommandRegistryLoaded, findCommandDispatchDescriptor } from './commandRegistry';
import { dispatchCli } from './dispatch';

describe('admitted runner command selection', () => {
  it('keeps the admitted Codex command when the child cannot perform Account admission', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-runner-command-'));
    const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_ACTIVE_SERVER_ID',
      'PATH', 'HAPPIER_SESSION_AUTOSTART_DAEMON', HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY]);
    env.patch({ HAPPIER_HOME_DIR: happyHomeDir, HAPPIER_SERVER_URL: 'http://runner-command.test', HAPPIER_LOCAL_SERVER_URL: undefined,
      HAPPIER_ACTIVE_SERVER_ID: 'runner-command' });
    reloadConfiguration();
    const runtime = await createAdmittedPluginRuntimeFixture({ happyHomeDir, runtimeOptions: { pluginIds: ['happier.agent.codex'] } });
    const bootstrap = await prepareRunnerAgentSessionBootstrapForLease({ target: { kind: 'backend', backendId: 'codex' }, lease: runtime.lease });
    if (!bootstrap) throw new Error('Admitted Codex bootstrap missing');
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
      await runtime.dispose();
      env.restore();
      reloadConfiguration();
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });
});
