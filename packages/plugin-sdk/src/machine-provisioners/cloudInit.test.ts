import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { resolveSshHostTrust } from '@happier-dev/protocol/ssh/hostTrust';
import * as cloud from './cloudInit.js';

const publicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB generated-host';
const privateKey = '-----BEGIN OPENSSH PRIVATE KEY-----\nprivate-host-key\n-----END OPENSSH PRIVATE KEY-----\n';

describe('cloud-init generated guest identity', () => {
  it('installs the retained host key in the SSH init module, before login rather than in final commands', () => {
    const build: (loginKey: string, hostKey: { publicKey: string; privateKey: string }) => string = cloud.buildMachineProvisionerCloudInit;
    const input = { publicKey, privateKey };
    const bytes = build('ssh-rsa bootstrap-login', input);
    const config = parse(bytes);
    expect(config.ssh_keys).toEqual({ ed25519_private: privateKey, ed25519_public: publicKey });
    expect(config.users[0].ssh_authorized_keys).toEqual(['ssh-rsa bootstrap-login']);
    expect(config).not.toHaveProperty('runcmd');
    expect(config).not.toHaveProperty('bootcmd');
    expect(build('ssh-rsa bootstrap-login', input)).toBe(bytes);
  });

  it('pins the generated public key at the actual SSH endpoint without observing an untrusted scanner', () => {
    const codec = cloud;
    expect(codec.buildMachineProvisionerPinnedSshBootstrap).toBeTypeOf('function');
    const carrier = codec.buildMachineProvisionerPinnedSshBootstrap!({
      connection: { address: '2001:db8::42', user: 'happier-bootstrap', port: 2222 },
      guestHostPublicKey: publicKey, credentialRef: { kind: 'shared_resource', resourceId: 'retained-bundle' },
    });
    expect(carrier).toMatchObject({ kind: 'ssh', address: '2001:db8::42', port: 2222,
      hostKeySource: 'retained-credential',
      credentialRef: { kind: 'shared_resource', resourceId: 'retained-bundle' },
      hostKeyEvidence: { hostKey: `[2001:db8::42]:2222 ${publicKey.split(' ').slice(0, 2).join(' ')}`, fingerprint: expect.stringMatching(/^SHA256:/) } });
    expect(JSON.stringify(carrier)).not.toContain(privateKey);
    const trusted = { host: carrier.address, port: carrier.port!, algorithm: 'ssh-ed25519', fingerprintSha256: carrier.hostKeyEvidence.fingerprint };
    expect(resolveSshHostTrust({ ...trusted, trusted })).toEqual({ status: 'trusted' });
    expect(resolveSshHostTrust({ ...trusted, fingerprintSha256: 'SHA256:substituted', trusted }).status).not.toBe('trusted');
  });
});
