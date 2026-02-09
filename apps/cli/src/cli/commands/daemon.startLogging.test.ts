import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function captureConsole(fn: () => Promise<void> | void): Promise<string> {
  const chunks: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: any[]) => {
    chunks.push(args.map((a) => String(a)).join(' ') + '\n');
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: any[]) => {
    chunks.push(args.map((a) => String(a)).join(' ') + '\n');
  });
  try {
    await fn();
    return chunks.join('');
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
}

function buildJwtWithSub(sub: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub })).toString('base64url');
  return `${header}.${payload}.x`;
}

vi.mock('@/utils/spawnHappyCLI', () => ({
  spawnHappyCLI: () => ({ unref: () => {} }),
}));

vi.mock('@/daemon/controlClient', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    checkIfDaemonRunningAndCleanupStaleState: vi.fn(async () => true),
  };
});

describe('happier daemon start output', () => {
  it('prints server url, active server id, and account subject', async () => {
    const prevEnv = { ...process.env };
    const tmp = await mkdtemp(join(tmpdir(), 'happier-daemon-start-'));

    try {
      vi.resetModules();
      process.env.HAPPIER_HOME_DIR = tmp;
      process.env.HAPPIER_SERVER_URL = 'http://localhost:4321';
      process.env.HAPPIER_WEBAPP_URL = 'http://localhost:9999';
      process.env.HAPPIER_ACTIVE_SERVER_ID = 'env_test';

      const credDir = join(tmp, 'servers', 'env_test');
      await mkdir(credDir, { recursive: true });
      await writeFile(
        join(credDir, 'access.key'),
        JSON.stringify(
          {
            encryption: { publicKey: Buffer.from('a').toString('base64'), machineKey: Buffer.from('b').toString('base64') },
            token: buildJwtWithSub('account-123'),
          },
          null,
          2,
        ),
        { encoding: 'utf8' },
      );

      const stdout = await captureConsole(async () => {
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
          throw new Error(`exit:${code ?? ''}`);
        }) as any);

        try {
          const { handleDaemonCliCommand } = await import('./daemon');
          await handleDaemonCliCommand({ args: ['daemon', 'start'], rawArgv: [], terminalRuntime: null });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes('exit:0')) throw err;
        } finally {
          exitSpy.mockRestore();
        }
      });

      expect(stdout).toContain('Daemon started successfully');
      expect(stdout).toContain('Server: http://localhost:4321');
      expect(stdout).toContain('Server ID: env_test');
      expect(stdout).toContain('Account: account-123');
    } finally {
      process.env = prevEnv;
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
