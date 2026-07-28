import { appendFileSync, readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { AcpBackend } from '../AcpBackend';
import {
  AcpAuthenticationResolverPublicError,
  AcpAuthenticationStartupError,
} from '../AcpAuthentication';
import { createAcpBackend } from '../createAcpBackend';
import { writeAcpTestAgentScript } from '../testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';

type RecordedRequest = Readonly<{
  method: string;
  params?: unknown;
}>;

function readRequests(path: string): RecordedRequest[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RecordedRequest);
}

function writeFakeAcpAgentScript(params: {
  dir: string;
  requestLogPath: string;
  advertisedAuthMethods?: ReadonlyArray<Readonly<{ id: string }>>;
  initializeMeta?: Readonly<Record<string, unknown>>;
  initializeFailures?: number;
  requireAuthentication?: boolean;
}): string {
  const src = `
    import { appendFileSync } from 'node:fs';

    const requestLogPath = ${JSON.stringify(params.requestLogPath)};
    const advertisedAuthMethods = ${JSON.stringify(params.advertisedAuthMethods ?? [])};
    const initializeMeta = ${JSON.stringify(params.initializeMeta ?? null)};
    let initializeFailuresRemaining = ${JSON.stringify(params.initializeFailures ?? 0)};
    const requireAuthentication = ${JSON.stringify(params.requireAuthentication ?? false)};
    let authenticated = false;
    const decoder = new TextDecoder();
    let buf = '';

    function send(obj) {
      process.stdout.write(JSON.stringify(obj) + '\\n');
    }

    function respondOk(id, result) {
      send({ jsonrpc: '2.0', id, result });
    }

    function respondErr(id, message) {
      send({ jsonrpc: '2.0', id, error: { code: -32000, message } });
    }

    process.stdin.on('data', (chunk) => {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split('\\n');
      buf = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let req;
        try {
          req = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (!req || typeof req !== 'object') continue;

        const id = req.id;
        const method = req.method;
        if (id === undefined || id === null || typeof method !== 'string') continue;
        appendFileSync(requestLogPath, JSON.stringify({ method, params: req.params }) + '\\n', 'utf8');

        if (method === 'initialize') {
          if (initializeFailuresRemaining > 0) {
            initializeFailuresRemaining -= 1;
            respondErr(id, 'retry initialize');
            continue;
          }
          respondOk(id, {
            protocolVersion: 1,
            authMethods: advertisedAuthMethods.map(({ id: methodId }) => ({ id: methodId, name: methodId })),
            ...(initializeMeta ? { _meta: initializeMeta } : {}),
          });
          continue;
        }

        if (method === 'authenticate') {
          authenticated = true;
          respondOk(id, {});
          continue;
        }

        if (method === 'session/new') {
          if (requireAuthentication && !authenticated) {
            respondErr(id, 'auth required');
            continue;
          }
          respondOk(id, { sessionId: 'test-session' });
          continue;
        }

        if (method === 'session/load') {
          if (requireAuthentication && !authenticated) {
            respondErr(id, 'auth required');
            continue;
          }
          respondOk(id, {});
          continue;
        }

        respondOk(id, {});
      }
    });
  `;

  return writeAcpTestAgentScript({
    dir: params.dir,
    fileName: 'fake-acp-agent.mjs',
    source: src,
  });
}

describe('AcpBackend authentication', () => {
  it('preserves static authentication and metadata before a new session', async () => {
    await withTempDir('happier-acp-auth-', async (dir) => {
      const requestLogPath = `${dir}/requests.jsonl`;
      appendFileSync(requestLogPath, '', 'utf8');
      const scriptPath = writeFakeAcpAgentScript({
        dir,
        requestLogPath,
        advertisedAuthMethods: [{ id: 'openai-api-key' }],
        requireAuthentication: true,
      });

      const backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
        authentication: {
          kind: 'static',
          methodId: 'openai-api-key',
          meta: { headless: true },
        },
      });

      try {
        await expect(backend.startSession()).resolves.toEqual({ sessionId: 'test-session' });
        expect(readRequests(requestLogPath)).toEqual([
          expect.objectContaining({ method: 'initialize' }),
          { method: 'authenticate', params: { methodId: 'openai-api-key', _meta: { headless: true } } },
          expect.objectContaining({ method: 'session/new' }),
        ]);
      } finally {
        await backend.dispose();
      }
    });
  }, 20_000);

  it('resolves once after initialize from normalized advertised method ids and authenticates before load', async () => {
    await withTempDir('happier-acp-resolved-auth-', async (dir) => {
      const requestLogPath = `${dir}/requests.jsonl`;
      appendFileSync(requestLogPath, '', 'utf8');
      const scriptPath = writeFakeAcpAgentScript({
        dir,
        requestLogPath,
        advertisedAuthMethods: [
          { id: ' first ' },
          { id: '' },
          { id: 'selected' },
          { id: 'selected' },
        ],
        initializeMeta: { defaultAuthMethodId: null, providerFact: 'forwarded' },
        requireAuthentication: true,
      });
      const resolve = vi.fn((context: Readonly<{
        advertisedMethodIds: ReadonlySet<string>;
        initializeMeta: Readonly<Record<string, unknown>> | null;
      }>) => {
        const { advertisedMethodIds, initializeMeta } = context;
        expect([...advertisedMethodIds]).toEqual(['first', 'selected']);
        expect(initializeMeta).toEqual({ defaultAuthMethodId: null, providerFact: 'forwarded' });
        expect(Object.isFrozen(initializeMeta)).toBe(true);
        expect(readRequests(requestLogPath).map(({ method }) => method)).toEqual(['initialize']);
        return { methodId: ' selected ', meta: { headless: true } } as const;
      });

      const backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
        authentication: { kind: 'resolve-after-initialize', resolve },
      });

      try {
        await expect(backend.loadSession('existing-session')).resolves.toEqual({ sessionId: 'existing-session' });
        expect(resolve).toHaveBeenCalledTimes(1);
        expect(readRequests(requestLogPath).map(({ method }) => method)).toEqual([
          'initialize',
          'authenticate',
          'session/load',
        ]);
      } finally {
        await backend.dispose();
      }
    });
  }, 20_000);

  it('does not authenticate when authentication is absent', async () => {
    await withTempDir('happier-acp-no-auth-', async (dir) => {
      const requestLogPath = `${dir}/requests.jsonl`;
      appendFileSync(requestLogPath, '', 'utf8');
      const scriptPath = writeFakeAcpAgentScript({ dir, requestLogPath });
      const backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
      });

      try {
        await expect(backend.startSession()).resolves.toEqual({ sessionId: 'test-session' });
        expect(readRequests(requestLogPath).map(({ method }) => method)).toEqual(['initialize', 'session/new']);
      } finally {
        await backend.dispose();
      }
    });
  }, 20_000);

  it('resolves only after the final successful initialize retry', async () => {
    await withTempDir('happier-acp-retried-auth-', async (dir) => {
      const requestLogPath = `${dir}/requests.jsonl`;
      appendFileSync(requestLogPath, '', 'utf8');
      const scriptPath = writeFakeAcpAgentScript({
        dir,
        requestLogPath,
        advertisedAuthMethods: [{ id: 'selected' }],
        initializeFailures: 1,
        requireAuthentication: true,
      });
      const resolve = vi.fn(() => ({ methodId: 'selected' }));
      const backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
        authentication: { kind: 'resolve-after-initialize', resolve },
      });

      try {
        await expect(backend.startSession()).resolves.toEqual({ sessionId: 'test-session' });
        expect(resolve).toHaveBeenCalledTimes(1);
        expect(readRequests(requestLogPath).map(({ method }) => method)).toEqual([
          'initialize',
          'initialize',
          'authenticate',
          'session/new',
        ]);
      } finally {
        await backend.dispose();
      }
    });
  }, 20_000);

  it('reports an unadvertised static method as a typed startup failure before session open', async () => {
    await withTempDir('happier-acp-static-auth-failure-', async (dir) => {
      const requestLogPath = `${dir}/requests.jsonl`;
      appendFileSync(requestLogPath, '', 'utf8');
      const scriptPath = writeFakeAcpAgentScript({
        dir,
        requestLogPath,
        advertisedAuthMethods: [{ id: 'advertised' }],
      });
      const backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
        authentication: { kind: 'static', methodId: 'missing' },
      });

      try {
        await expect(backend.startSession()).rejects.toMatchObject({
          code: 'ACP_AUTHENTICATION_METHOD_NOT_ADVERTISED',
        });
        expect(readRequests(requestLogPath).map(({ method }) => method)).toEqual(['initialize']);
      } finally {
        await backend.dispose();
      }
    });
  }, 20_000);

  it.each([
    {
      name: 'empty method id',
      resolve: () => ({ methodId: '   ' }),
      expectedCode: 'ACP_AUTHENTICATION_METHOD_INVALID',
    },
    {
      name: 'unadvertised method id',
      resolve: () => ({ methodId: 'missing' }),
      expectedCode: 'ACP_AUTHENTICATION_METHOD_NOT_ADVERTISED',
    },
    {
      name: 'resolver failure',
      resolve: () => {
        throw new Error('secret-value-must-not-leak');
      },
      expectedCode: 'ACP_AUTHENTICATION_RESOLUTION_FAILED',
    },
  ] as const)('fails closed with a typed non-secret startup error for $name', async ({ resolve, expectedCode }) => {
    await withTempDir('happier-acp-invalid-auth-', async (dir) => {
      const requestLogPath = `${dir}/requests.jsonl`;
      appendFileSync(requestLogPath, '', 'utf8');
      const scriptPath = writeFakeAcpAgentScript({
        dir,
        requestLogPath,
        advertisedAuthMethods: [{ id: 'advertised' }],
      });
      const backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
        authentication: { kind: 'resolve-after-initialize', resolve },
      });

      try {
        const error = await backend.startSession().catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(AcpAuthenticationStartupError);
        expect(error).toMatchObject({ code: expectedCode });
        expect(String(error)).not.toContain('secret-value-must-not-leak');
        expect(error instanceof Error ? error.message : '').not.toContain('secret-value-must-not-leak');
        expect(error instanceof Error ? error.stack : '').not.toContain('secret-value-must-not-leak');
        expect(JSON.stringify(error)).not.toContain('secret-value-must-not-leak');
        expect(readRequests(requestLogPath).map(({ method }) => method)).toEqual(['initialize']);
      } finally {
        await backend.dispose();
      }
    });
  }, 20_000);

  it('rejects malformed public recovery declarations without exposing their values', async () => {
    await withTempDir('happier-acp-invalid-public-auth-recovery-', async (dir) => {
      const requestLogPath = `${dir}/requests.jsonl`;
      appendFileSync(requestLogPath, '', 'utf8');
      const scriptPath = writeFakeAcpAgentScript({
        dir,
        requestLogPath,
        advertisedAuthMethods: [{ id: 'advertised' }],
      });
      const backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
        authentication: {
          kind: 'resolve-after-initialize',
          resolve: () => {
            throw new AcpAuthenticationResolverPublicError({
              code: 'secret-value-must-not-leak',
              safePublicMessage: 'secret-value-must-not-leak',
            });
          },
        },
      });

      try {
        const error = await backend.startSession().catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(AcpAuthenticationStartupError);
        expect(error).toMatchObject({ code: 'ACP_AUTHENTICATION_RESOLUTION_FAILED' });
        expect(String(error)).not.toContain('secret-value-must-not-leak');
        expect(error instanceof Error ? error.stack : '').not.toContain('secret-value-must-not-leak');
        expect(JSON.stringify(error)).not.toContain('secret-value-must-not-leak');
        expect(readRequests(requestLogPath).map(({ method }) => method)).toEqual(['initialize']);
      } finally {
        await backend.dispose();
      }
    });
  }, 20_000);

  it('preserves only an explicitly public resolver recovery error and its fixed guidance', async () => {
    await withTempDir('happier-acp-public-auth-recovery-', async (dir) => {
      const requestLogPath = `${dir}/requests.jsonl`;
      appendFileSync(requestLogPath, '', 'utf8');
      const scriptPath = writeFakeAcpAgentScript({
        dir,
        requestLogPath,
        advertisedAuthMethods: [{ id: 'advertised' }],
      });
      const backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
        authentication: {
          kind: 'resolve-after-initialize',
          resolve: () => {
            throw new AcpAuthenticationResolverPublicError({
              code: 'TEST_AUTHENTICATION_UNAVAILABLE',
              safePublicMessage: 'Sign in with the provider CLI, then retry.',
            });
          },
        },
      });

      try {
        const error = await backend.startSession().catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(AcpAuthenticationResolverPublicError);
        expect(error).toMatchObject({
          code: 'TEST_AUTHENTICATION_UNAVAILABLE',
          message: 'Sign in with the provider CLI, then retry.',
          safePublicMessage: 'Sign in with the provider CLI, then retry.',
        });
        expect(readRequests(requestLogPath).map(({ method }) => method)).toEqual(['initialize']);
      } finally {
        await backend.dispose();
      }
    });
  }, 20_000);

  it('revalidates against an authoritative advertised set even if a resolver mutates its view', async () => {
    await withTempDir('happier-acp-mutating-auth-', async (dir) => {
      const requestLogPath = `${dir}/requests.jsonl`;
      appendFileSync(requestLogPath, '', 'utf8');
      const scriptPath = writeFakeAcpAgentScript({
        dir,
        requestLogPath,
        advertisedAuthMethods: [{ id: 'advertised' }],
      });
      const backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
        authentication: {
          kind: 'resolve-after-initialize',
          resolve: ({ advertisedMethodIds }) => {
            // A provider bug cannot widen the agent's authoritative initialize response.
            (advertisedMethodIds as Set<string>).add('injected');
            return { methodId: 'injected' };
          },
        },
      });

      try {
        await expect(backend.startSession()).rejects.toMatchObject({
          code: 'ACP_AUTHENTICATION_METHOD_NOT_ADVERTISED',
        });
        expect(readRequests(requestLogPath).map(({ method }) => method)).toEqual(['initialize']);
      } finally {
        await backend.dispose();
      }
    });
  }, 20_000);

  it('forwards resolved authentication through createAcpBackend', async () => {
    await withTempDir('happier-acp-factory-auth-', async (dir) => {
      const requestLogPath = `${dir}/requests.jsonl`;
      appendFileSync(requestLogPath, '', 'utf8');
      const scriptPath = writeFakeAcpAgentScript({
        dir,
        requestLogPath,
        advertisedAuthMethods: [{ id: 'factory-auth' }],
        requireAuthentication: true,
      });
      const backend = createAcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
        authentication: {
          kind: 'resolve-after-initialize',
          resolve: ({ advertisedMethodIds }) => ({
            methodId: advertisedMethodIds.has('factory-auth') ? 'factory-auth' : 'missing',
          }),
        },
      });

      try {
        await expect(backend.startSession()).resolves.toEqual({ sessionId: 'test-session' });
        expect(readRequests(requestLogPath).map(({ method }) => method)).toEqual([
          'initialize',
          'authenticate',
          'session/new',
        ]);
      } finally {
        await backend.dispose();
      }
    });
  }, 20_000);
});
