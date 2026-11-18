import { describe, expect, it, vi } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

// App configuration is the environment adapter; retain the real command and release-ring owners.
vi.mock('@/config', () => ({ config: { variant: 'production', identityVariant: 'stable' } }));
import { buildMachineAddCommand, detectClientCommandOs, MACHINE_ADD_COMMAND_OS, resolveWebDesktopSetupHandoffTarget } from './machineAddCommand';
import { createDefaultSshCredentialsDraft } from '@/components/ssh/sshCredentialsDraft';
import { MachineAddCommandInputSchema } from '@happier-dev/protocol/actions/specs/machineConnection';
import { ManagedMachineEnrollmentIdentityV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';

import { createCliPayloadFixture } from '../../../../../../packages/cli-common/src/systemTasks/testkit/createCliPayloadFixture.ts';
import { readServerGuestCliIdentity } from '../../../../../server/sources/app/runtime/serverRelease.ts';

const home = { descriptor: null, fallbackHomeUrl: 'https://home.example.test',
    guestCli: { source: 'public-release' as const, line: '0.3', channel: 'stable' as const } };
describe('machine add commands', () => {
    it.each(MACHINE_ADD_COMMAND_OS)('honors a source Home artifact identity even for a user-added address (%s)', os => {
        const target = { ...home, fallbackHomeUrl: 'http://happier-agent-qa-l12-c.localhost:3039',
            guestCli: { source: 'home-payload' as const, line: '0.3', channel: 'publicdev' as const } };
        expect(resolveWebDesktopSetupHandoffTarget({ ...target, os })).toMatchObject({ kind: 'unavailable', code: 'guest_payload_missing' });
        expect(buildMachineAddCommand({ ...target, os, kind: 'joinHome' })).toBeNull();
        expect(buildMachineAddCommand({ ...target, os, remote: true, kind: 'sshMachine', sshDraft: createDefaultSshCredentialsDraft() })).toBeNull();
        // Copied setup consumes the same server-owned archive pin as managed enrollment.
        const exported = { ...target, guestCli: { ...target.guestCli, payloads: [
            { target: { os: os === 'macos' ? 'darwin' as const : 'linux' as const, arch: 'x64' as const }, sha256: '4b'.repeat(32),
                url: `/v1/runtime/guest-cli/payloads/${os === 'macos' ? 'darwin' : 'linux'}/x64` },
        ] } };
        expect(resolveWebDesktopSetupHandoffTarget({ ...exported, os })).toMatchObject(os === 'windows'
            ? { kind: 'unavailable', code: 'guest_payload_missing' }
            : { kind: 'https' });
        const command = buildMachineAddCommand({ ...exported, os, kind: 'joinHome' });
        if (os === 'windows') expect(command).toBeNull(); // The managed archive contract supports Linux/macOS.
        else {
            expect(command).toContain('4b'.repeat(32));
            expect(command).not.toContain('https://happier.dev/install');
            const anotherMachine = buildMachineAddCommand({ ...exported, fallbackHomeUrl: 'https://home.example.test',
                os, remote: true, kind: 'joinHome' });
            expect(anotherMachine).toContain('4b'.repeat(32));
            expect(anotherMachine).toContain('https://home.example.test/v1/runtime/guest-cli/payloads/');
            expect(anotherMachine).not.toContain('https://happier.dev/install');
        }
    });
    it.skipIf(process.platform !== 'linux').each(['bash', 'dash'])('runs copied setup from the server pin and stops failed installs (%s)', async shell => {
        const fixture = await createCliPayloadFixture();
        const root = mkdtempSync(join(tmpdir(), 'machine-add-home-export-'));
        const calls = join(root, 'setup-args');
        const extracted = join(root, 'extracted');
        const cli = join(fixture.payloadRoot, 'happier');
        const original = readFileSync(cli, 'utf8');
        // The executable is the process boundary; self-install runs the real promotion owner.
        writeFileSync(cli, original.replace('#!/bin/sh\n', `#!/bin/sh\nif [ "$1" = setup ]; then printf '%s\\n' "$@" > '${calls}'; exit 0; fi\n`));
        const archivePath = join(root, 'payload.tar.gz');
        execFileSync('tar', ['-czf', archivePath, '-C', dirname(fixture.payloadRoot), basename(fixture.payloadRoot)]);
        let archive = readFileSync(archivePath);
        const digest = createHash('sha256').update(archive).digest('hex');
        const requests: string[] = [];
        const server = createServer((request, response) => {
            requests.push(request.url ?? '');
            response.end(archive);
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        try {
            const address = server.address();
            if (!address || typeof address === 'string') throw new Error('Expected HTTP listener');
            const homeUrl = `http://127.0.0.1:${address.port}`;
            const guestCli = readServerGuestCliIdentity({ HAPPIER_DEV_GUEST_CLI_EXPORT: '1',
                HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_METADATA: JSON.stringify({ archives: [
                    { target: { os: 'linux', arch: 'x64' }, sha256: digest, archivePath },
                ] }),
            });
            const command = buildMachineAddCommand({ descriptor: null, fallbackHomeUrl: homeUrl, guestCli, os: 'linux', kind: 'joinHome' });
            expect(command).toEqual(expect.any(String));
            if (!command) throw new Error('Expected copied Home-payload setup command');
            const tools = join(root, 'tools'); mkdirSync(tools);
            const actualTar = execFileSync('/bin/sh', ['-c', 'command -v tar'], { encoding: 'utf8' }).trim();
            writeFileSync(join(tools, 'tar'), `#!/bin/sh\nprintf extracted > '${extracted}'\nexec '${actualTar}' "$@"\n`, { mode: 0o755 });
            const run = (homeDir: string) => promisify(execFile)(shell, ['-c', command], {
                env: { ...process.env, HOME: homeDir, PATH: `${tools}:${process.env.PATH}` },
            });
            await run(join(root, 'first-home'));
            expect(readFileSync(calls, 'utf8')).toBe(`setup\n--home-url\n${homeUrl}\n`);
            expect(existsSync(extracted)).toBe(true);
            rmSync(calls); rmSync(extracted);
            // A checked install subshell must propagate both extraction and promotion failures.
            for (const step of ['tar', 'chmod']) {
                writeFileSync(join(tools, step), step === 'tar'
                    ? `#!/bin/sh\n'${actualTar}' "$@" || exit $?\nprintf extracted > '${extracted}'\nexit 42\n`
                    : '#!/bin/sh\nexit 42\n', { mode: 0o755 });
                await expect(run(join(root, `${step}-failure-home`))).rejects.toMatchObject({ code: 42 });
                expect(existsSync(calls)).toBe(false);
                expect(existsSync(extracted)).toBe(true);
                rmSync(extracted);
                if (step === 'chmod') rmSync(join(tools, step));
                writeFileSync(join(tools, 'tar'), `#!/bin/sh\nprintf extracted > '${extracted}'\nexec '${actualTar}' "$@"\n`, { mode: 0o755 });
            }
            // Reuse the copied command: a reload cannot silently change its pinned digest.
            archive = Buffer.concat([archive, Buffer.from([0])]);
            await expect(run(join(root, 'second-home'))).rejects.toThrow();
            expect(existsSync(calls)).toBe(false);
            expect(existsSync(extracted)).toBe(false);
            expect(requests).toEqual(Array(4).fill('/v1/runtime/guest-cli/payloads/linux/x64'));
        } finally {
            server.closeAllConnections();
            await new Promise<void>(resolve => server.close(() => resolve()));
            await fixture.cleanup(); rmSync(root, { recursive: true, force: true });
        }
    });
    it.each(MACHINE_ADD_COMMAND_OS)('uses a declared public release regardless of profile provenance (%s)', os => {
        const target = { ...home, profileSource: 'stack-env' as const };
        expect(resolveWebDesktopSetupHandoffTarget({ ...target, os })).toMatchObject({ kind: 'https' });
        expect(buildMachineAddCommand({ ...target, os, kind: 'joinHome' })).toContain('--home-url https://home.example.test');
    });
    it.each([
        ['loading', /Reading how this Home installs Happier/],
        ['unreadable', /Couldn’t reach this Home/],
        ['ready', /doesn’t say which Happier CLI/],
    ] as const)('says why no installer is offered while the Home CLI identity is unknown (%s)', (homeFeatures, message) => {
        const handoff = resolveWebDesktopSetupHandoffTarget({ ...home, guestCli: undefined, homeFeatures, os: 'linux' });
        expect(handoff).toMatchObject({ kind: 'unavailable', code: 'guest_cli_identity_unavailable' });
        expect('message' in handoff ? handoff.message : null).toMatch(message);
    });
    it('does not offer a public installer while the Home artifact identity is unknown', () => {
        const target = { ...home, guestCli: undefined };
        expect(resolveWebDesktopSetupHandoffTarget({ ...target, os: 'linux' })).toMatchObject({ kind: 'unavailable', code: 'guest_cli_identity_unavailable' });
        expect(buildMachineAddCommand({ ...target, os: 'linux', kind: 'joinHome' })).toBeNull();
    });
    it.each(['http://happier-agent-qa-unified-work-dev.localhost:3009', 'http://127.0.0.1:3009', 'https://[::1]:3009'])(
        'refuses controller-only setup on another computer while preserving same-computer setup (%s)', url => {
            const target = { ...home, fallbackHomeUrl: url, descriptor: { v: 1 as const, homeServerIdentityId: 'srv_home',
                canonicalServerUrl: url, revision: 1, endpoints: [{ kind: 'https' as const, url }] } };
            expect(resolveWebDesktopSetupHandoffTarget({ ...target, remote: true, os: 'linux' })).toEqual({ kind: 'unavailable', code: 'home_not_guest_reachable' });
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
            writeFileSync(join(root, 'curl'), `#!/bin/sh
cat <<'INSTALLER'
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--" ]; then shift; exec happier setup "$@"; fi
  shift
done
exit 2
INSTALLER
`, { mode: 0o755 });
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
            expect(command).toContain(os === 'windows' ? '-Run setup --home-url https://published.example.test' : '--run setup -- --home-url https://published.example.test');
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
            expect(command).toContain(os === 'windows' ? '-Run machine-enroll ' : '--run machine-enroll -- ');
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
        expect(command).toMatch(/--run setup$/);
        expect(command).not.toContain('--home-');
    });
});
