import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

import { execFileWithDeadline, windowsSystemToolCommand } from '@happier-dev/cli-common/process';
import { startFileWatcher } from '@/integrations/watcher/startFileWatcher';
import { parseCrontab, parseLaunchdSchedule, parseSystemdTimers, parseSystemdTimerSchedules, parseWindowsScheduledTasks } from './parsers';

export type ScheduledJob = {
    id: string;
    name: string;
    schedule: string;
    nextRun?: string;
    lastRun?: string;
    enabled?: boolean;
};
export type ScheduledSource = { source: string; kind: 'available'; jobs: ScheduledJob[] }
    | { source: string; kind: 'unavailable'; reason: string };

const SYSTEM_CRON = 'cron:/etc/crontab';
const DIRECTORY_CRON = 'cron:/etc/cron.d';
const USER_CRON = 'cron:user';
const SYSTEMD = 'systemd:timers';
const WINDOWS_TASKS = 'windows:task-scheduler';
const launchdDirectories = () => ['/System/Library/LaunchDaemons', '/System/Library/LaunchAgents',
    '/Library/LaunchDaemons', '/Library/LaunchAgents', join(homedir(), 'Library', 'LaunchAgents')];

// The projection deliberately never reads task Actions or returns executable
// content: cron/plist/task commands can carry credentials in their arguments.
const WINDOWS_TASK_QUERY = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$service = New-Object -ComObject 'Schedule.Service'
$service.Connect()
$triggerTypes = @{ 0='event'; 1='once'; 2='daily'; 3='weekly'; 4='monthly'; 5='monthly day-of-week';
    6='idle'; 7='registration'; 8='boot'; 9='logon'; 11='session state change' }
function Read-Folder($folder) {
    foreach ($task in $folder.GetTasks(1)) {
        $schedules = @($task.Definition.Triggers | ForEach-Object {
            $trigger = $_
            $kind = $triggerTypes[[int]$trigger.Type]
            if (-not $kind) { $kind = 'type=' + $trigger.Type }
            $parts = @($kind)
            foreach ($field in @('StartBoundary','DaysInterval','WeeksInterval','DaysOfWeek','DaysOfMonth','MonthsOfYear','WeeksOfMonth')) {
                if ($null -ne $trigger.$field -and [string]$trigger.$field -ne '') { $parts += $field + '=' + [string]$trigger.$field }
            }
            if ($trigger.Repetition.Interval) { $parts += 'Repeat=' + $trigger.Repetition.Interval }
            $parts -join ' '
        })
        [pscustomobject]@{ id = $task.Path; name = $task.Name; schedule = $(if ($schedules.Count) { $schedules -join '; ' } else { 'on demand' });
            enabled = [bool]$task.Enabled;
            nextRun = $(if ($task.NextRunTime.Year -gt 1899) { $task.NextRunTime.ToUniversalTime().ToString('o') } else { $null });
            lastRun = $(if ($task.LastRunTime.Year -gt 1899) { $task.LastRunTime.ToUniversalTime().ToString('o') } else { $null }) }
    }
    foreach ($child in $folder.GetFolders(0)) { Read-Folder $child }
}
$rows = @(Read-Folder ($service.GetFolder('\\')))
ConvertTo-Json -InputObject $rows -Compress
`;

function nativeReason(error: unknown): string {
    if (typeof error === 'object' && error !== null && 'code' in error) {
        const code = error.code;
        if (typeof code === 'number' || typeof code === 'string' && /^[A-Za-z0-9_]+$/.test(code)) return `native_${code}`;
    }
    return error instanceof SyntaxError || error instanceof TypeError ? 'native_output_invalid' : 'native_read_failed';
}
async function command(command: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
    const result = await execFileWithDeadline(command, args, {
        encoding: 'utf8', maxBuffer: Infinity, signal, env: { ...process.env, LC_ALL: 'C', SYSTEMD_COLORS: '0' },
    });
    return result.stdout.toString();
}
async function source(source: string, read: () => Promise<ScheduledJob[]>): Promise<ScheduledSource> {
    try { return { source, kind: 'available', jobs: await read() }; }
    catch (error) { return { source, kind: 'unavailable', reason: nativeReason(error) }; }
}
async function directorySources(directory: string, prefix: string, read: (path: string) => Promise<ScheduledJob[]>, accept: (file: string) => boolean): Promise<ScheduledSource[]> {
    const sourceName = `${prefix}:${directory}`;
    try {
        const entries = await readdir(directory, { withFileTypes: true });
        const results = await Promise.all(entries.filter(entry => (entry.isFile() || entry.isSymbolicLink()) && accept(entry.name))
            .sort((a, b) => a.name.localeCompare(b.name)).map(entry => {
                const path = join(directory, entry.name);
                return source(`${prefix}:${path}`, () => read(path));
            }));
        return [{ source: sourceName, kind: 'available', jobs: results.flatMap(result => result.kind === 'available' ? result.jobs : []) },
            ...results.filter(result => result.kind === 'unavailable')];
    } catch (error) { return [{ source: sourceName, kind: 'unavailable', reason: nativeReason(error) }]; }
}

/** Admission/consent belongs to the native observation RPC owner, before this read. */
export async function readNativeScheduledSources(options: { signal?: AbortSignal } = {}): Promise<ScheduledSource[]> {
    const { signal } = options;
    if (process.platform === 'linux') {
        const results = await Promise.all([
            source(SYSTEM_CRON, async () => parseCrontab(await readFile('/etc/crontab', { encoding: 'utf8', signal }), '/etc/crontab', true)),
            directorySources('/etc/cron.d', 'cron', async path => parseCrontab(await readFile(path, { encoding: 'utf8', signal }), path, true), file => /^[\w-]+$/.test(file)),
            source(USER_CRON, async () => {
                try { return parseCrontab(await command('crontab', ['-l'], signal), USER_CRON, false); }
                catch (error) {
                    // crontab(1) distinguishes an absent table with this C-locale diagnostic.
                    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 1
                        && 'stderr' in error && /^no crontab for [^\r\n]+\s*$/.test(String(error.stderr))) return [];
                    throw error;
                }
            }),
            source(SYSTEMD, async () => {
                const timers = parseSystemdTimers(await command('systemctl', ['list-timers', '--all', '--no-pager', '--output=json'], signal));
                if (!timers.length) return [];
                const definitions = await command('systemctl', ['show', '--property=Id,TimersCalendar,TimersMonotonic', '--no-pager', '--', ...timers.map(timer => timer.id)], signal);
                const schedules = parseSystemdTimerSchedules(definitions);
                return timers.map(({ id, name }) => {
                    const schedule = schedules.get(id);
                    if (!schedule) throw new TypeError('Missing systemd timer schedule');
                    // Definitions are read on demand. Runtime next/last fields need
                    // a subscribed D-Bus connection, so this projection omits them.
                    return { id, name, schedule };
                });
            }),
        ]);
        return results.flat();
    }
    if (process.platform === 'darwin') {
        return (await Promise.all(launchdDirectories().map(directory => directorySources(directory, 'launchd',
            async path => parseLaunchdSchedule(await command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path], signal), path), file => file.endsWith('.plist'))))).flat();
    }
    if (process.platform === 'win32') return [await source(WINDOWS_TASKS, async () => parseWindowsScheduledTasks(
        await command(windowsSystemToolCommand('powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_TASK_QUERY], signal)))];
    return [{ source: 'native', kind: 'unavailable', reason: 'platform_unsupported' }];
}

/** Owns only demanded native subscriptions; no timer, polling or retry loop. */
export function subscribeNativeScheduledChanges(onChange: () => void, onUnavailable?: (source: string, reason: string) => void): () => void {
    let active = true;
    const stops: (() => void)[] = [];
    const changed = () => { if (active) onChange(); };
    const unavailable = (source: string, reason: string) => { if (active) onUnavailable?.(source, reason); };
    const watch = (path: string, source: string) => {
        try {
            stops.push(startFileWatcher(path, changed, { emitInitial: false, recovery: 'events', onWatcherAttached: changed,
                onWatcherUnavailable: error => unavailable(source, `watch_${nativeReason(error)}`) }));
        } catch (error) { unavailable(source, `watch_${nativeReason(error)}`); }
    };
    if (process.platform === 'linux') {
        watch('/etc/crontab', SYSTEM_CRON);
        watch('/etc/cron.d', DIRECTORY_CRON);
        // systemd has no existing change producer here. Its owner reads on
        // presentation and explicit refresh rather than claiming live push.
        void (async () => {
            const username = userInfo().username;
            const directory = await stat('/var/spool/cron/crontabs').then(() => '/var/spool/cron/crontabs', error => {
                if (nativeReason(error) === 'native_ENOENT') return '/var/spool/cron';
                throw error;
            });
            if (active) watch(join(directory, username), USER_CRON);
        })().catch(error => unavailable(USER_CRON, `watch_${nativeReason(error)}`));
    } else if (process.platform === 'darwin') {
        for (const directory of launchdDirectories()) watch(directory, `launchd:${directory}`);
    } else if (process.platform !== 'win32') unavailable('native', 'platform_unsupported');
    // Windows, like systemd, reads on presentation/explicit refresh. No new
    // subscription process is introduced for a source without an existing producer.
    return () => { active = false; for (const stop of stops) stop(); };
}
