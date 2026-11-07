import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
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
            ? Object.freeze({ kind: 'unavailable' as const, code: failure.code }) : null,
        readUiProjectionInputs: (scope: ServerAccountScope) => failure && areServerAccountScopesEqual(failure.scope, scope)
            ? failure.uiInputs : null,
        fail: (next: PluginAccountAvailabilityInitialFailure, confirmedInputs?: PluginAccountUiProjectionInputs) => {
            if (failure?.code === next.code && areServerAccountScopesEqual(failure.scope, next.scope)
                && baseUiInputs === confirmedInputs) return false;
            baseUiInputs = confirmedInputs;
            failure = Object.freeze({ scope: Object.freeze({ ...next.scope }), code: next.code,
                uiInputs: Object.freeze({ ...(confirmedInputs ?? { materializations: Object.freeze([]), installedPlugins: undefined,
                    accountUiProjection: null }), unavailableReasonCode: next.code }) });
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
