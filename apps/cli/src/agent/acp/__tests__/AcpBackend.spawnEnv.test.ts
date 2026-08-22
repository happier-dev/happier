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
        CLAUDECODE: process.env.CLAUDECODE ?? null,
        HAPPIER_DAEMON_RUNTIME_ID: process.env.HAPPIER_DAEMON_RUNTIME_ID ?? null,
        HAPPIER_SESSION_PROFILE_ID: process.env.HAPPIER_SESSION_PROFILE_ID ?? null,
        HAPPIER_SESSION_ATTACH_FILE: process.env.HAPPIER_SESSION_ATTACH_FILE ?? null,
        HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: process.env.HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON ?? null,
        HAPPIER_PROVIDER_KEY: process.env.HAPPIER_PROVIDER_KEY ?? null,
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
  const envScope = createEnvKeyScope([
    'GEMINI_MODEL',
    'Gemini_Model',
    'gemini_model',
    preservedEnvKey,
    'CLAUDECODE',
    'HAPPIER_DAEMON_RUNTIME_ID',
    'HAPPIER_SESSION_PROFILE_ID',
    'HAPPIER_SESSION_ATTACH_FILE',
    'HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON',
    'HAPPIER_PROVIDER_KEY',
  ]);

  afterEach(() => {
    envScope.restore();
  });

  it('removes inherited unsetEnv keys case-insensitively while preserving explicit overrides', async () => {
    await withTempDir('happier-acp-spawn-env-', async (dir) => {
      envScope.patch({
        GEMINI_MODEL: 'inherited-upper',
        Gemini_Model: 'inherited-mixed',
        gemini_model: 'inherited-lower',
        CLAUDECODE: '1',
        HAPPIER_DAEMON_RUNTIME_ID: 'runtime-parent',
        HAPPIER_SESSION_PROFILE_ID: 'ambient-profile',
        HAPPIER_SESSION_ATTACH_FILE: '/tmp/ambient-attach.json',
        HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: 'ambient-selections',
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
            HAPPIER_SESSION_PROFILE_ID: 'plugin-spoof',
            HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: 'plugin-spoof',
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
          CLAUDECODE: null,
          HAPPIER_DAEMON_RUNTIME_ID: null,
          HAPPIER_SESSION_PROFILE_ID: null,
          HAPPIER_SESSION_ATTACH_FILE: null,
          HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: null,
          HAPPIER_PROVIDER_KEY: null,
        });
      } finally {
        await backendForCleanup?.dispose().catch(() => {});
      }
    });
  });

  it('substitutes the runner Provider marker only in the final ACP child environment', async () => {
    await withTempDir('happier-acp-provider-env-', async (dir) => {
      const placeholder =
        'happier_runner_placeholder_AAAAAAAAAAAAAAAAAAAAAAAAAAA';
      const capturePath = join(dir, 'env.json');
      const scriptPath = writeEnvCaptureAcpAgentScript({ dir });
      const transformAgentChildLaunchEnvironment = (
        environment: Readonly<Record<string, string>>,
      ) => Object.freeze({
        ...environment,
        HAPPIER_PROVIDER_KEY:
          environment.HAPPIER_PROVIDER_KEY === placeholder
            ? 'runner-owned-secret'
            : environment.HAPPIER_PROVIDER_KEY,
      });
      const backend = new AcpBackend({
        agentName: 'test-provider-child',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
        env: {
          HAPPIER_TEST_ENV_CAPTURE: capturePath,
          HAPPIER_PROVIDER_KEY: placeholder,
        },
        transformAgentChildLaunchEnvironment,
        transportHandler: createAcpTestTransportHandler({ idleTimeoutMs: 1 }),
      });
      try {
        await backend.startSession();
        expect(JSON.parse(readFileSync(capturePath, 'utf8')))
          .toMatchObject({
            HAPPIER_PROVIDER_KEY: 'runner-owned-secret',
          });
      } finally {
        await backend.dispose().catch(() => {});
      }
    });
  });
});
