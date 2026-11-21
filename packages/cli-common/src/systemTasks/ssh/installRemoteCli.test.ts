import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveHomeTarget } from '../../homeTarget/homeTarget.js';
import { resolveFirstPartyComponentRelease } from '../../firstPartyRuntime/prepareFirstPartyComponentPayloadFromGitHubRelease.js';
import { installRemoteFirstPartyComponentPayload } from '../kinds/remoteFirstPartyPayloadInstaller.js';
import { installRemoteCli } from './installRemoteCli.js';

describe('SSH bootstrap CLI source', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(['resolved Home', 'legacy relay URL'])('refuses public 0.2 for an unmanaged 0.3 %s', async targetKind => {
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/v1/features') {
        response.end(JSON.stringify({ capabilities: { guestCli: { source: 'public-release', line: '0.3', channel: 'stable' } } }));
      } else if (request.url?.startsWith('/repos/happier-dev/happier/releases?')) {
        response.end(JSON.stringify([{ tag_name: 'cli-v0.2.20', draft: false, prerelease: false }]));
      } else {
        response.end(JSON.stringify({ tag_name: 'cli-v0.2.20', assets: [
          'happier-v0.2.20-linux-x64.tar.gz', 'checksums-happier-v0.2.20.txt', 'checksums-happier-v0.2.20.txt.minisig',
        ].map(name => ({ name, browser_download_url: `https://releases.example/${name}` })) }));
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected release mirror listener');
      const homeUrl = `http://127.0.0.1:${address.port}`;
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('HAPPIER_FIRST_PARTY_RELEASE_API_BASE_URL', homeUrl);
      vi.stubEnv('HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT', '');
      vi.stubEnv('HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_METADATA', '');
      // The real generic resolver can select 0.2; only the selected Home owns its line.
      expect((await resolveFirstPartyComponentRelease({ componentId: 'happier-cli', channel: 'stable', os: 'linux', arch: 'x64' })).versionId).toBe('0.2.20');
      const homeTarget = await resolveHomeTarget({ input: { kind: 'https_url', url: homeUrl }, readSavedProfile: async () => null });
      let guestMutated = false;
      await expect(installRemoteCli({ channel: 'stable', bootstrap: {
        parsed: { relay: { relayUrl: homeUrl }, ...(targetKind === 'resolved Home' ? { homeTarget } : {}),
          // Unmanaged input is not an admitted unsigned export, even if it carries metadata.
          guestCli: { source: 'home-payload', line: '0.3', channel: 'stable', payloads: [{
            target: { os: 'linux', arch: 'x64' }, sha256: 'a'.repeat(64), url: `${homeUrl}/payload.tar.gz`,
          }] } },
        createPromptId: () => 'unused',
      }, transport: {
        exec: async () => { throw new Error('No dedicated-account bootstrap is needed'); },
        install: placement => installRemoteFirstPartyComponentPayload({ ...placement,
          componentId: 'happier-cli', channel: 'stable', strategy: 'remote-self-download',
        }, {
          resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
          // Guest execution is the SSH boundary; no command is executed on this machine.
          runRemoteText: async ({ remoteCommand }) => {
            if (remoteCommand.includes('--version')) return { status: 0, stdout: 'managed_guest_cli_absent\n', stderr: '' };
            guestMutated = true;
            return { status: 1, stdout: '', stderr: 'No payload may be installed from another release line' };
          },
          copyLocalDirectoryToRemote: async () => { guestMutated = true; },
        }),
      } })).rejects.toMatchObject({ code: 'managed_guest_cli_release_unavailable' });
      expect(guestMutated).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});

describe('SSH bootstrap keeps the enrolling user service alive after the session', () => {
  // The SSH exec is the process boundary: it answers with the token the remote linger command prints.
  const enroll = (lingerOutcome: Readonly<{ status: number; stdout: string }>, serviceMode?: 'user' | 'none') => {
    const commands: string[] = [];
    const run = installRemoteCli({ channel: 'stable', bootstrap: {
      parsed: { relay: { relayUrl: 'http://home.example' }, ...(serviceMode ? { serviceMode } : {}) },
      createPromptId: () => 'unused',
    }, transport: {
      exec: async ({ command }) => {
        commands.push(command);
        return command.includes('/var/lib/systemd/linger/') ? { ...lingerOutcome, stderr: '' } : { status: 1, stdout: '', stderr: 'unexpected' };
      },
      install: async () => ({ binaryPath: '/home/bl2ssh/.happier/cli/current/happier' }),
    } });
    return { run, commands };
  };

  it('enables linger for the enrolling user before a user-mode service is installed', async () => {
    const { run, commands } = enroll({ status: 0, stdout: 'linger_enabled\n' });
    await expect(run).resolves.toBeUndefined();
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain('/var/lib/systemd/linger/');
  });

  it('refuses enrollment with the remedy when logind will not keep the user manager running', async () => {
    const { run } = enroll({ status: 1, stdout: 'linger_refused\n' });
    await expect(run).rejects.toMatchObject({
      code: 'daemon_service_not_ready',
      message: expect.stringContaining('loginctl enable-linger'),
    });
  });

  it('accepts hosts without systemd and skips the step when no service is installed', async () => {
    await expect(enroll({ status: 0, stdout: 'linger_not_applicable\n' }).run).resolves.toBeUndefined();
    const none = enroll({ status: 1, stdout: 'linger_refused\n' }, 'none');
    await expect(none.run).resolves.toBeUndefined();
    expect(none.commands).toEqual([]);
  });
});
