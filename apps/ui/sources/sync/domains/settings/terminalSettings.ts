import type { Settings } from './settings';

export type TerminalSpawnOptions = {
    mode: 'tmux';
    tmux: {
        sessionName: string;
        isolated: boolean;
        tmpDir: string | null;
    };
} | { mode: 'zellij' } | { mode: 'herdr'; herdr: { sessionName: string } };

export type TerminalHost = 'none' | 'tmux' | 'zellij' | 'herdr';

import { resolveTerminalHost } from '@happier-dev/protocol/actions/settings/accountSettingBindings';
export { resolveTerminalHost };

export function buildMachineTerminalSettingsPatch(params: {
    settings: Settings;
    machineId: string;
    host: TerminalHost | null;
}): Pick<Settings, 'sessionTmuxByMachineId' | 'sessionTerminalHostByMachineId'> {
    const { settings, machineId, host } = params;
    const tmuxByMachineId = { ...settings.sessionTmuxByMachineId };
    const hostByMachineId = { ...settings.sessionTerminalHostByMachineId };
    delete hostByMachineId[machineId];
    if (host === null) {
        delete tmuxByMachineId[machineId];
    } else {
        tmuxByMachineId[machineId] = {
            ...(tmuxByMachineId[machineId] ?? {
                sessionName: settings.sessionTmuxSessionName,
                isolated: settings.sessionTmuxIsolated,
                tmpDir: settings.sessionTmuxTmpDir,
            }),
            useTmux: host === 'tmux',
        };
        if (host === 'herdr' || host === 'zellij') hostByMachineId[machineId] = host;
    }
    return { sessionTmuxByMachineId: tmuxByMachineId, sessionTerminalHostByMachineId: hostByMachineId };
}

function normalizeTmuxSessionName(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    return value.trim();
}

function normalizeOptionalString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function resolveTerminalSpawnOptions(params: {
    settings: Settings;
    machineId: string | null;
}): TerminalSpawnOptions | null {
    const { settings, machineId } = params;

    const override = machineId ? settings.sessionTmuxByMachineId?.[machineId] : undefined;

    const selectedHost = resolveTerminalHost(params);
    if (selectedHost === 'none') return null;
    if (selectedHost === 'zellij') return { mode: 'zellij' };
    if (selectedHost === 'herdr') return { mode: 'herdr', herdr: { sessionName: 'default' } };

    // NOTE: empty string means "use current/most recent tmux session".
    const sessionName = (override ? normalizeTmuxSessionName(override.sessionName) : null)
        ?? normalizeTmuxSessionName(settings.sessionTmuxSessionName)
        ?? 'happy';

    const isolated = override ? override.isolated : settings.sessionTmuxIsolated;

    const tmpDir = (override ? normalizeOptionalString(override.tmpDir) : null)
        ?? normalizeOptionalString(settings.sessionTmuxTmpDir)
        ?? null;

    return {
        mode: 'tmux',
        tmux: {
            sessionName,
            isolated,
            tmpDir,
        },
    };
}
