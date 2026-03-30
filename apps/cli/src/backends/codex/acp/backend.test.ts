import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }  
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('createCodexAcpBackend', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it(
    'auto-selects openai-api-key auth when OPENAI_API_KEY is set',
    async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-codex-acp-auth-'));
    const agentScript = join(dir, 'fake-acp-agent.mjs');
    const wrapper = join(dir, 'codex-acp');
    try {
      writeFileSync(
        agentScript,
        `
          let authenticated = false;
          const decoder = new TextDecoder();
          let buf = '';

          function send(obj) {
            process.stdout.write(JSON.stringify(obj) + '\\n');
          }

          function ok(id, result) {
            send({ jsonrpc: '2.0', id, result });
          }

          function err(id, message) {
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
              try { req = JSON.parse(trimmed); } catch { continue; }
              if (!req || typeof req !== 'object') continue;
              const id = req.id;
              const method = req.method;
              if (id === undefined || id === null || typeof method !== 'string') continue;

              if (method === 'initialize') {
                ok(id, { protocolVersion: 1, authMethods: [{ id: 'openai-api-key', name: 'Use OPENAI_API_KEY' }] });
                continue;
              }
              if (method === 'authenticate') {
                authenticated = true;
                ok(id, {});
                continue;
              }
              if (method === 'session/new') {
                if (!authenticated) return err(id, 'auth required');
                ok(id, { sessionId: 'test-session' });
                continue;
              }
              ok(id, {});
            }
          });
        `,
        'utf8',
      );

      writeFileSync(wrapper, `#!/bin/sh\n\"${process.execPath}\" \"${agentScript}\"\n`, 'utf8');
      await (await import('node:fs/promises')).chmod(wrapper, 0o755);
      await withEnv({
        HAPPIER_VARIANT: 'stable',
        HAPPIER_HOME_DIR: dir,
        CODEX_HOME: dir,
        HAPPIER_CODEX_ACP_BIN: wrapper,
        OPENAI_API_KEY: 'sk-test',
      }, async () => {
        const mod = await import('./backend');
        const created = mod.createCodexAcpBackend({ cwd: dir, env: {} });
        await expect(created.backend.startSession()).resolves.toEqual({ sessionId: 'test-session' });
        await created.backend.dispose();
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    },
    20_000,
  );

  it(
    'uses scoped OPENAI_API_KEY and scoped codex-acp env instead of host process env',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'happier-codex-acp-scoped-auth-'));
      const agentScript = join(dir, 'fake-acp-agent.mjs');
      const wrapper = join(dir, 'scoped-codex-acp');
      try {
        writeFileSync(
          agentScript,
          `
            process.stdin.resume();
            setInterval(() => {}, 1000);
          `,
          'utf8',
        );

        writeFileSync(wrapper, `#!/bin/sh\n\"${process.execPath}\" \"${agentScript}\"\n`, 'utf8');
        await (await import('node:fs/promises')).chmod(wrapper, 0o755);

        await withEnv({
          HAPPIER_VARIANT: 'stable',
          HAPPIER_HOME_DIR: undefined,
          CODEX_HOME: undefined,
          HAPPIER_CODEX_ACP_BIN: undefined,
          OPENAI_API_KEY: undefined,
        }, async () => {
          const mod = await import('./backend');
          const created = mod.createCodexAcpBackend({
            cwd: dir,
            env: {
              CODEX_HOME: dir,
              HAPPIER_CODEX_ACP_BIN: wrapper,
              OPENAI_API_KEY: 'scoped-openai-key',
            },
          });
          const backend = created.backend as any;
          expect(created.spawn.command).toBe(wrapper);
          expect(backend.options.authMethodId).toBe('openai-api-key');
          await created.backend.dispose();
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it('prefers scoped OPENAI_API_KEY from backend env over ambient host env', async () => {
    const captured: Array<any> = [];

    await withEnv({
      HAPPIER_VARIANT: 'stable',
      HAPPIER_CODEX_ACP_BIN: '/bin/echo',
      OPENAI_API_KEY: undefined,
      CODEX_API_KEY: undefined,
    }, async () => {
      vi.doMock('@/agent/acp/AcpBackend', () => ({
        AcpBackend: class {
          constructor(opts: any) {
            captured.push(opts);
          }
        },
      }));

      const mod = await import('./backend');
      mod.createCodexAcpBackend({
        cwd: '/tmp',
        env: { OPENAI_API_KEY: 'sk-scoped' },
      });

      expect(captured).toHaveLength(1);
      expect(captured[0].authMethodId).toBe('openai-api-key');
    });
  });

  it('uses codex-acp directly when it resolves from PATH', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-home-'));
    const pathDir = join(homeDir, 'bin');
    try {
      mkdirSync(pathDir, { recursive: true });
      writeFileSync(join(pathDir, 'codex-acp'), '#!/bin/sh\necho ok\n', 'utf8');
      await (await import('node:fs/promises')).chmod(join(pathDir, 'codex-acp'), 0o755);
      await withEnv({
        HAPPIER_VARIANT: 'stable',
        HAPPIER_HOME_DIR: homeDir,
        CODEX_HOME: homeDir,
        PATH: pathDir,
      }, async () => {
	        const mod = await import('./backend');
	        const created = mod.createCodexAcpBackend({ cwd: homeDir, env: {} });
	        expect(created.spawn.command).toBe('codex-acp');
	        expect(created.spawn.args).toEqual([]);
	      });
	    } finally {
	      await rm(homeDir, { recursive: true, force: true });
	    }
	  });

  it('passes permission-mode-derived overrides to the codex-acp spawn spec', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-home-'));
    const pathDir = join(homeDir, 'bin');
    try {
      mkdirSync(pathDir, { recursive: true });
      writeFileSync(join(pathDir, 'codex-acp'), '#!/bin/sh\necho ok\n', 'utf8');
      await (await import('node:fs/promises')).chmod(join(pathDir, 'codex-acp'), 0o755);
      await withEnv({
        HAPPIER_VARIANT: 'stable',
        HAPPIER_HOME_DIR: homeDir,
        CODEX_HOME: homeDir,
        PATH: pathDir,
        HAPPIER_CODEX_ACP_CONFIG_OVERRIDES: undefined,
      }, async () => {
        const mod = await import('./backend');
	        const created = mod.createCodexAcpBackend({ cwd: homeDir, env: {}, permissionMode: 'yolo' });
	        expect(created.spawn.command).toBe('codex-acp');
	        expect(created.spawn.args).toEqual([
	          '-c',
	          'approval_policy=\"never\"',
	          '-c',
	          'sandbox_mode=\"danger-full-access\"',
	        ]);
      });
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('uses the default init timeout when codex ACP is resolved from PATH', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-home-'));
    const captured: Array<any> = [];
    const pathDir = join(homeDir, 'bin');
    try {
      mkdirSync(pathDir, { recursive: true });
      writeFileSync(join(pathDir, 'codex-acp'), '#!/bin/sh\necho ok\n', 'utf8');
      await (await import('node:fs/promises')).chmod(join(pathDir, 'codex-acp'), 0o755);
      await withEnv({
        HAPPIER_VARIANT: 'stable',
        HAPPIER_HOME_DIR: homeDir,
        PATH: pathDir,
      }, async () => {
        vi.doMock('@/agent/acp/AcpBackend', () => ({
          AcpBackend: class {
            constructor(opts: any) {
              captured.push(opts);
            }
          },
        }));

        const mod = await import('./backend');
        mod.createCodexAcpBackend({ cwd: homeDir, env: {} });

        expect(captured).toHaveLength(1);
        expect(captured[0].command).toBe('codex-acp');
        expect(captured[0].transportHandler?.getInitTimeout?.()).toBe(180_000);
      });
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('uses a longer init timeout when codex ACP is resolved via a direct binary path', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-home-'));
    const captured: Array<any> = [];
    const fakeBin = join(homeDir, 'codex-acp');
    try {
      writeFileSync(fakeBin, '#!/bin/sh\necho ok\n', 'utf8');
      await (await import('node:fs/promises')).chmod(fakeBin, 0o755);

      await withEnv(
        {
          HAPPIER_VARIANT: 'stable',
          HAPPIER_HOME_DIR: homeDir,
          CODEX_HOME: homeDir,
          HAPPIER_CODEX_ACP_BIN: fakeBin,
          HAPPIER_CODEX_ACP_INIT_TIMEOUT_MS: undefined,
          HAPPIER_CODEX_ACP_NPX_INIT_TIMEOUT_MS: undefined,
        },
        async () => {
          vi.doMock('@/agent/acp/AcpBackend', () => ({
            AcpBackend: class {
              constructor(opts: any) {
                captured.push(opts);
              }
            },
          }));

          const mod = await import('./backend');
          mod.createCodexAcpBackend({ cwd: homeDir, env: {} });

          expect(captured).toHaveLength(1);
          expect(captured[0].command).toBe(fakeBin);
          expect(captured[0].transportHandler?.getInitTimeout?.()).toBe(180_000);
        },
      );
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('honors the npx-specific init timeout override when the spawn command is npx', async () => {
    const captured: Array<any> = [];

    await withEnv(
      {
        HAPPIER_CODEX_ACP_INIT_TIMEOUT_MS: undefined,
        HAPPIER_CODEX_ACP_NPX_INIT_TIMEOUT_MS: '240000',
      },
      async () => {
        vi.doMock('@/agent/acp/AcpBackend', () => ({
          AcpBackend: class {
            constructor(opts: any) {
              captured.push(opts);
            }
          },
        }));
        vi.doMock('@/backends/codex/acp/resolveCommand', () => ({
          resolveCodexAcpSpawn: () => ({ command: 'npx', args: ['codex-acp'] }),
        }));

        const mod = await import('./backend');
        mod.createCodexAcpBackend({ cwd: process.cwd(), env: {} });

        expect(captured).toHaveLength(1);
        expect(captured[0].command).toBe('npx');
        expect(captured[0].transportHandler?.getInitTimeout?.()).toBe(240_000);
      },
    );
  });
});
