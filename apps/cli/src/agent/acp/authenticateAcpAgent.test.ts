import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { authenticateAcpAgent } from './authenticateAcpAgent';
import { writeAcpTestAgentScript } from './testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';
import { isPidAlive } from '@/testkit/process/spawn';

// Genuine OS enumeration boundary; the ACP transport and cleanup owner remain real.
const enumeration = vi.hoisted(() => ({
  denied: false,
  deferStderr: false,
  pendingStderr: [] as import('node:stream').Readable[],
}));
// Independent OS pipes can deliver the successful ACP response before stderr.
vi.mock('cross-spawn', async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof import('cross-spawn') }>();
  return { default: (...args: Parameters<typeof actual.default>) => {
    const child = actual.default(...args);
    if (enumeration.deferStderr && child.stderr) {
      child.stderr.pause();
      enumeration.pendingStderr.push(child.stderr);
    }
    return child;
  } };
});
vi.mock('ps-list', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ps-list')>();
  return { default: () => {
    enumeration.pendingStderr.splice(0).forEach((stream) => stream.resume());
    if (enumeration.denied) return Promise.reject(new Error('process listing unavailable'));
    return actual.default();
  } };
});
afterEach(() => {
  enumeration.denied = false;
  enumeration.deferStderr = false;
  enumeration.pendingStderr.splice(0).forEach((stream) => stream.resume());
});

function fixture(dir: string, behavior: 'success' | 'reject' | 'wait' = 'success') {
  // External ACP boundary: the pinned AGY 1.1.1 server persists auth.type only
  // after authenticate succeeds. Login must never create a session or send a prompt.
  const script = writeAcpTestAgentScript({
    dir,
    fileName: 'auth-agent.mjs',
    source: `
      import { writeFileSync } from 'node:fs';
      import { createInterface } from 'node:readline';
      writeFileSync('pid', String(process.pid));
      const reply = (id, result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0', id, result}) + '\\n');
      createInterface({input:process.stdin}).on('line', line => {
        const request = JSON.parse(line);
        if (request.method === 'initialize') {
          reply(request.id, {protocolVersion:1, authMethods:[{id:'oauth-personal',name:'Google'}, {id:'gemini-api-key',name:'API key'}]});
        } else if (request.method === 'authenticate') {
          if (${JSON.stringify(behavior)} === 'reject') {
            process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32602,message:'Missing API key'}}) + '\\n');
            return;
          }
          process.stderr.write('Open the following link to authenticate the ACP server: https://accounts.google.com/example\\n');
          if (${JSON.stringify(behavior)} === 'wait') return;
          writeFileSync(process.env.AUTH_STATE_PATH, JSON.stringify({auth:{type:request.params.methodId}}));
          reply(request.id, {});
        } else {
          writeFileSync('unexpected-session-operation', request.method);
          process.exit(1);
        }
      });
    `,
  });
  return {
    command: process.execPath,
    args: [script],
    cwd: dir,
    env: { ...process.env, AUTH_STATE_PATH: join(dir, 'settings.json') },
    agentName: 'agy',
    methodId: 'oauth-personal',
    onStderr: (_text: string) => {},
  };
}

function expectProviderStopped(dir: string) {
  const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'));
  expect(isPidAlive(pid)).toBe(false);
  expect(existsSync(join(dir, 'unexpected-session-operation'))).toBe(false);
}

describe('ACP login', () => {
  it('preserves provider rejection alongside an unverified cleanup failure', async () => {
    await withTempDir('happier-acp-login-cleanup-', async (dir) => {
      enumeration.denied = true;
      await expect(authenticateAcpAgent({ ...fixture(dir, 'reject'), methodId: 'gemini-api-key' })).rejects.toMatchObject({
        name: 'AggregateError',
        errors: [
          { code: -32602 },
          { code: 'process_tree_termination_incomplete' },
        ],
      });
      expect(existsSync(join(dir, 'settings.json'))).toBe(false);
      expectProviderStopped(dir);
    });
  });

  it('finishes authentication, surfaces the browser link, and leaves persistence to the provider', async () => {
    await withTempDir('happier-acp-login-', async (dir) => {
      enumeration.deferStderr = true;
      let output = '';
      await authenticateAcpAgent({ ...fixture(dir), onStderr: (text) => { output += text; } });
      expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))).toEqual({ auth: { type: 'oauth-personal' } });
      expect(output).toContain('https://accounts.google.com/example');
      expectProviderStopped(dir);
    });
  });

  it('surfaces provider rejection and does not save a successful login', async () => {
    await withTempDir('happier-acp-login-rejected-', async (dir) => {
      await expect(authenticateAcpAgent({ ...fixture(dir, 'reject'), methodId: 'gemini-api-key' })).rejects.toMatchObject({ code: -32602 });
      expect(existsSync(join(dir, 'settings.json'))).toBe(false);
      expectProviderStopped(dir);
    });
  });

  it('rejects an unadvertised method before trying to authenticate', async () => {
    await withTempDir('happier-acp-login-method-', async (dir) => {
      await expect(authenticateAcpAgent({ ...fixture(dir), methodId: 'unsupported' })).rejects.toMatchObject({
        code: 'ACP_AUTHENTICATION_METHOD_NOT_ADVERTISED',
      });
      expect(existsSync(join(dir, 'settings.json'))).toBe(false);
      expectProviderStopped(dir);
    });
  });

  it('cancels a pending browser login and terminates its provider', async () => {
    await withTempDir('happier-acp-login-cancel-', async (dir) => {
      const controller = new AbortController();
      await expect(authenticateAcpAgent({
        ...fixture(dir, 'wait'),
        signal: controller.signal,
        onStderr: () => controller.abort(new DOMException('Login cancelled', 'AbortError')),
      })).rejects.toMatchObject({ name: 'AbortError' });
      expect(existsSync(join(dir, 'settings.json'))).toBe(false);
      expectProviderStopped(dir);
    });
  });

  it('reports a missing executable without an unhandled process error', async () => {
    await withTempDir('happier-acp-login-spawn-', async (dir) => {
      await expect(authenticateAcpAgent({ ...fixture(dir), command: join(dir, 'missing') })).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });
});
