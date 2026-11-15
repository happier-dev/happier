import { existsSync, readFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';
import { createMessageBufferFixture, createSessionProviderInputConsumerFixture } from '@/testkit/backends/catalogAcpRuntime';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';
import { PI_BRIDGE_CONFIG_PATH_FLAG } from '@/backends/pi/bridgeExtension/piBridgeExtensionEnv';
import { resolvePiBridgeExtensionPath } from '@/backends/pi/bridgeExtension/piBridgeExtensionAssets';
import { buildPiBridgeExtensionSource } from '@/backends/pi/bridgeExtension/piBridgeExtensionSource';
import type { PiRpcChannelOpenSpec } from '@/backends/pi/rpc/piRpcChannel';
import { createPiSharedTerminalHost } from '@/backends/pi/sharedControl/piSharedTerminalHost';
import { PI_SHARED_CONTROL_PROTOCOL_VERSION, PiSharedControlConfigSchema } from '@/backends/pi/sharedControl/piSharedControlProtocol';

import { createPiAcpRuntime } from './runtime';

const credentials: Credentials = {
  token: 'test-token',
  encryption: { type: 'legacy', secret: new Uint8Array([1]) },
};

const tempDirs: string[] = [];
const sockets: Socket[] = [];
const envScope = createEnvKeyScope(['HAPPIER_PI_PATH', 'PI_CODING_AGENT_DIR', 'CI']);

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const dir of tempDirs.splice(0)) removeTempDirSync(dir);
  envScope.restore();
});

/**
 * Stands in for the interactive Pi plus its bridge extension: it reads the protected bridge config
 * the runner put in Pi's argv and dials the runner with that endpoint and token, as the bridge does
 * at `session_start`. Only the process launch is faked.
 */
function launchFakeInteractivePi(spec: PiRpcChannelOpenSpec) {
  const flagIndex = spec.args.indexOf(`--${PI_BRIDGE_CONFIG_PATH_FLAG}`);
  const configPath = spec.args[flagIndex + 1]!;
  const sessionConfig = JSON.parse(readFileSync(configPath, 'utf8')) as { sharedControl?: unknown };
  const sharedControl = PiSharedControlConfigSchema.parse(sessionConfig.sharedControl);
  const socket = connect(sharedControl.port, sharedControl.host);
  sockets.push(socket);
  const send = (value: unknown) => socket.write(`${JSON.stringify(value)}\n`);
  const reply = (command: { id: string; type: string }, data: unknown) => send({
    ch: 'out',
    line: JSON.stringify({ id: command.id, type: 'response', command: command.type, success: true, data }),
  });
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
      const command = JSON.parse(buffer.slice(0, index)) as { id: string; type: string };
      buffer = buffer.slice(index + 1);
      if (command.type === 'get_state') {
        reply(command, {
          sessionId: 'pi-terminal-session',
          sessionFile: null,
          isStreaming: false,
          isCompacting: false,
          thinkingLevel: 'medium',
          model: { id: 'model-1', provider: 'provider-1', name: 'Model 1' },
        });
      } else if (command.type === 'get_commands') {
        reply(command, { commands: [] });
      } else {
        reply(command, { sessionId: 'pi-terminal-session' });
      }
    }
  });
  socket.on('connect', () => send({
    type: 'hello',
    v: PI_SHARED_CONTROL_PROTOCOL_VERSION,
    token: sharedControl.token,
    sessionId: 'pi-terminal-session',
    sessionFile: null,
  }));
  return { configPath };
}

function startSharedRuntime() {
  const agentDir = createTempDirSync('happier-pi-shared-runtime-');
  const binDir = createTempDirSync('happier-pi-shared-bin-');
  tempDirs.push(agentDir, binDir);
  envScope.patch({
    PI_CODING_AGENT_DIR: agentDir,
    HAPPIER_PI_PATH: writeExecutableShimSync({
      dir: binDir,
      fileName: process.platform === 'win32' ? 'pi.cmd' : 'pi',
      contents: process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n',
    }),
  });
  delete process.env.CI;
  const launches: Array<{ spec: PiRpcChannelOpenSpec; configPath: string }> = [];
  let exitPi!: () => void;
  const host = createPiSharedTerminalHost({
    requestRunnerTermination: () => undefined,
    launch: async (spec) => {
      launches.push({ spec, ...launchFakeInteractivePi(spec) });
      return {
        whenExited: new Promise((resolve) => { exitPi = () => resolve({ code: 0, signal: null }); }),
        terminate: async () => exitPi(),
      };
    },
  });

  const runtime = createPiAcpRuntime({
    directory: agentDir,
    machineId: 'machine-1',
    session: Object.assign(createApiSessionClientFixture(), { sessionId: 'happy-session-shared' }),
    messageBuffer: createMessageBufferFixture(),
    mcpServers: {},
    permissionHandler: createApprovedPermissionHandler(),
    onThinkingChange() {},
    getPermissionMode: () => 'default',
    providerInputConsumer: createSessionProviderInputConsumerFixture(),
    credentials,
    accountSettings: {},
    sharedTerminal: host,
  });
  return { agentDir, launches, host, runtime };
}

function readExtensionPaths(args: readonly string[]): string[] {
  return args.flatMap((arg, index) => (arg === '--extension' ? [args[index + 1]!] : []));
}

describe('Pi ACP runtime in shared-terminal mode', () => {
  it('launches the native Pi terminal bound to the shared-control endpoint and adopts its session', async () => {
    const { launches, host, runtime } = startSharedRuntime();

    try {
      await runtime.startOrLoad({});

      expect(runtime.getSessionId()).toBe('pi-terminal-session');
      expect(launches).toHaveLength(1);
      expect(launches[0]!.spec.args).not.toContain('--mode');
      expect(launches[0]!.spec.env.CI).toBeUndefined();
      // Web input is delivered only while the terminal is idle.
      expect(runtime.supportsInFlightSteer()).toBe(false);

      // Resetting the runtime replaces the backend, never the user's terminal Pi.
      await runtime.reset();
      expect(existsSync(launches[0]!.configPath)).toBe(true);
    } finally {
      await host.dispose();
    }
    expect(existsSync(launches[0]!.configPath)).toBe(false);
  });

  // The shared bridge asset path is rewritten by any Happier version that starts a Pi session; a
  // `/reload` in the TUI re-reads its `--extension` path, so it must be this launch's own copy.
  it('loads a bridge copy owned by this launch, never the shared asset path, and removes it after Pi', async () => {
    const { agentDir, launches, host, runtime } = startSharedRuntime();
    let bridgePath: string | undefined;

    try {
      await runtime.startOrLoad({});

      const extensions = readExtensionPaths(launches[0]!.spec.args);
      expect(extensions).not.toContain(resolvePiBridgeExtensionPath(agentDir));
      expect(existsSync(resolvePiBridgeExtensionPath(agentDir))).toBe(false);
      bridgePath = extensions.find((path) => readFileSync(path, 'utf8') === buildPiBridgeExtensionSource());
      expect(bridgePath).toBeDefined();
    } finally {
      await host.dispose();
    }
    expect(existsSync(bridgePath!)).toBe(false);
  });
});
