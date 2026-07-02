import { afterEach, describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';

import { AcpBackend } from '../AcpBackend';
import { createAcpTestTransportHandler, writeAcpTestAgentScript } from '../testkit/subprocessHarness';

function writeEnvCaptureAcpAgentScript(params: { dir: string }): string {
  const preservedEnvKey = 'HAPPIER_ACP_ENV_PRESERVED_KEY';
  const src = `
    const { writeFileSync } = await import('node:fs');
    const capturePath = process.env.HAPPIER_TEST_ENV_CAPTURE;
    if (capturePath) {
      writeFileSync(capturePath, JSON.stringify({
        GEMINI_MODEL: process.env.GEMINI_MODEL ?? null,
        Gemini_Model: process.env.Gemini_Model ?? null,
        gemini_model: process.env.gemini_model ?? null,
        [${JSON.stringify(preservedEnvKey)}]: process.env[${JSON.stringify(preservedEnvKey)}] ?? null,
      }), 'utf8');
    }

    const decoder = new TextDecoder();
    let buf = '';

    function send(obj) {
      process.stdout.write(JSON.stringify(obj) + '\\n');
    }

    function ok(id, result) {
      send({ jsonrpc: '2.0', id, result });
    }

    process.stdin.on('data', (chunk) => {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split('\\n');
      buf = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let req;
        try { req = JSON.parse(trimmed); } catch { continue; }
        if (!req || typeof req !== 'object') continue;
        const id = req.id;
        const method = req.method;

        if (method === 'initialize') {
          ok(id, { protocolVersion: 1, authMethods: [] });
          continue;
        }

        if (method === 'session/new') {
          ok(id, { sessionId: 'test-session' });
          continue;
        }

        if (id !== undefined && id !== null && typeof method === 'string') {
          ok(id, {});
        }
      }
    });
  `;

  return writeAcpTestAgentScript({
    dir: params.dir,
    fileName: 'fake-acp-env-capture-agent.mjs',
    source: src,
  });
}

describe('AcpBackend spawn environment', () => {
  const preservedEnvKey = 'HAPPIER_ACP_ENV_PRESERVED_KEY';
  const envScope = createEnvKeyScope(['GEMINI_MODEL', 'Gemini_Model', 'gemini_model', preservedEnvKey]);

  afterEach(() => {
    envScope.restore();
  });

  it('removes inherited unsetEnv keys case-insensitively while preserving explicit overrides', async () => {
    await withTempDir('happier-acp-spawn-env-', async (dir) => {
      envScope.patch({
        GEMINI_MODEL: 'inherited-upper',
        Gemini_Model: 'inherited-mixed',
        gemini_model: 'inherited-lower',
      });
      const capturePath = join(dir, 'env.json');
      const scriptPath = writeEnvCaptureAcpAgentScript({ dir });
      let backendForCleanup: AcpBackend | undefined;

      try {
        const backendOptions = {
          agentName: 'test',
          cwd: dir,
          command: process.execPath,
          args: [scriptPath],
          env: {
            HAPPIER_TEST_ENV_CAPTURE: capturePath,
            Gemini_Model: 'explicit-mixed',
            gemini_model: 'explicit-lower',
            [preservedEnvKey]: 'preserved-explicit',
          },
          unsetEnv: ['GEMINI_MODEL'],
          transportHandler: createAcpTestTransportHandler({ idleTimeoutMs: 1 }),
        };
        const backend = new AcpBackend(backendOptions);
        backendForCleanup = backend;

        await backend.startSession();

        expect(JSON.parse(readFileSync(capturePath, 'utf8'))).toEqual({
          GEMINI_MODEL: null,
          Gemini_Model: 'explicit-mixed',
          gemini_model: 'explicit-lower',
          [preservedEnvKey]: 'preserved-explicit',
        });
      } finally {
        await backendForCleanup?.dispose().catch(() => {});
      }
    });
  });
});
