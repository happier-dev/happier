import { describe, expect, it, vi } from 'vitest';

// Only OS file/process boundaries are replaced. The process completion helper,
// native reader and all schedule parsers run through their production path.
vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual,
        readFile: async () => '17 * * * * root TOKEN=secret echo private',
        readdir: async () => { throw Object.assign(new Error('private OS detail'), { code: 'EACCES' }); },
    };
});
vi.mock('node:child_process', async importOriginal => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return { ...actual, execFile: (command: string, args: string[], _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void) => {
        const child = new actual.ChildProcess();
        const absent = command === 'crontab';
        queueMicrotask(() => {
            const stdout = args[0] === 'list-timers' ? '[{"unit":"daily.timer","next":null,"last":0}]'
                : 'TimersCalendar={ OnCalendar=*-*-* 00:00:00 ; next_elapse=never }\nId=daily.timer\n';
            callback(absent ? Object.assign(new Error('not installed'), { code: 1, stderr: 'no crontab for test\n' }) : null,
                absent ? '' : stdout, absent ? 'no crontab for test\n' : '');
            child.emit('exit', absent ? 1 : 0, null);
            child.emit('close', absent ? 1 : 0, null);
        });
        return child;
    } };
});

import { readNativeScheduledSources } from './native';

describe.skipIf(process.platform !== 'linux')('native scheduled source isolation', () => {
    it('settles unreadable cron.d separately from valid cron, absent user crontab and systemd timers', async () => {
        const sources = await readNativeScheduledSources();
        expect(sources).toEqual([
            { source: 'cron:/etc/crontab', kind: 'available', jobs: [
                { id: '/etc/crontab:1', name: 'root', schedule: '17 * * * *' },
            ] },
            { source: 'cron:/etc/cron.d', kind: 'unavailable', reason: 'native_EACCES' },
            { source: 'cron:user', kind: 'available', jobs: [] },
            { source: 'systemd:timers', kind: 'available', jobs: [
                { id: 'daily.timer', name: 'daily.timer', schedule: 'OnCalendar=*-*-* 00:00:00' },
            ] },
        ]);
        expect(JSON.stringify(sources)).not.toMatch(/secret|private|next_elapse/);
    });
});
