import { computerTargetKeyV1, resolveComputerAccess, type ComputerAccessV1, type ComputerGrantStatusV1, type ComputerTargetsListResponseV1 } from '@happier-dev/protocol/computer/v1';

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

export function needsComputerPermission(grants: ComputerGrantStatusV1, access?: ComputerAccessV1): boolean {
    return grants.capture !== 'granted' || (resolveComputerAccess(access) === 'use' && grants.input !== 'granted');
}

export type ComputerRecovery = Readonly<{
    cause: 'permission_denied' | 'permission_unknown' | 'headless' | 'unsupported' | 'machine_mismatch' | 'driver_missing' | 'driver_invalid' | 'geometry_changed' | 'input_unknown' | 'offline' | 'access_removed' | 'source_lost' | 'empty' | 'failed';
    action: 'open_settings' | 'refresh' | 'repair_driver' | 'capture' | 'reconnect' | 'choose_source' | null;
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
    if (code === 'capture_permission_denied' || code === 'input_permission_denied') return { cause: 'permission_denied', action: 'open_settings', permission: code.startsWith('capture') ? 'capture' : 'input', code };
    if (code === 'capture_permission_unknown' || code === 'input_permission_unknown') return { cause: 'permission_unknown', action: 'refresh', permission: code.startsWith('capture') ? 'capture' : 'input', code };
    if (code === 'computer_machine_mismatch') return { cause: 'machine_mismatch', action: null, code };
    if (code === 'computer_display_unavailable') return { cause: 'headless', action: null, code };
    if (code === 'target_unsupported' || code === 'computer_unavailable') return { cause: 'unsupported', action: null, code };
    if (code === 'computer_provider_unavailable' || code === 'driver_unavailable' || code === 'driver_install_failed') return { cause: 'driver_missing', action: 'repair_driver', code };
    if (code === 'driver_result_invalid' || code === 'driver_executable_invalid' || code === 'driver_version_mismatch' || code === 'driver_protocol_error') return { cause: 'driver_invalid', action: 'repair_driver', code };
    if (code === 'stale_capture' || code === 'capture_expired' || code === 'capture_generation_mismatch'
        || code === 'capture_frame_mismatch' || code === 'capture_coordinate_invalid' || code === 'capture_not_found'
        || code === 'capture_id_invalid' || code === 'capture_target_mismatch' || code === 'capture_action_refused'
        || code === 'point_outside_window' || code === 'point_outside_capture'
        || code === 'computer_element_stale') return { cause: 'geometry_changed', action: 'capture', code };
    if (code === 'human_input_interruption_uncertain' || code === 'background_unavailable') return { cause: 'input_unknown', action: 'capture', code };
    if (code === 'machine_unreachable') return { cause: 'offline', action: 'reconnect', code };
    if (code === 'forbidden') return { cause: 'access_removed', action: null, code };
    if (code === 'computer_target_not_available' || code === 'computer_target_not_open') return { cause: 'source_lost', action: 'choose_source', code };
    return { cause: 'failed', action: 'refresh', code };
}
