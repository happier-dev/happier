import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareAgentSignIn, probeAgentSignInStatus } from './agentSignIn';
import { readSystemToolAuthentication, probeSystemToolAuthentication } from './systemToolAuthentication';
import { resolveDaemonTerminalLaunch } from '@/terminal/pty/launch';

describe('machine CLI sign-in declarations', () => {
  it('distinguishes an absent executable from installed real gh with unknown authentication', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'machine-cli-presence-'));
    const path = process.env.PATH;
    try {
      vi.stubEnv('PATH', directory);
      const absent = await probeAgentSignInStatus('happier.scm.forge.github/gh');
      expect(absent).toMatchObject({ status: 'unknown' });
      expect(absent).toMatchObject({ installed: false });
      vi.stubEnv('PATH', path);
      const declaration = readSystemToolAuthentication('happier.scm.forge.github/gh');
      if (!declaration) throw new Error('Declared GitHub CLI unavailable');
      expect(await probeSystemToolAuthentication(declaration, null)).toMatchObject({ status: 'unknown', installed: null });
      // Real gh rejects this declared command. Its failed authentication probe
      // cannot erase the executable presence established by the launch owner.
      const unknown = await probeSystemToolAuthentication({ ...declaration, authentication: { ...declaration.authentication,
        status: { args: ['not-a-real-gh-command'], signedOutExitCodes: [] } } });
      expect(unknown).toMatchObject({ status: 'unknown', installed: true });
    } finally { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); }
  });
  it('prepares GitHub CLI sign-in through the existing native and connected owners', () => {
    expect(prepareAgentSignIn({ agentId: 'happier.scm.forge.github/gh', method: 'native', launchId: 'device_code' }))
      .toEqual({ method: 'native', launch: { kind: 'agent_login', agentId: 'happier.scm.forge.github/gh', launchId: 'device_code' } });
    expect(prepareAgentSignIn({ agentId: 'happier.scm.forge.github/gh' })).toMatchObject({ method: 'connected',
      command: { operation: 'beginConnect', service: { pluginId: 'happier.scm.forge.github', localId: 'github-account' } } });
  });

  it('resolves a real declared gh executable without inheriting token authentication', async () => {
    const launch = await resolveDaemonTerminalLaunch({ kind: 'agent_login', agentId: 'happier.scm.forge.github/gh', launchId: 'device_code' },
      { env: { ...process.env, GH_TOKEN: 'native-login-sentinel', GITHUB_TOKEN: 'native-login-sentinel' } });
    expect(launch.file).toMatch(/(?:^|[/\\])gh(?:\.exe|\.cmd|\.bat)?$/);
    expect(launch.args).toEqual(['auth', 'login', '--git-protocol', 'https', '--web']);
    expect(launch.env?.GH_TOKEN).toBeUndefined();
    expect(launch.env?.GITHUB_TOKEN).toBeUndefined();
    expect(JSON.stringify(launch)).not.toContain('native-login-sentinel');
  });

  it('uses the same native sign-in owner for 1Password and rejects undeclared login kinds', () => {
    expect(prepareAgentSignIn({ agentId: 'happier.secret-source.onepassword/op', method: 'native' }))
      .toEqual({ method: 'native', launch: { kind: 'agent_login', agentId: 'happier.secret-source.onepassword/op', launchId: 'primary' } });
    expect(prepareAgentSignIn({ agentId: 'happier.secret-source.onepassword/op', method: 'native', launchId: 'device_code' }))
      .toMatchObject({ ok: false, errorCode: 'agent_login_unsupported' });
  });

  it('retains the native GitHub CLI configured host while clearing ambient tokens', async () => {
    const host = 'github.enterprise.example';
    const launch = await resolveDaemonTerminalLaunch({ kind: 'agent_login', agentId: 'happier.scm.forge.github/gh' },
      { env: { ...process.env, GH_HOST: host, GH_TOKEN: 'host-login-sentinel', GITHUB_TOKEN: 'host-login-sentinel',
        GH_ENTERPRISE_TOKEN: 'host-login-sentinel', GITHUB_ENTERPRISE_TOKEN: 'host-login-sentinel' } });
    expect(launch.env?.GH_HOST).toBe(host);
    expect(launch.args).not.toContain('github.com');
    expect(JSON.stringify(launch)).not.toContain('host-login-sentinel');
  });
});
