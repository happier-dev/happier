import { describe, expect, it, vi } from 'vitest';
import type { NativeSshExecRequest, NativeSshModule } from '@happier-dev/ssh-native';
import { computeSshHostKeyFingerprint } from '@happier-dev/protocol/ssh/hostTrust';

import { runNativeRemoteSshBootstrapTask } from './nativeTask';

const HOST_KEY = '[guest.example]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const OTHER_HOST_KEY = '[guest.example]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const fingerprint = (line: string) => computeSshHostKeyFingerprint(line.split(' ')[2]!);
const INSTALL_COMMAND = 'install verified native CLI';

function createSpec(ssh: Record<string, unknown> = {}) {
    return {
        kind: 'remote.ssh.bootstrapMachine.v1',
        params: {
            ssh: { target: 'dev@guest.example', port: 2222, auth: 'password', password: 'transient', ...ssh },
            relay: { relayUrl: 'https://home.example', webappUrl: 'https://home.example' },
            channel: 'stable', serviceMode: 'none', knownHostsMode: 'app',
        },
    };
}

function createNativeBoundary(input: Readonly<{ actualFingerprint?: string; failInstall?: boolean }> = {}) {
    const requests: NativeSshExecRequest[] = [];
    const phases: string[] = [];
    const nativeModule: NativeSshModule = {
        getAvailability: () => ({ available: true, platform: 'android', engine: 'russh', moduleVersion: '0.0.0',
            supportsLoopbackTunnel: true, supportsPersistentHostKeyStorage: false }),
        cancelRequest: async () => undefined,
        exec: async request => {
            requests.push(request);
            // Native SSH is the OS boundary: it refuses a substituted key before executing a command.
            if (request.hostKeyVerification.decision === 'accept-once'
                && request.hostKeyVerification.fingerprintSha256 !== (input.actualFingerprint ?? fingerprint(HOST_KEY))) {
                throw new Error('native_ssh_host_key_mismatch');
            }
            if (request.command.includes('uname -s')) {
                return { exitCode: 0, stdout: JSON.stringify({ platform: 'linux', arch: 'x86_64' }), stderr: '' };
            }
            if (request.command.includes('for version_path in')) {
                return { exitCode: 0, stdout: 'current=\nprevious=\n', stderr: '' };
            }
            if (request.command === INSTALL_COMMAND) {
                phases.push('install');
                return { exitCode: input.failInstall ? 1 : 0, stdout: '', stderr: '' };
            }
            phases.push('remote-command');
            return { exitCode: 0, stdout: JSON.stringify({ ok: true, data: request.command.includes('auth status')
                ? { authenticated: true, credentialState: 'valid', machineRegistered: true,
                    machineRegistrationState: 'server-confirmed', machineId: 'native-pinned-machine' }
                : {} }), stderr: '' };
        },
    };
    return { nativeModule, requests, phases };
}

const resolveInstallPlan = async () => ({ binaryPath: '$HOME/.happier/cli/current/happier', versionId: '1.2.3',
    source: 'https://downloads.example/cli.tar.gz', command: INSTALL_COMMAND });

describe('native SSH bootstrap host pinning', () => {
    it('refuses a managed guest when native SSH cannot transfer the Home payload', async () => {
        const boundary = createNativeBoundary();
        const spec = createSpec({ trustedHostKey: HOST_KEY });
        let publicResolutions = 0;
        await expect(runNativeRemoteSshBootstrapTask({ taskId: 'managed-home-payload', ...boundary,
            spec: { ...spec, params: { ...spec.params, managedEnrollment: {
                homeId: 'srv_home', managedId: 'managed', requestId: 'request', expectedIntentRevision: 1,
                controller: { machineId: 'controller', installationId: 'installation' },
                resource: { contributionRef: { pluginId: 'test.provisioner', localId: 'vm' }, schemaVersion: 1, value: { nativeId: 'guest' } },
            } } },
            resolveInstallPlan: async () => { publicResolutions++; return resolveInstallPlan(); },
        })).rejects.toMatchObject({ code: 'guest_payload_missing' });
        expect(publicResolutions).toBe(0);
        expect(boundary.phases).not.toContain('install');
    });

    it.each([false, true])('pins every native command before installation and enrollment (provider evidence: %s)', async withEvidence => {
        const boundary = createNativeBoundary();
        await expect(runNativeRemoteSshBootstrapTask({ taskId: 'native-pin', ...boundary,
            spec: createSpec({ trustedHostKey: HOST_KEY,
                ...(withEvidence ? { hostKeyEvidence: { hostKey: HOST_KEY, fingerprint: fingerprint(HOST_KEY) } } : {}) }),
            resolveInstallPlan,
        })).resolves.toEqual({ machineId: 'native-pinned-machine' });
        expect(boundary.requests.some(request => request.command === INSTALL_COMMAND)).toBe(true);
        expect(boundary.requests.some(request => request.command.includes('auth status'))).toBe(true);
        expect(boundary.requests.every(request => request.hostKeyVerification.decision === 'accept-once'
            && request.hostKeyVerification.fingerprintSha256 === fingerprint(HOST_KEY))).toBe(true);
    });

    it('refuses a substituted native host before any pairing approval', async () => {
        const boundary = createNativeBoundary({ actualFingerprint: fingerprint(OTHER_HOST_KEY) });
        const approveLocalAuthRequest = vi.fn(async () => undefined);
        await expect(runNativeRemoteSshBootstrapTask({ taskId: 'native-pin-substitution', ...boundary,
            spec: createSpec({ trustedHostKey: HOST_KEY, hostKeyEvidence: { hostKey: HOST_KEY, fingerprint: fingerprint(HOST_KEY) } }),
            resolveInstallPlan, approveLocalAuthRequest,
        })).rejects.toThrow('native_ssh_host_key_mismatch');
        expect(approveLocalAuthRequest).not.toHaveBeenCalled();
        expect(boundary.phases).toEqual([]);
    });

    it.each([
        { trustedHostKey: 'invalid', code: 'invalid_trusted_host_key' },
        { trustedHostKey: HOST_KEY, hostKeyEvidence: { hostKey: OTHER_HOST_KEY, fingerprint: fingerprint(OTHER_HOST_KEY) }, code: 'trusted_host_key_mismatch' },
        { trustedHostKey: HOST_KEY, hostKeyEvidence: { hostKey: HOST_KEY, fingerprint: fingerprint(OTHER_HOST_KEY) }, code: 'trusted_host_key_mismatch' },
    ])('rejects inconsistent supplied trust before native execution: $code', async ({ code, ...ssh }) => {
        const boundary = createNativeBoundary();
        await expect(runNativeRemoteSshBootstrapTask({ taskId: 'native-pin-invalid', ...boundary,
            spec: createSpec(ssh), resolveInstallPlan,
        })).rejects.toMatchObject({ code });
        expect(boundary.requests).toEqual([]);
    });

    it.each([false, true])('preserves native prompts without an explicit pin (provider evidence: %s)', async withEvidence => {
        const boundary = createNativeBoundary();
        await expect(runNativeRemoteSshBootstrapTask({ taskId: 'native-unpinned', ...boundary,
            spec: createSpec(withEvidence ? { hostKeyEvidence: { hostKey: HOST_KEY, fingerprint: fingerprint(HOST_KEY) } } : {}),
            resolveInstallPlan,
        })).resolves.toEqual({ machineId: 'native-pinned-machine' });
        expect(boundary.requests.every(request => request.hostKeyVerification.decision === 'prompt')).toBe(true);
    });

    it('settles the private installation hook after shared install and before remote enrollment', async () => {
        const boundary = createNativeBoundary();
        await runNativeRemoteSshBootstrapTask({ taskId: 'native-installed-hook', ...boundary,
            spec: createSpec({ trustedHostKey: HOST_KEY }), resolveInstallPlan,
            onInstalled: async () => { boundary.phases.push('installed'); },
        });
        expect(boundary.phases.slice(0, 3)).toEqual(['install', 'installed', 'remote-command']);
    });

    it('does not publish installation completion when shared installation fails', async () => {
        const boundary = createNativeBoundary({ failInstall: true });
        const onInstalled = vi.fn(async () => undefined);
        await expect(runNativeRemoteSshBootstrapTask({ taskId: 'native-install-failure', ...boundary,
            spec: createSpec({ trustedHostKey: HOST_KEY }), resolveInstallPlan, onInstalled,
        })).rejects.toMatchObject({ code: 'native_ssh_remote_cli_install_failed' });
        expect(onInstalled).not.toHaveBeenCalled();
        expect(boundary.phases).toEqual(['install']);
    });
});
