import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { authenticateAcpAgent } from './authenticateAcpAgent';
import { writeAcpTestAgentScript } from './testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';
import { isPidAlive } from '@/testkit/process/spawn';
import { terminateProcessTree } from '@/processes/terminate/terminateProcessTree';

// Genuine OS enumeration boundary; the ACP transport and cleanup owner remain real.
const enumeration = vi.hoisted(() => ({ denied: false }));
const launched = vi.hoisted(() => [] as import('node:child_process').ChildProcess[]);
vi.mock('cross-spawn', async importOriginal => {
  const actual = await importOriginal<{ default: typeof import('cross-spawn') }>();
  return { ...actual, default: (...args: Parameters<typeof actual.default>) => {
    const child = actual.default(...args);
    launched.push(child);
    return child;
  } };
});
const realNow = Date.now;
let samplingClockOffsetMs = 0;
vi.spyOn(Date, 'now').mockImplementation(() => realNow() + samplingClockOffsetMs);
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: (...args: Parameters<typeof actual.readdir>) => {
    if (enumeration.denied && String(args[0]) === '/proc') throw new Error('process listing unavailable');
    return actual.readdir(...args);
  }, open: (...args: Parameters<typeof actual.open>) => {
    // Exact-PID teardown observes identity directly, so the same OS boundary also refuses that read.
    if (enumeration.denied && /^\/proc\/\d+\/stat$/u.test(String(args[0]))) throw new Error('process observation unavailable');
    return actual.open(...args);
  } };
});
vi.mock('@happier-dev/cli-common/process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happier-dev/cli-common/process')>();
  return { ...actual, execFileWithDeadline: async (...args: Parameters<typeof actual.execFileWithDeadline>) => {
    if (enumeration.denied && args[1]?.[0] === 'process-census') throw new Error('process listing unavailable');
    return await actual.execFileWithDeadline(...args);
  } };
});
afterEach(async () => {
  // Native sampling recovers at its owning minute boundary after an OS failure.
  if (enumeration.denied) samplingClockOffsetMs += 60_000;
  enumeration.denied = false;
  // Restore OS observation before releasing the exact handles this fixture spawned.
  await Promise.all(launched.splice(0).map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    await terminateProcessTree(child);
    await exited;
    expect(isPidAlive(child.pid!)).toBe(false);
  }));
});

function fixture(
  dir: string,
  behavior: 'success' | 'reject' | 'wait' = 'success',
  methodIds: readonly string[] = ['oauth-personal'],
) {
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
          reply(request.id, {protocolVersion:1, authMethods:${JSON.stringify(methodIds.map(id => ({ id, name: id })))}});
        } else if (request.method === 'authenticate') {
          if (${JSON.stringify(behavior)} === 'reject') {
            process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32602,message:'Rejected'}}) + '\\n');
            return;
          }
          process.stderr.write('Open https://accounts.google.com/example\\n');
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
    agentName: 'antigravity',
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
      const previousPath = process.env.PATH;
      process.env.PATH = ''; // Absolute provider command works; OS discovery utilities do not.
      try {
        await expect(authenticateAcpAgent(fixture(dir, 'reject'))).rejects.toMatchObject({
          name: 'AggregateError',
          errors: [{ code: -32602 }, { code: 'plugin_exec_termination_incomplete' }],
        });
        expect(existsSync(join(dir, 'settings.json'))).toBe(false);
        // The canonical terminator refuses every signal without fresh native
        // identity. Incomplete custody is observable; teardown retries the same
        // owned handle after the OS enumeration boundary becomes available.
        expect(isPidAlive(Number(readFileSync(join(dir, 'pid'), 'utf8')))).toBe(true);
        expect(existsSync(join(dir, 'unexpected-session-operation'))).toBe(false);
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
      }
    });
  });

  it('authenticates without creating a session and surfaces provider stderr', async () => {
    await withTempDir('happier-acp-login-', async (dir) => {
      let output = '';
      await authenticateAcpAgent({ ...fixture(dir), onStderr: (text) => { output += text; } });
      expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))).toEqual({ auth: { type: 'oauth-personal' } });
      expect(output).toContain('https://accounts.google.com/example');
      expectProviderStopped(dir);
    });
  });

  it('authenticates with any advertised method rather than truncating the provider catalog', async () => {
    await withTempDir('happier-acp-login-catalog-', async (dir) => {
      const methodIds = Array.from({ length: 65 }, (_, index) => `oauth-${index}`);
      const methodId = methodIds.at(-1)!;
      await authenticateAcpAgent({ ...fixture(dir, 'success', methodIds), methodId });
      expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))).toEqual({ auth: { type: methodId } });
      expectProviderStopped(dir);
    });
  });

  it('rejects an unadvertised method before authenticating', async () => {
    await withTempDir('happier-acp-login-method-', async (dir) => {
      await expect(authenticateAcpAgent({ ...fixture(dir), methodId: 'unsupported' }))
        .rejects.toThrow("does not advertise auth method 'unsupported'");
      expect(existsSync(join(dir, 'settings.json'))).toBe(false);
      expectProviderStopped(dir);
    });
  });

  it('cancels a pending browser login and terminates the provider', async () => {
    await withTempDir('happier-acp-login-cancel-', async (dir) => {
      const controller = new AbortController();
      await expect(authenticateAcpAgent({
        ...fixture(dir, 'wait'),
        signal: controller.signal,
        onStderr: () => controller.abort(new DOMException('Login cancelled', 'AbortError')),
      })).rejects.toMatchObject({ name: 'AbortError' });
      expectProviderStopped(dir);
    });
  });
});
