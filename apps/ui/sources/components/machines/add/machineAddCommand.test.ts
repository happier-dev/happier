import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// App configuration is the environment adapter; retain the real command and release-ring owners.
vi.mock('@/config', () => ({ config: { variant: 'production', identityVariant: 'stable' } }));
import { buildMachineAddCommand, detectClientCommandOs, MACHINE_ADD_COMMAND_OS, resolveWebDesktopSetupHandoffTarget } from './machineAddCommand';
import { createDefaultSshCredentialsDraft } from '@/components/ssh/sshCredentialsDraft';
import { MachineAddCommandInputSchema } from '@happier-dev/protocol/actions/specs/machineConnection';
import { ManagedMachineEnrollmentIdentityV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';

const home = { descriptor: null, profileSource: null, fallbackHomeUrl: 'https://home.example.test' };
describe('machine add commands', () => {
    it.each(MACHINE_ADD_COMMAND_OS)('refuses public installation for a source Home (%s)', os => {
        const target = { ...home, profileSource: 'stack-env' as const };
        expect(resolveWebDesktopSetupHandoffTarget(target)).toMatchObject({ kind: 'unavailable', code: 'guest_payload_missing' });
        expect(buildMachineAddCommand({ ...target, os, kind: 'joinHome' })).toBeNull();
        expect(buildMachineAddCommand({ ...target, os, kind: 'sshMachine', sshDraft: createDefaultSshCredentialsDraft() })).toBeNull();
    });
    it.each(['http://happier-agent-qa-unified-work-dev.localhost:3009', 'http://127.0.0.1:3009', 'https://[::1]:3009'])(
        'refuses controller-only setup on another computer while preserving same-computer setup (%s)', url => {
            const target = { ...home, fallbackHomeUrl: url, descriptor: { v: 1 as const, homeServerIdentityId: 'srv_home',
                canonicalServerUrl: url, revision: 1, endpoints: [{ kind: 'https' as const, url }] } };
            expect(resolveWebDesktopSetupHandoffTarget({ ...target, remote: true })).toEqual({ kind: 'unavailable', code: 'home_not_guest_reachable' });
            expect(buildMachineAddCommand({ ...target, remote: true, os: 'linux', kind: 'joinHome' })).toBeNull();
            expect(buildMachineAddCommand({ ...target, os: 'linux', kind: 'joinHome' })).toContain(url);
        },
    );
    it('uses the remote HTTPS route after a controller-only endpoint, or carries Iroh by descriptor', () => {
        const descriptor = { v: 1 as const, homeServerIdentityId: 'srv_home', canonicalServerUrl: 'http://qa.localhost:3009', revision: 1,
            endpoints: [{ kind: 'https' as const, url: 'http://qa.localhost:3009' }, { kind: 'https' as const, url: 'https://home.tailnet.example' }] };
        expect(buildMachineAddCommand({ ...home, descriptor, remote: true, os: 'linux', kind: 'joinHome' }))
            .toContain('--home-url https://home.tailnet.example');
        expect(buildMachineAddCommand({ ...home, descriptor: { ...descriptor, endpoints: [descriptor.endpoints[0]!, { kind: 'iroh', endpointId: 'a'.repeat(64) }] },
            remote: true, os: 'windows', kind: 'joinHome' })).toContain('--home-descriptor-file $happierHomeDescriptor');
        expect(buildMachineAddCommand({ ...home, fallbackHomeUrl: 'http://qa.localhost:3009', remote: true, os: 'windows', kind: 'sshMachine',
            sshDraft: { ...createDefaultSshCredentialsDraft(), host: 'nl1' } })).toBeNull();
    });
    it.skipIf(process.platform === 'win32')('hands the exact Iroh descriptor to setup without requiring an existing file', () => {
        const descriptor = HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId: 'srv_home', canonicalServerUrl: 'http://qa.localhost:3009', revision: 1,
            endpoints: [{ kind: 'iroh', endpointId: 'a'.repeat(64), relayUrls: ['https://relay.example.test/it\'s'] }] });
        const root = mkdtempSync(join(tmpdir(), 'machine-add-command-'));
        try {
            // Installer download and the installed CLI are process boundaries. Run the generated shell unchanged.
            writeFileSync(join(root, 'curl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
            writeFileSync(join(root, 'happier'), '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "--home-descriptor-file" ]; then cat "$2"; rm "$2"; exit; fi\n  shift\ndone\nexit 2\n', { mode: 0o755 });
            const command = buildMachineAddCommand({ ...home, descriptor, remote: true, os: 'linux', kind: 'joinHome' });
            if (!command) throw new Error('No remote command');
            const received = execFileSync('/bin/sh', ['-c', command], { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${root}:${process.env.PATH}` } });
            expect(HomeConnectionDescriptorV1Schema.parse(JSON.parse(received))).toEqual(descriptor);
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
    it('admits reviewed SSH identity at the public command request boundary', () => {
        const enrollmentIdentity = ManagedMachineEnrollmentIdentityV1Schema.parse({ kind: 'dedicatedDaemonUser', username: 'happier',
            serviceMode: 'user', role: 'server', adminAccessAtCreation: 'ask', administrator: { username: 'operator' } });
        const input = { method: 'ssh', serverId: 'home', os: 'linux', host: 'server', enrollmentIdentity };
        expect(MachineAddCommandInputSchema.safeParse(input).success).toBe(true);
    });
    it.each(MACHINE_ADD_COMMAND_OS)('carries reviewed SSH server identity and administrator choice without a password (%s)', os => {
        const input = { ...home, kind: 'sshMachine' as const, os, sshDraft: {
            ...createDefaultSshCredentialsDraft(), host: 'server.example.test', username: 'root',
        }, enrollmentIdentity: { kind: 'dedicatedDaemonUser' as const, username: 'happier' as const,
            serviceMode: 'user' as const, role: 'server' as const, adminAccessAtCreation: 'none' as const } };
        const command = buildMachineAddCommand(input);
        expect(command).toContain('--role server');
        expect(command).toContain('--admin-access none');
        expect(command).not.toContain('--service-mode');
    });

    it.each(MACHINE_ADD_COMMAND_OS)('preserves the reviewed Ask administrator in the command (%s)', os => {
        const command = buildMachineAddCommand({ ...home, kind: 'sshMachine', os,
            sshDraft: { ...createDefaultSshCredentialsDraft(), host: 'server', username: 'root' },
            enrollmentIdentity: { kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user', role: 'deployTarget',
                adminAccessAtCreation: 'ask', administrator: { username: 'operator' } },
        });
        expect(command).toContain('--role deployTarget --admin-access ask --administrator operator');
        expect(command).not.toContain('--password');
    });

    it('installs and joins the descriptor-proven Home on each OS', () => {
        for (const os of MACHINE_ADD_COMMAND_OS) {
            const command = buildMachineAddCommand({ ...home, os, kind: 'joinHome', descriptor: {
                v: 1, homeServerIdentityId: 'srv_home', canonicalServerUrl: 'http://127.0.0.1:3005', revision: 1,
                endpoints: [{ kind: 'https', url: 'https://published.example.test' }],
            } });
            expect(command).toContain(' setup --home-url https://published.example.test');
            expect(command).not.toContain('127.0.0.1');
            expect(command).toContain(os === 'windows' ? 'install.ps1' : 'curl -fsSL');
        }
    });
    it('keeps an Iroh-only Home explicitly targeted by a descriptor file', () => {
        expect(buildMachineAddCommand({ ...home, os: 'linux', kind: 'joinHome', descriptor: {
            v: 1, homeServerIdentityId: 'srv_home', canonicalServerUrl: 'http://127.0.0.1:3005', revision: 1,
            endpoints: [{ kind: 'iroh', endpointId: 'endpoint-1', relayUrls: [] }],
        } })).toContain('--home-descriptor-file "$happier_home_descriptor"');
    });
    it('builds one SSH install-and-run command, preserving target, port and keyfile on all OSes', () => {
        for (const os of MACHINE_ADD_COMMAND_OS) {
            const command = buildMachineAddCommand({ ...home, kind: 'sshMachine', os, sshDraft: {
                ...createDefaultSshCredentialsDraft(), host: 'build-box', username: 'operator', port: '2222', authMode: 'keyfile', identityFilePath: '/keys/id_ed25519',
            } });
            expect(command).toContain(' machine enroll ');
            expect(command).toContain('--home-url https://home.example.test');
            expect(command).toContain('--ssh-host build-box');
            expect(command).toContain('--ssh-user operator');
            expect(command).toContain('--ssh-port 2222');
            expect(command).toContain('--ssh-auth keyfile');
            expect(command).toContain('--identity-file /keys/id_ed25519');
            expect(command).not.toContain('--role');
            expect(command).not.toContain('--admin-access');
            expect(command).toContain('--yes');
        }
    });
    it('quotes unsafe shell values for POSIX and PowerShell and never embeds a password', () => {
        const draft = { ...createDefaultSshCredentialsDraft(), host: 'box', authMode: 'keyfile' as const, identityFilePath: "C:\\keys\\O'Brien key", password: 'secret' };
        const posix = buildMachineAddCommand({ ...home, kind: 'sshMachine', os: 'linux', sshDraft: draft });
        const windows = buildMachineAddCommand({ ...home, kind: 'sshMachine', os: 'windows', sshDraft: draft });
        expect(posix).toContain("--identity-file 'C:\\keys\\O'\"'\"'Brien key'");
        expect(windows).toContain("--identity-file 'C:\\keys\\O''Brien key'");
        expect(posix + windows).not.toContain('secret');
        expect(posix + windows).not.toContain('--ssh-user');
    });
    it('detects desktop command OS and leaves unknown/mobile user agents unknown', () => {
        expect(detectClientCommandOs('Windows NT 10.0')).toBe('windows');
        expect(detectClientCommandOs('Macintosh; Intel Mac OS X')).toBe('macos');
        expect(detectClientCommandOs('X11; Linux x86_64')).toBe('linux');
        expect(detectClientCommandOs('Android Linux')).toBeNull();
        expect(detectClientCommandOs(null)).toBeNull();
    });
    it('leaves Home setup interactive and retains provider opt-out', () => {
        const command = buildMachineAddCommand({ ...home, kind: 'joinHome', os: 'linux', skipProviders: true });
        expect(command).toContain('--skip-providers');
        expect(command).not.toContain('--yes');
    });
    it('uses the account-service journey only when no Home target was supplied', () => {
        const command = buildMachineAddCommand({ ...home, fallbackHomeUrl: null, kind: 'joinHome', os: 'linux' });
        expect(command).toMatch(/&& happier setup$/);
        expect(command).not.toContain('--home-');
    });
});
