import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCrontab, parseLaunchdSchedule, parseSystemdTimers, parseSystemdTimerSchedules, parseWindowsScheduledTasks } from './parsers';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

describe('native scheduled-job parsing', () => {
    it('reads captured Linux system cron schedules without exposing executable content', () => {
        const jobs = parseCrontab(fixture('linux-crontab.txt'), '/etc/crontab', true);
        expect(jobs).toHaveLength(4);
        expect(jobs[0]).toMatchObject({ schedule: '17 * * * *', name: 'account' });
        expect(jobs.every(job => job.command === undefined)).toBe(true);
    });
    it('distinguishes user cron and @ schedules from assignments and comments', () => {
        expect(parseCrontab('# ignored\nMAILTO=x@y\n@reboot secret-command\n*/5 * * * * echo token=secret', 'cron:user', false))
            .toMatchObject([{ schedule: '@reboot' }, { schedule: '*/5 * * * *' }]);
    });
    it('rejects malformed cron content rather than exposing its words as a schedule', () => {
        expect(() => parseCrontab('credential secret words would otherwise become a schedule', 'cron:user', false)).toThrow();
        expect(() => parseCrontab('* * * * * TOKEN=secret command', '/etc/crontab', true)).toThrow();
    });
    it('reads captured systemd inventory and retains inactive timers', () => {
        const jobs = parseSystemdTimers(fixture('linux-systemd-timers.json'));
        expect(jobs.find(job => job.id === 'sysstat-collect.timer')).toEqual({ id: 'sysstat-collect.timer', name: 'sysstat-collect.timer' });
        expect(jobs.find(job => job.id === 'apport-autoreport.timer')).toMatchObject({ name: 'apport-autoreport.timer' });
    });
    it('retains both calendar and monotonic schedules from captured systemd definitions', () => {
        const schedules = parseSystemdTimerSchedules(fixture('linux-systemd-schedules.txt'));
        expect(schedules.get('sysstat-collect.timer')).toBe('OnCalendar=*-*-* *:00/10:00');
        expect(schedules.get('apport-autoreport.timer')).toBe('OnUnitActiveUSec=3h; OnStartupUSec=1h');
    });
    it('preserves every launchd calendar alternative and skips unscheduled launch agents', () => {
        expect(parseLaunchdSchedule(fixture('darwin-dirhelper.json'), '/redacted/dirhelper.plist'))
            .toEqual([{ id: '/redacted/dirhelper.plist', name: 'com.apple.bsd.dirhelper', schedule: 'calendar Minute=35 Hour=3' }]);
        expect(parseLaunchdSchedule(fixture('darwin-newsyslog.json'), '/redacted/newsyslog.plist'))
            .toEqual([{ id: '/redacted/newsyslog.plist', name: 'com.apple.newsyslog', schedule: 'calendar Minute=30' }]);
        // Source-derived plist fields: cli-common/service/discovery/discovery.test.ts;
        // The calendar-array neighbor follows launchd.plist(5), not a native capture.
        expect(parseLaunchdSchedule(JSON.stringify({ Label: 'com.happier.daily', ProgramArguments: ['secret'],
            StartCalendarInterval: [{ Hour: 3, Minute: 15 }, { Weekday: 1, Hour: 8 }], Disabled: true }), '/example.plist'))
            .toMatchObject([{ id: '/example.plist', name: 'com.happier.daily', schedule: 'calendar Minute=15 Hour=3; calendar Hour=8 Weekday=1' }]);
        expect(parseLaunchdSchedule('{"Label":"ordinary","RunAtLoad":true}', '/ordinary.plist')).toEqual([]);
    });
    it('reads invariant Windows task JSON, including disabled tasks and absent next runs', () => {
        // Source-derived PowerShell JSON shape; no claim of a Windows capture.
        expect(parseWindowsScheduledTasks(JSON.stringify([{ id: '\\Daily', name: 'Daily', schedule: 'daily 2026-11-13T08:00:00',
            enabled: false, lastRun: '2026-11-12T08:00:00.000Z', nextRun: null, command: 'secret' }])))
            .toEqual([{ id: '\\Daily', name: 'Daily', schedule: 'daily 2026-11-13T08:00:00', enabled: false, lastRun: '2026-11-12T08:00:00.000Z' }]);
    });
    it('rejects malformed native outputs instead of reporting an empty source', () => {
        expect(() => parseSystemdTimers('{}')).toThrow();
        expect(() => parseWindowsScheduledTasks('')).toThrow();
        expect(() => parseLaunchdSchedule('[]', '/bad.plist')).toThrow();
    });
});
