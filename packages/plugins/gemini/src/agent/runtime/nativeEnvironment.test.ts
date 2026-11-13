import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentSessionOpenRequest, AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { createGeminiAgentRuntime } from './factory.js';

// Simulate Windows environment identity on Unix without executing Windows ACL
// tools. Only the secure-temp OS adapter is replaced; policy reads stay real.
vi.mock('@happier-dev/plugin-sdk/fs', async importOriginal => ({
  ...await importOriginal<typeof import('@happier-dev/plugin-sdk/fs')>(),
  createSecureTempDirectorySync: ({ prefix }: { prefix: string }) => {
    const path = mkdtempSync(join(tmpdir(), `${prefix}-`));
    return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
  },
}));

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function boundary() {
  const run = vi.fn(async (_request: Parameters<AgentSessionRuntimeContext['services']['exec']['run']>[0]) => ({
    termination: { observed: { kind: 'exit' as const, exitCode: 0 }, requestedBy: { kind: 'none' as const } },
    stdout: new TextEncoder().encode('--acp'), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false,
  }));
  const open = vi.fn(async () => ({ send: vi.fn(), watch: () => ({ dispose() {} }), dispose() {} }));
  return { run, open, context: { signal: new AbortController().signal,
    services: { exec: { run, readEnvironment: () => ({}) } }, protocols: { acp: { open } },
  } as unknown as AgentSessionRuntimeContext };
}

async function runtimeWithHome(platform: NodeJS.Platform) {
  const home = mkdtempSync(join(tmpdir(), 'gemini-native-env-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
  cleanups.push(() => { Object.defineProperty(process, 'platform', descriptor); });
  const runtime = await createGeminiAgentRuntime({ plugin: { id: 'happier.agent.gemini', version: '0.0.0' },
    agent: { id: 'gemini' }, signal: new AbortController().signal });
  return { runtime, home };
}

describe('Gemini native environment at the factory boundary', () => {
  it('reports a missing host environment operation without reading the physical process', async () => {
    const { runtime, home } = await runtimeWithHome('linux');
    const io = boundary();
    await expect(runtime.sessions.open({ kind: 'create', sessionId: 'missing-host-environment', cwd: home }, {
      ...io.context, services: { ...io.context.services, exec: { ...io.context.services.exec, readEnvironment: undefined } },
    })).rejects.toMatchObject({ code: 'plugin_service_unavailable' });
    expect(io.run).not.toHaveBeenCalled();
    expect(io.open).not.toHaveBeenCalled();
  });

  it('uses the Windows winning selector for the ACP probe, not an earlier uppercase value', async () => {
    const { runtime, home } = await runtimeWithHome('win32');
    const safe = 'C:\\native\\safe.json';
    const conflicting = 'C:\\native\\conflicting.json';
    const io = boundary();
    const request: AgentSessionOpenRequest = { kind: 'create', sessionId: 'env-windows', cwd: home,
      launchEnvironment: { values: { HOME: home, GEMINI_API_KEY: 'fixture',
        GEMINI_CLI_SYSTEM_DEFAULTS_PATH: join(home, 'defaults.json'),
        GEMINI_CLI_SYSTEM_SETTINGS_PATH: safe, gemini_cli_system_settings_path: conflicting }, unset: [] },
    };
    const session = await runtime.sessions.open(request, io.context);
    cleanups.push(() => session.dispose());
    expect(io.run.mock.calls[0]?.[0].env).toHaveProperty('GEMINI_CLI_SYSTEM_SETTINGS_PATH', conflicting);
  });

  it('applies host case-insensitive unsets to the POSIX probe too', async () => {
    const { runtime, home } = await runtimeWithHome('linux');
    const io = boundary();
    const session = await runtime.sessions.open({ kind: 'create', sessionId: 'env-unset', cwd: home,
      launchEnvironment: { values: { HOME: home, GEMINI_API_KEY: 'fixture',
        GEMINI_CLI_SYSTEM_SETTINGS_PATH: join(home, 'policy.json') }, unset: ['gemini_cli_system_settings_path'] },
    }, io.context);
    cleanups.push(() => session.dispose());
    expect(io.run.mock.calls[0]?.[0].env).not.toHaveProperty('GEMINI_CLI_SYSTEM_SETTINGS_PATH');
  });
});
