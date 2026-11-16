import { describe, expect, it } from 'vitest';
import { redactProcessCommand } from './redactProcessCommand';
import { createHappierLinuxScopeName } from '@/daemon/platform/linux/systemdUserResourceGovernor';
import { createWindowsJobCustodyName } from '@/subprocess/supervision/processCustody';

describe('redactProcessCommand', () => {
    it.each([
        '--key=fixture-key',
        String.raw`--reauth-proof-json={\"proof\":\"fixture proof\"}`,
        '--current-password=a b',
    ])('hides a whole quoted Windows argument %s and preserves following flags', argument => {
        for (const quote of ['"', "'"]) {
            for (const suffix of ['', 'fixture-suffix']) {
                expect(redactProcessCommand(`happier ${quote}${argument}${quote}${suffix} --port=5173`))
                    .toBe(`happier ${argument.slice(0, argument.indexOf('='))}=[REDACTED] --port=5173`);
            }
        }
    });
    it.each(['--access-token', '--credential', '--session-id', '--recovery', '--proof'])('preserves Doctor follow-on privacy for %s', flag => {
        for (const args of [[flag, 'fixture private words'], [`${flag}=fixture private words`]]) {
            const redacted = redactProcessCommand(['agent', ...args, '--port=5173']);
            expect(redacted).not.toContain('fixture private words');
            expect(redacted).toContain('--port=5173');
        }
    });
    it.each(['/usr/local/bin/codex', String.raw`C:\Program Files\Codex\codex.exe`])('hides relay bearer inline-table assignments in %s argv and native command strings', executable => {
        const bearer = 'b'.repeat(43);
        for (const prefix of ['', 'PUBLIC_MODE="development",']) {
            const override = `mcp_servers.happier.env={${prefix}HAPPIER_SESSION_MCP_BEARER="${bearer}"}`;
            const argv = [executable, '-c', override, '--port=5173'];
            const windows = executable.endsWith('.exe');
            const nativeCommand = windows
                ? `"${executable}" -c "${override.replaceAll('"', '\\"')}" --port=5173`
                : argv.join(' ');
            for (const command of [argv, nativeCommand]) {
                const redacted = redactProcessCommand(command);
                expect(redacted.includes(bearer)).toBe(false);
                expect(redacted).toContain('HAPPIER_SESSION_MCP_BEARER=[REDACTED]');
                expect(redacted).toContain('mcp_servers.happier.env={');
                if (Array.isArray(command) || !windows) expect(redacted).toContain('--port=5173');
                if (prefix) expect(redacted).toContain('PUBLIC_MODE=');
            }
        }
    });
    it.each(['TOKEN', 'PASSWORD', 'API_KEY', 'SECRET', 'MY_TOKEN', 'OPENAI_API_KEY'])('hides bare and prefixed %s assignments in argv and command strings', name => {
        const value = 'ordinary credential with spaces';
        expect(redactProcessCommand(['env', `${name}=${value}`, 'MODE=development', 'agent', '--port=5173']))
            .toBe(`env ${name}=[REDACTED] MODE=development agent --port=5173`);
        for (const quote of ['"', "'"]) {
            expect(redactProcessCommand(`env ${name}=${quote}${value}${quote} MODE=development agent --port=5173`))
                .toBe(`env ${name}=[REDACTED] MODE=development agent --port=5173`);
        }
        expect(redactProcessCommand(`env ${name}=ordinary-credential agent`)).toBe(`env ${name}=[REDACTED] agent`);
        expect(redactProcessCommand(['env', `${name}=`, 'agent'])).toBe(`env ${name}=[REDACTED] agent`);
        expect(redactProcessCommand(`env ${name}= agent`)).toBe(`env ${name}=[REDACTED] agent`);
    });
    it.each(['https://alice:ordinary-password@example.test/path', 'postgresql://alice:p%40ss@[::1]:5432/db', 'ssh://alice@example.test/repo'])
        ('hides URL userinfo in argv and command strings without losing the endpoint: %s', url => {
            const endpoint = url.slice(url.lastIndexOf('@') + 1);
            const redacted = url.slice(0, url.indexOf('://') + 3) + '[REDACTED]@' + endpoint;
            expect(redactProcessCommand(['agent', '--endpoint', url, '--port=5173'])).toBe(`agent --endpoint ${redacted} --port=5173`);
            expect(redactProcessCommand(`agent --endpoint="${url}" --port=5173`)).toBe(`agent --endpoint="${redacted}" --port=5173`);
        });
    it('preserves public URLs, paths containing an at-sign, and ordinary assignments', () => {
        const command = 'env MODE=development agent https://example.test/alice@public ./alice@local --port=5173';
        expect(redactProcessCommand(command)).toBe(command);
        expect(redactProcessCommand(command.split(' '))).toBe(command);
    });
    it('consumes escaped double quotes within credential values without leaking their suffix', () => {
        expect(redactProcessCommand('env TOKEN="ordinary\\"credential suffix" agent --port=5173'))
            .toBe('env TOKEN=[REDACTED] agent --port=5173');
        expect(redactProcessCommand('agent --password="ordinary\\"credential suffix" --port=5173'))
            .toBe('agent --password=[REDACTED] --port=5173');
    });
    it('consumes complete shell credential words, including joined quotes and escaped spaces', () => {
        for (const value of ['ordinary" credential suffix"', '"ordinary credential"suffix', 'ordinary\\ credential', "'ordinary'\\''credential suffix'"]) {
            expect(redactProcessCommand(`env TOKEN=${value} MODE=development agent --port=5173`))
                .toBe('env TOKEN=[REDACTED] MODE=development agent --port=5173');
            expect(redactProcessCommand(`agent --password=${value} --port=5173`))
                .toBe('agent --password=[REDACTED] --port=5173');
        }
    });
    it('hides credential assignments quoted as a whole argument in native command strings', () => {
        for (const quote of ['"', "'"]) {
            expect(redactProcessCommand(`env ${quote}TOKEN=ordinary credential${quote} MODE=development agent`))
                .toBe('env TOKEN=[REDACTED] MODE=development agent');
            expect(redactProcessCommand(`env ${quote}TOKEN=ordinary credential${quote}suffix MODE=development agent`))
                .toBe('env TOKEN=[REDACTED] MODE=development agent');
        }
    });
    it('hides the remaining credential in a native command with an unclosed quote', () => {
        expect(redactProcessCommand('env TOKEN="ordinary incomplete credential')).toBe('env TOKEN=[REDACTED]');
        expect(redactProcessCommand('env "TOKEN=ordinary incomplete credential')).toBe('env TOKEN=[REDACTED]');
    });
    it('retains userinfo-free URL queries and fragments containing at-signs', () => {
        const command = 'agent https://example.test?email=alice@example.org https://example.test#alice@example.org';
        expect(redactProcessCommand(command)).toBe(command);
        expect(redactProcessCommand(command.split(' '))).toBe(command);
    });
    it('hides canonical private scope and job transports without hiding ordinary service names', () => {
        const tag = 'v1.123456789abc.session.private-session';
        const unit = createHappierLinuxScopeName(tag)!;
        const job = createWindowsJobCustodyName(tag);
        expect(redactProcessCommand(['systemd-run', `--unit=${unit}`, 'agent'])).not.toContain('123456789abc');
        expect(redactProcessCommand(['runner', '--job', job])).not.toContain(job);
        expect(redactProcessCommand(`runner --job ${job}`)).not.toContain(job);
        expect(redactProcessCommand(['systemd-run', '--unit=ordinary-service', 'runner', '--job', 'ordinary-job'])).toContain('ordinary-service runner --job ordinary-job');
    });
    it('does not disclose private owner markers embedded by native launch wrappers', () => {
        const value = 'HAPPIER_PROCESS_OWNER=v1.123456789abc.session.private-session';
        expect(redactProcessCommand(['env', '-i', value, 'agent'])).not.toContain('private-session');
        expect(redactProcessCommand(`env -i ${value} agent`)).not.toContain('private-session');
    });
    it.each(['--api-token', '--recovery-key', '--key', '--verification-token', '--invitation-token', '--current-password', '--reauth-proof-json'])
        ('hides the value of Happier CLI secret flag %s in argv and command strings', flag => {
            const value = 'hap_v1_ordinarycredentialvalue';
            for (const command of [['happier', flag, value, 'daemon', 'status'], ['happier', `${flag}=${value}`, 'daemon', 'status'],
                `happier ${flag} ${value} daemon status`, `happier ${flag}=${value} daemon status`]) {
                const redacted = redactProcessCommand(command);
                expect(redacted).not.toContain(value);
                expect(redacted).toContain(flag);
                expect(redacted).toContain('daemon status');
            }
        });
    it('redacts the whole secret argv value, including whitespace, without dropping valid long arguments', () => {
        const long = 'x'.repeat(1500);
        const command = redactProcessCommand(['agent', '--token=alpha beta', '--password', 'secret words', long]);
        expect(command).toContain('--token=[REDACTED]');
        expect(command).not.toContain('alpha');
        expect(command).not.toContain('beta');
        expect(command).not.toContain('secret words');
        expect(command).toContain(long);
    });
});
