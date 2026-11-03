import { afterEach, describe, expect, it, vi } from 'vitest';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { logger } from '@/ui/logger';
import { createRunnerManagedProviderBindingLaunchEnvironmentTransformer } from '@/agent/runtime/session/process/runnerManagedProviderBindingMaterialization';
import type { AgentAcpProviderTurnSourceHost } from '@happier-dev/plugin-sdk/agents/runtime';

import { AcpBackend } from '../AcpBackend';
import { createAcpTestTransportHandler, writeAcpTestAgentScript } from '../testkit/subprocessHarness';

function writeEnvCaptureAcpAgentScript(params: { dir: string; captureEnvKeys?: readonly string[] }): string {
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
        CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT ?? null,
        HAPPIER_DAEMON_RUNTIME_ID: process.env.HAPPIER_DAEMON_RUNTIME_ID ?? null,
        HAPPIER_SESSION_PROFILE_ID: process.env.HAPPIER_SESSION_PROFILE_ID ?? null,
        HAPPIER_SESSION_ATTACH_FILE: process.env.HAPPIER_SESSION_ATTACH_FILE ?? null,
        HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: process.env.HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON ?? null,
        HAPPIER_PROVIDER_KEY: process.env.HAPPIER_PROVIDER_KEY ?? null,
        ...Object.fromEntries(${JSON.stringify(params.captureEnvKeys ?? [])}.map(name => [name, process.env[name] ?? null])),
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

function writeRejectedInitializeAcpAgentScript(params: { dir: string; secret: string }): string {
  return writeAcpTestAgentScript({
    dir: params.dir,
    fileName: 'rejected-initialize-acp-agent.mjs',
    source: `
      const readline = await import('node:readline');
      const lines = readline.createInterface({ input: process.stdin });
      lines.on('line', (line) => {
        const request = JSON.parse(line);
        if (request.method === 'initialize') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            error: { code: -32603, message: ${JSON.stringify(`provider rejected: ${params.secret}`)} },
          }) + '\\n');
        }
      });
    `,
  });
}

describe('AcpBackend spawn environment', () => {
  it('restores host ownership after provider environment replacement', async () => {
    const hostTag = 'v1.0123456789ab.session.session-host';
    vi.stubEnv('HAPPIER_PROCESS_OWNER', hostTag);
    try {
      await withTempDir('happier-acp-owner-', async dir => {
        const capturePath = join(dir, 'owner.txt');
        const script = writeAcpTestAgentScript({ dir, fileName: 'owner-agent.mjs', source: `
          const { writeFileSync } = await import('node:fs');
          writeFileSync(${JSON.stringify(capturePath)}, process.env.HAPPIER_PROCESS_OWNER || 'absent');
          const { createInterface } = await import('node:readline');
          createInterface({ input: process.stdin }).on('line', line => {
            const request = JSON.parse(line);
            if (request.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id:request.id, result:{ protocolVersion:1,authMethods:[] } }) + '\\n');
            if (request.method === 'session/new') process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id:request.id, result:{ sessionId:'test-session' } }) + '\\n');
          });
        ` });
        const backend = new AcpBackend({ agentName: 'test', cwd: dir, command: process.execPath, args: [script],
          env: { HAPPIER_PROCESS_OWNER: 'forged-plugin' }, unsetEnv: ['HAPPIER_PROCESS_OWNER'],
          transformAgentChildLaunchEnvironment: () => ({ HAPPIER_PROCESS_OWNER: 'forged-provider' }),
          transportHandler: createAcpTestTransportHandler({ idleTimeoutMs: 1 }),
        });
        try {
          await backend.startSession();
          expect(readFileSync(capturePath, 'utf8')).toBe(hostTag);
        } finally { await backend.dispose(); }
      });
    } finally { vi.unstubAllEnvs(); }
  });
  const preservedEnvKey = 'HAPPIER_ACP_ENV_PRESERVED_KEY';
  const envScope = createEnvKeyScope([
    'GEMINI_MODEL',
    'Gemini_Model',
    'gemini_model',
    preservedEnvKey,
    'CLAUDECODE',
    'CLAUDE_CODE_ENTRYPOINT',
    'HAPPIER_DAEMON_RUNTIME_ID',
    'HAPPIER_SESSION_PROFILE_ID',
    'HAPPIER_SESSION_ATTACH_FILE',
    'HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON',
    'HAPPIER_PROVIDER_KEY',
    'SOURCE_INHERITED',
    'SOURCE_UNSET',
    'SOURCE_EXPLICIT',
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
        CLAUDE_CODE_ENTRYPOINT: 'parent',
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
            CLAUDE_CODE_ENTRYPOINT: 'happier',
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
          CLAUDE_CODE_ENTRYPOINT: 'happier',
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

  it.each([false, true])('keeps the source marker-only while the real ACP child receives credentials (hostFinalizedLaunch=%s)', async hostFinalizedLaunch => {
    await withTempDir('happier-acp-provider-env-', async dir => {
      envScope.patch({ SOURCE_INHERITED: 'ambient', SOURCE_UNSET: 'drop', SOURCE_EXPLICIT: 'ambient' });
      const placeholder = 'happier_runner_placeholder_AAAAAAAAAAAAAAAAAAAAAAAAAAA';
      const credential = 'synthetic-runner-owned-secret';
      const capturePath = join(dir, 'env.json');
      const scriptPath = writeEnvCaptureAcpAgentScript({ dir,
        captureEnvKeys: ['HOME', 'SOURCE_INHERITED', 'SOURCE_UNSET', 'SOURCE_EXPLICIT', 'SOURCE_AUTHORIZATION'],
      });
      const transformer = createRunnerManagedProviderBindingLaunchEnvironmentTransformer({
        placeholder, credential, renderedPlaceholder: `Bearer ${placeholder}`, renderedCredential: `Bearer ${credential}`,
        isCurrent: () => true,
        materialization: { v: 1, kind: 'spawnEnv', env: [
          { name: 'HAPPIER_PROVIDER_KEY', value: placeholder, source: 'provider' },
          { name: 'SOURCE_AUTHORIZATION', value: `Bearer ${placeholder}`, source: 'provider' },
        ] },
      });
      let sourceHost: AgentAcpProviderTurnSourceHost | undefined;
      const backend = new AcpBackend({
        agentName: 'test-provider-child', cwd: dir, command: process.execPath, args: [scriptPath],
        env: {
          HOME: dir, HAPPIER_TEST_ENV_CAPTURE: capturePath, SOURCE_EXPLICIT: 'launch-override',
          ...Object.fromEntries(transformer.materialization.env.flatMap(entry => entry.value === null ? [] : [[entry.name, entry.value]])),
        },
        unsetEnv: ['source_unset'], ...(hostFinalizedLaunch ? { hostFinalizedLaunch: true as const } : {}),
        transformAgentChildLaunchEnvironment: transformer.transform,
        providerTurnSource: async host => {
          sourceHost = host;
          return { catchUp: async () => {}, dispose() {} };
        },
        providerTurnLifecycle: {
          registerContinuation: () => true, beginContinuation: () => true, releaseToolCalls() {}, dispose() {},
        },
        transportHandler: createAcpTestTransportHandler({ idleTimeoutMs: 1 }),
      });
      try {
        await backend.startSession();
        expect(JSON.parse(readFileSync(capturePath, 'utf8'))).toMatchObject({
          HOME: dir, SOURCE_INHERITED: hostFinalizedLaunch ? null : 'ambient', SOURCE_UNSET: null,
          SOURCE_EXPLICIT: 'launch-override', HAPPIER_PROVIDER_KEY: credential, SOURCE_AUTHORIZATION: `Bearer ${credential}`,
        });
        expect(sourceHost?.env).toMatchObject({
          HOME: dir, SOURCE_EXPLICIT: 'launch-override',
          HAPPIER_PROVIDER_KEY: placeholder, SOURCE_AUTHORIZATION: `Bearer ${placeholder}`,
        });
        expect(sourceHost?.env.SOURCE_INHERITED).toBe(hostFinalizedLaunch ? undefined : 'ambient');
        expect(sourceHost?.env).not.toHaveProperty('SOURCE_UNSET');
        expect(JSON.stringify(sourceHost?.env)).not.toContain(credential);
        expect(Object.isFrozen(sourceHost?.env)).toBe(true);
      } finally {
        await backend.dispose();
      }
      expect(sourceHost?.signal.aborted).toBe(true);
    });
  });

  it('does not log provider-controlled initialization failure contents during cleanup', async () => {
    await withTempDir('happier-acp-initialize-log-', async (dir) => {
      const secret = 'Bearer must-not-appear-in-acp-initialization-log';
      const scriptPath = writeRejectedInitializeAcpAgentScript({ dir, secret });
      const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
      const backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
      });

      try {
        await expect(backend.startSession()).rejects.toThrow('provider rejected:');
        const logged = debugSpy.mock.calls.flatMap((call) => call).map((value) => (
          value instanceof Error ? `${value.message}\n${value.stack ?? ''}` : JSON.stringify(value)
        )).join('\n');
        expect(logged).not.toContain(secret);
      } finally {
        await backend.dispose();
      }
    });
  }, 10_000);
});
