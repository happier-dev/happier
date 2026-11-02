import type { ComputerProviderSettingsRow } from '@/sync/domains/computer/computerProviderSettings';
import type { ComputerProviderSettingsMutation } from '@/sync/domains/computer/useComputerProviderSettings';

export type ComputerProviderStatusKind =
    | 'none' | 'checking' | 'installsOnEnable' | 'installing' | 'installed' | 'missing' | 'failed' | 'unavailable';

export type ComputerProviderRowState = Readonly<{
    status: Readonly<{ kind: ComputerProviderStatusKind; tone: 'quiet' | 'warn' | 'bad'; busy: boolean }>;
    /** The one inline next step the status line offers: repair a missing install, retry a failed one, or make an enabled provider the default. */
    action: 'install' | 'retry' | 'makeDefault' | null;
    /** Null for the default: it is always on, and the row says "Default" where the switch would be. */
    toggle: Readonly<{ value: boolean; disabled: boolean; lockedReason: 'unavailable' | 'offline' | null }> | null;
}>;

/**
 * Which state a provider row shows (one status line, one control). Healthy is quiet; only a missing
 * install of an enabled provider and a failed install speak, and each brings its own next step.
 */
export function resolveComputerProviderRowState(args: Readonly<{
    row: ComputerProviderSettingsRow;
    mutation: ComputerProviderSettingsMutation;
    online: boolean;
}>): ComputerProviderRowState {
    const { row, mutation } = args;
    const installing = (mutation.phase === 'installing' && mutation.provider === row.provider) || row.availability === 'installing';
    const failed = mutation.phase === 'failed' && mutation.provider === row.provider;
    const busy = mutation.phase === 'installing' || mutation.phase === 'saving';

    const status: ComputerProviderRowState['status'] = installing ? { kind: 'installing', tone: 'quiet', busy: true }
        : failed ? { kind: 'failed', tone: 'bad', busy: false }
            : row.availability === 'unavailable' ? { kind: 'unavailable', tone: row.enabled ? 'warn' : 'quiet', busy: false }
                : row.availability === 'ready' ? { kind: 'installed', tone: 'quiet', busy: false }
                    : row.availability === 'not_installed'
                        ? row.enabled ? { kind: 'missing', tone: 'warn', busy: false } : { kind: 'installsOnEnable', tone: 'quiet', busy: false }
                        : row.availability === 'loading' ? { kind: 'checking', tone: 'quiet', busy: true }
                            : { kind: 'none', tone: 'quiet', busy: false };
    // Changing the default saves a preference only; it never installs (the machine's resolver checks the install per call).
    const action = status.kind === 'failed' ? 'retry'
        : status.kind === 'missing' ? 'install'
            : row.enabled && !row.isDefault && (status.kind === 'installed' || status.kind === 'none') ? 'makeDefault' : null;

    // Turning one on installs it, so it needs a platform that has it and the machine online; turning one off is
    // only a saved preference.
    const lockedReason = !row.enabled && row.availability === 'unavailable' ? 'unavailable'
        : !row.enabled && !args.online ? 'offline' : null;
    return {
        status,
        action: busy ? null : action,
        toggle: row.isDefault ? null : { value: row.enabled || installing, disabled: lockedReason !== null, lockedReason },
    };
}
