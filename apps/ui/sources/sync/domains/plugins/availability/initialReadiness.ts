import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { carryActionFailureDiagnostic } from '@happier-dev/protocol/actions/executor/actionFailureDiagnostic';
import type { PluginAccountUiProjectionInputs } from './reader';

export type PluginAccountAvailabilityInitialFailure = Readonly<{
    scope: ServerAccountScope;
    code: 'plugin_availability_invalid_response' | 'plugin_availability_unavailable';
}>;

/** Initial failure is not an empty inventory or withdrawal of confirmed facts. */
export function createPluginAccountAvailabilityInitialReadiness() {
    let failure: (PluginAccountAvailabilityInitialFailure & Readonly<{ uiInputs: PluginAccountUiProjectionInputs }>) | null = null;
    let baseUiInputs: PluginAccountUiProjectionInputs | undefined;
    return {
        getSnapshot: () => failure,
        read: (scope: ServerAccountScope) => failure && areServerAccountScopesEqual(failure.scope, scope)
            ? Object.freeze(carryActionFailureDiagnostic({ kind: 'unavailable' as const, code: failure.code }, failure)) : null,
        readUiProjectionInputs: (scope: ServerAccountScope) => failure && areServerAccountScopesEqual(failure.scope, scope)
            ? failure.uiInputs : null,
        fail: (next: PluginAccountAvailabilityInitialFailure, confirmedInputs?: PluginAccountUiProjectionInputs) => {
            if (failure?.code === next.code && areServerAccountScopesEqual(failure.scope, next.scope)
                && baseUiInputs === confirmedInputs) return false;
            baseUiInputs = confirmedInputs;
            const uiInputs = Object.freeze({ ...(confirmedInputs ?? { materializations: Object.freeze([]), installedPlugins: undefined,
                accountUiProjection: null }), unavailableReasonCode: next.code });
            failure = Object.freeze(carryActionFailureDiagnostic({ scope: Object.freeze({ ...next.scope }), code: next.code, uiInputs }, next));
            return true;
        },
        clear: () => {
            const changed = failure !== null;
            failure = null;
            baseUiInputs = undefined;
            return changed;
        },
    };
}
