import { existsSync, readFileSync, unlinkSync } from 'node:fs';

import type { AcpBackendSpecV1 } from '@happier-dev/plugin-sdk/acp';
import type { BackendEngineV1 } from '@happier-dev/plugin-sdk';
import { createAcpBackendEngine, readAcpBackendSpec } from '@happier-dev/plugin-sdk/acp';
import { describe, expect, it, vi } from 'vitest';

import { activate } from './activate.js';

type KimiBackendRegistration = Readonly<{
  backendId: string;
  create: (ctx: Readonly<{
    acp: Readonly<{
      defineAcpBackend: (spec: AcpBackendSpecV1) => BackendEngineV1;
    }>;
  }>) => BackendEngineV1 | Promise<BackendEngineV1>;
}>;

function readRegisteredBackend(registerBackendEngine: ReturnType<typeof vi.fn>): KimiBackendRegistration {
  const registration = registerBackendEngine.mock.calls[0]?.[0];
  if (!registration || typeof registration !== 'object') {
    throw new Error('Expected Kimi activation to register a backend engine');
  }
  return registration as KimiBackendRegistration;
}

async function readKimiSpec(): Promise<AcpBackendSpecV1> {
  const registerBackendEngine = vi.fn();
  activate({ registerBackendEngine });
  const registration = readRegisteredBackend(registerBackendEngine);
  const engine = await registration.create({
    acp: {
      defineAcpBackend: createAcpBackendEngine,
    },
  });
  return readAcpBackendSpec(engine);
}

describe('activate', () => {
  it('registers the Kimi ACP backend through the plugin API', async () => {
    const spec = await readKimiSpec();

    expect(spec).toMatchObject({
      backendId: 'kimi',
      transport: {
        kind: 'stdio',
        launch: {
          kind: 'agent-cli',
          agentId: 'kimi',
        },
      },
      sessionIdHeaderName: 'kimiSessionId',
      mcp: { policy: 'drop' },
      stderrRules: {
        statusErrors: expect.arrayContaining([
          expect.objectContaining({
            detail: 'Authentication error. Run `kimi login` to re-authenticate, then retry.',
          }),
        ]),
      },
    });
    expect(spec.transport.timeouts).toMatchObject({
      initMs: 90_000,
      toolCallMs: 120_000,
      toolKindTimeouts: {
        think: 30_000,
      },
    });
    expect(spec.callbacks?.argvBuilder).toBeTypeOf('function');
    expect(spec.callbacks?.envBuilder).toBeTypeOf('function');
  });

  it('preserves Kimi ordered argv and readonly agent-file callback behavior', async () => {
    const spec = await readKimiSpec();
    const buildArgv = spec.callbacks?.argvBuilder;
    let agentFilePath: string | undefined;

    expect(buildArgv).toBeTypeOf('function');
    try {
      const argv = await buildArgv?.({
        baseArgs: ['acp'],
        cwd: '/workspace',
        env: {},
        permissionMode: 'read-only',
      });

      expect(argv?.slice(0, 2)).toEqual(['--work-dir', '/workspace']);
      expect(argv?.at(-1)).toBe('acp');
      const agentFileIndex = argv?.indexOf('--agent-file') ?? -1;
      expect(agentFileIndex).toBeGreaterThan(-1);
      agentFilePath = argv?.[agentFileIndex + 1];
      expect(agentFilePath).toEqual(expect.stringContaining('happier-kimi-'));
      expect(existsSync(agentFilePath ?? '')).toBe(true);
      expect(readFileSync(agentFilePath ?? '', 'utf8')).toContain('kimi_cli.tools.shell:Shell');
    } finally {
      if (agentFilePath && existsSync(agentFilePath)) {
        unlinkSync(agentFilePath);
      }
    }
  });

  it('preserves Kimi yolo argv and Python selector env behavior', async () => {
    const spec = await readKimiSpec();
    const argv = await spec.callbacks?.argvBuilder?.({
      baseArgs: ['acp'],
      cwd: '/workspace',
      env: {},
      permissionMode: 'yolo',
    });
    const env = await spec.callbacks?.envBuilder?.({
      cwd: '/workspace',
      env: {
        HAPPIER_KIMI_ACP_SELECTOR: 'poll',
        PYTHONPATH: '/existing',
      },
    });

    expect(argv).toEqual(['--work-dir', '/workspace', '--yolo', 'acp']);
    if (process.platform === 'linux') {
      expect(env?.PYTHONPATH).toContain('kimi-acp-poll-selector');
      expect(env?.PYTHONPATH).toContain('/existing');
    } else {
      expect(env?.PYTHONPATH).toBe('/existing');
    }
  });
});
