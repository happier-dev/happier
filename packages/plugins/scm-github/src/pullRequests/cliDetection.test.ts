import { describe, expect, it } from 'vitest';

describe('GitHub CLI auth detection', () => {
  it('adapts dep.gh status into a command resolution without installing gh', async () => {
    const mod = await import('./cliDetection.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    expect(mod.resolveGithubCliCommandFromDepGhStatus({
      capabilityId: 'dep.gh',
      installed: true,
      resolvedSource: 'system',
      binPath: '/usr/local/bin/gh',
    })).toEqual({
      kind: 'available',
      source: 'system',
      binPath: '/usr/local/bin/gh',
    });
    expect(mod.resolveGithubCliCommandFromDepGhStatus({
      capabilityId: 'dep.gh',
      installed: false,
      resolvedSource: null,
      binPath: null,
    })).toEqual({ kind: 'missing' });
  });

  it('uses dep.gh resolution and probes host-specific gh auth status', async () => {
    const mod = await import('./cliDetection.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const calls: unknown[] = [];
    const result = await mod.detectGithubCliAuth({
      providerBaseUrl: 'https://ghe.internal.test',
      resolveCommand: async () => ({
        kind: 'available',
        source: 'system',
        binPath: '/usr/local/bin/gh',
      }),
      runCommand: async (request: unknown) => {
        calls.push(request);
        return { ok: true, stdout: '', stderr: '', exitCode: 0 };
      },
    });

    expect(result).toEqual({
      kind: 'authenticated',
      source: 'system',
      binPath: '/usr/local/bin/gh',
      host: 'ghe.internal.test',
    });
    expect(calls).toEqual([
      {
        binPath: '/usr/local/bin/gh',
        args: ['auth', 'status', '--hostname', 'ghe.internal.test'],
        timeoutMs: expect.any(Number),
      },
    ]);
  });

  it('does not install or login when gh is missing or unauthenticated', async () => {
    const mod = await import('./cliDetection.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const missing = await mod.detectGithubCliAuth({
      providerBaseUrl: 'https://github.com',
      resolveCommand: async () => ({ kind: 'missing' }),
      runCommand: async () => {
        throw new Error('should not run');
      },
    });
    expect(missing).toEqual({
      kind: 'missing-cli',
      host: 'github.com',
    });

    const calls: unknown[] = [];
    const missingAuth = await mod.detectGithubCliAuth({
      providerBaseUrl: 'https://github.com',
      resolveCommand: async () => ({
        kind: 'available',
        source: 'managed',
        binPath: '/managed/gh/current/bin/gh',
      }),
      runCommand: async (request: Readonly<{ args: readonly string[] }>) => {
        calls.push(request);
        return { ok: false, stdout: '', stderr: 'not logged in', exitCode: 1 };
      },
    });

    expect(missingAuth).toEqual({
      kind: 'missing-auth',
      source: 'managed',
      binPath: '/managed/gh/current/bin/gh',
      host: 'github.com',
    });
    expect(calls).toEqual([
      expect.objectContaining({
        args: ['auth', 'status', '--hostname', 'github.com'],
      }),
    ]);
    expect(calls).not.toContainEqual(expect.objectContaining({
      args: expect.arrayContaining(['login']),
    }));
  });
});
