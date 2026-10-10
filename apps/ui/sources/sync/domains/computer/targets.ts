import { computerTargetKeyV1, type ComputerAccessV1, type ComputerGrantStatusV1, type ComputerTargetsListResponseV1 } from '@happier-dev/protocol/computer/v1';

export type ComputerTargetEntry = ComputerTargetsListResponseV1['targets'][number];
export type ComputerTargetPickerState =
    | Readonly<{ kind: 'loading' }>
    | Readonly<{ kind: 'ready'; targets: readonly ComputerTargetEntry[]; grants: ComputerGrantStatusV1; displays?: ComputerTargetsListResponseV1['displays'] }>
    | Readonly<{ kind: 'failed'; code: string }>;

/** Hints highlight a listed source; only the producer's key identifies it. */
export function resolveSuggestedTargetKey(targets: readonly ComputerTargetEntry[], suggestion: string | null | undefined): string | null {
    const hint = suggestion?.trim().toLocaleLowerCase();
    if (!hint) return null;
    const match = targets.find(entry => entry.title?.toLocaleLowerCase().includes(hint) || entry.appName?.toLocaleLowerCase().includes(hint));
    return match ? computerTargetKeyV1(match.target) : null;
}

export function groupComputerTargets(targets: readonly ComputerTargetEntry[]) {
    return {
        windows: targets.filter(entry => entry.target.kind === 'window'),
        displays: targets.filter(entry => entry.target.kind === 'display'),
    };
}

export function needsComputerPermission(grants: ComputerGrantStatusV1, access: ComputerAccessV1 = 'use'): boolean {
    return grants.capture !== 'granted' || (access === 'use' && grants.input !== 'granted');
}

export type ComputerRecovery = Readonly<{
    cause: 'permission_denied' | 'permission_unknown' | 'headless' | 'unsupported' | 'machine_mismatch' | 'driver_missing' | 'driver_invalid' | 'offline' | 'access_removed' | 'source_lost' | 'empty' | 'failed';
    action: 'open_settings' | 'refresh' | 'repair_driver' | 'reconnect' | 'choose_source' | null;
    permission?: 'capture' | 'input';
    code?: string;
}>;

/** Recovery names current producer facts, without waking a Machine or treating Settings as a grant. */
export function resolveComputerRecovery(state: ComputerTargetPickerState, access: ComputerAccessV1): ComputerRecovery | null {
    if (state.kind === 'loading') return null;
    if (state.kind === 'ready') {
        const permission = state.grants.capture !== 'granted' ? 'capture'
            : access === 'use' && state.grants.input !== 'granted' ? 'input' : null;
        if (permission) return state.grants[permission] === 'denied'
            ? { cause: 'permission_denied', action: 'open_settings', permission }
            : { cause: 'permission_unknown', action: 'refresh', permission };
        return state.targets.length ? null : { cause: 'empty', action: 'refresh' };
    }
    const { code } = state;
    if (code === 'computer_machine_mismatch') return { cause: 'machine_mismatch', action: null, code };
    if (code === 'computer_display_unavailable') return { cause: 'headless', action: null, code };
    if (code === 'target_unsupported' || code === 'computer_unavailable') return { cause: 'unsupported', action: null, code };
    if (code === 'driver_unavailable' || code === 'driver_install_failed') return { cause: 'driver_missing', action: 'repair_driver', code };
    if (code === 'driver_result_invalid' || code === 'driver_executable_invalid') return { cause: 'driver_invalid', action: 'repair_driver', code };
    if (code === 'machine_unreachable') return { cause: 'offline', action: 'reconnect', code };
    if (code === 'forbidden') return { cause: 'access_removed', action: null, code };
    if (code === 'computer_target_not_available' || code === 'computer_target_not_open') return { cause: 'source_lost', action: 'choose_source', code };
    return { cause: 'failed', action: 'refresh', code };
}
