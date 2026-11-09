import { cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NativeRun } from './nativeSystemBackend.js';
import { observeNativeFileProbe, renderNativeIniKeys, validateNativeFail2banFile } from './nativeFileFormats.js';

// Redirect only the installed OS config root; staging, copying, replacement,
// removal and cleanup all use the real filesystem.
const os = vi.hoisted(() => ({ configRoot: '' }));
vi.mock('node:fs/promises', async importOriginal => {
    const fs = await importOriginal<typeof import('node:fs/promises')>();
    return { ...fs, cp: (source: string, target: string, options: Parameters<typeof cp>[2]) =>
        fs.cp(source === '/etc/fail2ban' ? os.configRoot : source, target, options) };
});
const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
    os.configRoot = '';
});
const success = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const jail = { maxRetry: 4, findTimeSeconds: 600, banTimeSeconds: 3600, port: 2222 };
const fail2banProbe = { kind: 'fail2ban' as const, jails: { 'happier-sshd': jail } };
function fail2banRun(overrides: Record<string, string> = {}): NativeRun {
    return async (executable, args) => {
        expect(executable).toBe('fail2ban-client');
        const values: Record<string, string> = {
            'get happier-sshd maxretry': '4\n', 'get happier-sshd findtime': '600\n',
            'get happier-sshd bantime': '3600\n',
            'get happier-sshd actions': 'The jail happier-sshd has the following actions:\nnftables-multiport\n',
            'get happier-sshd actionproperties nftables-multiport': 'The jail happier-sshd action nftables-multiport has the following properties:\nport, protocol, actionban\n',
            'get happier-sshd action nftables-multiport port': '2222\n',
        };
        const value = overrides[args.join(' ')] ?? values[args.join(' ')];
        if (value === undefined) throw new Error(`Unexpected native request: ${args.join(' ')}`);
        return success(value);
    };
}

describe('native INI key rendering', () => {
    it('updates only requested DNF keys and preserves foreign sections, keys and comments', () => {
        const before = '# administrator config\n[commands]\nupgrade_type = default\nrandom_sleep = 0\napply_updates = no\n\n[emitters]\nemit_via = motd\n';
        const requested = { commands: { upgrade_type: 'security', apply_updates: 'yes' } };
        const after = renderNativeIniKeys(before, requested);
        expect(after).toContain('[commands]\nupgrade_type = security\nrandom_sleep = 0\napply_updates = yes\n');
        expect(after).toContain('# administrator config\n');
        expect(after).toContain('[emitters]\nemit_via = motd\n');
        expect(renderNativeIniKeys(after, requested)).toBe(after);
    });

    it('adds missing keys inside their section and appends missing sections without swallowing foreign keys', () => {
        const after = renderNativeIniKeys('[commands]\nrandom_sleep = 0\n[emitters]\nemit_via = motd', {
            commands: { upgrade_type: 'security', apply_updates: 'yes' }, base: { debuglevel: '1' },
        });
        expect(after).toContain('[commands]\nrandom_sleep = 0\nupgrade_type = security\napply_updates = yes\n[emitters]');
        expect(after).toContain('emit_via = motd\n');
        expect(after).toContain('[base]\ndebuglevel = 1\n');
    });

    it('replaces duplicate target keys instead of leaving a later insecure override', () => {
        const after = renderNativeIniKeys('[commands]\nupgrade_type=default\nupgrade_type = default\n', {
            commands: { upgrade_type: 'security' },
        });
        expect(after).not.toContain('default');
        expect(renderNativeIniKeys(after, { commands: { upgrade_type: 'security' } })).toBe(after);
    });
});

describe('native fail2ban candidate validation', () => {
    it('tests candidate bytes with the installed filters and foreign jails before activation and cleans up', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-fail2ban-test-')); roots.push(root);
        os.configRoot = join(root, 'installed');
        await mkdir(join(os.configRoot, 'jail.d'), { recursive: true });
        await mkdir(join(os.configRoot, 'filter.d'));
        await writeFile(join(os.configRoot, 'jail.d', 'happier.local'), 'old owned policy');
        await writeFile(join(os.configRoot, 'jail.d', 'foreign.local'), 'foreign jail');
        await writeFile(join(os.configRoot, 'filter.d', 'sshd.conf'), 'installed filter');
        const candidate = join(root, 'candidate'); await writeFile(candidate, 'new owned policy');
        let stagedRoot = '';
        await validateNativeFail2banFile(async (executable, args) => {
            expect(executable).toBe('fail2ban-client'); expect(args).toContain('-t');
            stagedRoot = args[args.indexOf('-c') + 1]!;
            expect(await readFile(join(stagedRoot, 'jail.d', 'happier.local'), 'utf8')).toBe('new owned policy');
            expect(await readFile(join(stagedRoot, 'jail.d', 'foreign.local'), 'utf8')).toBe('foreign jail');
            expect(await readFile(join(stagedRoot, 'filter.d', 'sshd.conf'), 'utf8')).toBe('installed filter');
            return success();
        }, candidate, '/etc/fail2ban/jail.d/happier.local');
        await expect(lstat(stagedRoot)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(join(os.configRoot, 'jail.d', 'happier.local'), 'utf8')).toBe('old owned policy');
    });

    it('validates removal with only the owned jail omitted and rejects invalid native configuration', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-fail2ban-test-')); roots.push(root);
        os.configRoot = join(root, 'installed'); await mkdir(join(os.configRoot, 'jail.d'), { recursive: true });
        await writeFile(join(os.configRoot, 'jail.d', 'happier.local'), 'owned policy');
        await expect(validateNativeFail2banFile(async (_executable, args) => {
            const stagedRoot = args[args.indexOf('-c') + 1]!;
            await expect(lstat(join(stagedRoot, 'jail.d', 'happier.local'))).rejects.toMatchObject({ code: 'ENOENT' });
            return { code: 1, stdout: '', stderr: 'invalid configuration' };
        }, undefined, '/etc/fail2ban/jail.d/happier.local')).rejects.toMatchObject({ reasonCode: 'validation_failed' });
        expect(await readFile(join(os.configRoot, 'jail.d', 'happier.local'), 'utf8')).toBe('owned policy');
    });
});

describe('native effective security file probes', () => {
    it('requires live requested fail2ban retry/window/ban and action port values', async () => {
        expect(await observeNativeFileProbe('jail', fail2banProbe, fail2banRun())).toMatchObject({ status: 'satisfied' });
        expect(await observeNativeFileProbe('jail', fail2banProbe, fail2banRun({ 'get happier-sshd findtime': '1\n' })))
            .toMatchObject({ status: 'drifted' });
        expect(await observeNativeFileProbe('jail', fail2banProbe, fail2banRun({ 'get happier-sshd action nftables-multiport port': '22\n' })))
            .toMatchObject({ status: 'drifted' });
        expect(await observeNativeFileProbe('jail', fail2banProbe, fail2banRun({ 'get happier-sshd maxretry': 'not a number\n' })))
            .toMatchObject({ status: 'unavailable', reason: 'required_fact_unavailable' });
    });

    it('does not treat unavailable fail2ban process evidence as satisfied', async () => {
        expect(await observeNativeFileProbe('jail', fail2banProbe,
            async () => ({ code: null, stdout: '', stderr: '', errorCode: 'ENOENT' })))
            .toMatchObject({ status: 'unsupported', reason: 'required_fact_unavailable',
                facts: { requiredFact: 'commandExecutable', executable: 'fail2ban-client' } });
    });

    it('reads comma-separated action identities and ignores notification actions without a port property', async () => {
        expect(await observeNativeFileProbe('jail', fail2banProbe, fail2banRun({
            'get happier-sshd actions': 'The jail happier-sshd has the following actions:\nnftables-multiport, mail\n',
            'get happier-sshd actionproperties mail': 'The jail happier-sshd action mail has the following properties:\nactionban, sender\n',
        }))).toMatchObject({ status: 'satisfied' });
    });

    it('distinguishes a missing jail from an unreadable fail2ban daemon', async () => {
        expect(await observeNativeFileProbe('jail', fail2banProbe,
            async () => ({ code: 1, stdout: "Sorry but the jail 'happier-sshd' does not exist\n", stderr: '' })))
            .toMatchObject({ status: 'drifted' });
        expect(await observeNativeFileProbe('jail', fail2banProbe,
            async () => ({ code: 1, stdout: '', stderr: 'Failed to access socket path' })))
            .toMatchObject({ status: 'unavailable', reason: 'required_fact_unavailable' });
    });

    it('proves exact loaded audit watch identity and permission set while preserving foreign rules', async () => {
        const probe = { kind: 'audit' as const, rules: ['-w /etc/passwd -p wa -k happier-host-security'] };
        const run = (listing: string): NativeRun => async (executable, args) => {
            expect(executable).toBe('auditctl');
            return success(args[0] === '-s' ? 'enabled 1\npid 123\n' : listing);
        };
        expect(await observeNativeFileProbe('audit', probe, run('-w /etc/passwd -p aw -F key=happier-host-security\n-w /foreign -p wa -k foreign\n')))
            .toMatchObject({ status: 'satisfied' });
        expect(await observeNativeFileProbe('audit', probe, run('-w /etc/passwd -p r -k happier-host-security\n')))
            .toMatchObject({ status: 'drifted' });
        expect(await observeNativeFileProbe('audit', { ...probe, state: 'absent' }, run('No rules\n')))
            .toMatchObject({ status: 'satisfied' });
        expect(await observeNativeFileProbe('audit', { ...probe, state: 'absent' }, run('-w /etc/passwd -p wa -k happier-host-security\n')))
            .toMatchObject({ status: 'drifted' });
        expect(await observeNativeFileProbe('audit', { ...probe, state: 'absent' }, async (_executable, args) =>
            args[0] === '-l' ? success('No rules\n') : { code: 1, stdout: '', stderr: 'status unavailable' }))
            .toMatchObject({ status: 'satisfied' });
    });

    it('keeps unreadable audit inventory unavailable', async () => {
        expect(await observeNativeFileProbe('audit', { kind: 'audit', rules: ['-w /etc/passwd -p wa -k happier-host-security'] },
            async () => ({ code: 1, stdout: '', stderr: 'permission denied' })))
            .toMatchObject({ status: 'unavailable', reason: 'required_fact_unavailable' });
    });

    it('does not report loaded rules ready while auditing is disabled or a foreign never-task rule bypasses them', async () => {
        const probe = { kind: 'audit' as const, rules: ['-w /etc/passwd -p wa -k happier-host-security'] };
        const run = (enabled: number, suppress = ''): NativeRun => async (_executable, args) =>
            success(args[0] === '-s' ? `enabled ${enabled}\npid 123\n` : `${suppress}${probe.rules[0]}\n`);
        expect(await observeNativeFileProbe('audit', probe, run(0))).toMatchObject({ status: 'drifted' });
        expect(await observeNativeFileProbe('audit', probe, run(1, '-a never,task\n')))
            .toMatchObject({ status: 'unavailable', reason: 'foreign_effect_conflict' });
    });
});
