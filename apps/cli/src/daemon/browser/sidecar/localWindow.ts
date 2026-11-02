import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { windowsSystemToolCommand } from '@happier-dev/cli-common/process';
import type { BrowserCommandDispatchResultV1, BrowserCommandV1 } from '@happier-dev/protocol';

export type LocalBrowserWindowUnavailableReason =
    | 'local_display_unavailable'
    | 'daemon_not_in_gui_session'
    | 'gui_session_unverified'
    | 'unsupported_platform';
export type LocalBrowserWindowAvailability =
    | Readonly<{ available: true }>
    | Readonly<{ available: false; reason: LocalBrowserWindowUnavailableReason }>;

/** Native OS/environment boundary; no GUI discovery or polling on the default headless path. */
export type LocalBrowserWindowHost = Readonly<{
    platform?: NodeJS.Platform | string;
    env?: NodeJS.ProcessEnv;
    uid?: number;
    execute?: (file: string, args: readonly string[]) => Promise<string>;
}>;

export type LocalBrowserWindowSurface = Readonly<{
    /** Process-local prototype: a single-view Session can restart in the person's GUI session. */
    showAsWindow(command: Extract<BrowserCommandV1, { kind: 'openView' }>): Promise<
        | Readonly<{ ok: true; result: BrowserCommandDispatchResultV1 }>
        | Readonly<{ ok: false; reason: LocalBrowserWindowUnavailableReason | 'shared_browser_session' | 'browser_busy'
            | 'view_not_found' | 'profile_mismatch' | 'unsupported_view' | 'open_failed'; result?: BrowserCommandDispatchResultV1 }>
    >;
}>;

const exec = promisify(execFile);
const defaultExecute = async (file: string, args: readonly string[]) =>
    (await exec(file, [...args], { windowsHide: true })).stdout;

/** Inspect this daemon's session, never another logged-in person's display or an SSH forward. */
export async function inspectLocalBrowserWindowHost(host: LocalBrowserWindowHost = {}): Promise<LocalBrowserWindowAvailability> {
    const platform = host.platform ?? process.platform;
    const env = host.env ?? process.env;
    const execute = host.execute ?? defaultExecute;
    if (platform !== 'linux' && platform !== 'darwin' && platform !== 'win32') {
        return { available: false, reason: 'unsupported_platform' };
    }
    if (platform === 'linux' && !env.DISPLAY?.trim() && !env.WAYLAND_DISPLAY?.trim()) {
        return { available: false, reason: 'local_display_unavailable' };
    }
    if (env.SSH_CONNECTION || env.SSH_TTY) return { available: false, reason: 'daemon_not_in_gui_session' };
    try {
        let graphical = false;
        if (platform === 'linux') {
            // `self`, unlike `auto`, cannot fall back from a service/TTY to somebody's GUI login.
            const output = await execute('loginctl', ['show-session', 'self', '--property=User,Active,Remote,Type,Display']);
            const properties = new Map(output.trim().split('\n').map(line => {
                const separator = line.indexOf('=');
                return [line.slice(0, separator), line.slice(separator + 1).trim()];
            }));
            const uid = host.uid ?? process.getuid?.();
            const type = properties.get('Type');
            graphical = uid !== undefined && properties.get('User') === String(uid)
                && properties.get('Active') === 'yes' && properties.get('Remote') === 'no'
                && (type === 'wayland' && Boolean(env.WAYLAND_DISPLAY?.trim())
                    || type === 'x11' && Boolean(properties.get('Display'))
                        && properties.get('Display') === env.DISPLAY?.trim().replace(/\.\d+$/, ''));
        } else if (platform === 'darwin') {
            graphical = (await execute('/bin/launchctl', ['managername'])).trim() === 'Aqua';
        } else {
            // Query the actual daemon pid rather than the probe's parent shell or SESSIONNAME.
            const script = `$s=(Get-Process -Id ${process.pid} -ErrorAction Stop).SessionId; [Environment]::UserInteractive -and $s -ne 0 -and [bool](Get-Process explorer -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $s })`;
            graphical = (await execute(windowsSystemToolCommand('powershell.exe', env), ['-NoProfile', '-NonInteractive', '-Command', script])).trim() === 'True';
        }
        return graphical ? { available: true } : { available: false, reason: 'daemon_not_in_gui_session' };
    } catch {
        // OS diagnostics may contain private environment details; expose only this settled reason.
        return { available: false, reason: 'gui_session_unverified' };
    }
}
