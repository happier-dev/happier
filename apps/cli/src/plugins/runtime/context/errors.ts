import { PluginError } from '@happier-dev/plugin-sdk';

/**
 * Plugin context service failures cross the plugin ABI, so they ARE canonical
 * PluginErrors: `PluginError.code` names the failure and `PluginError.retryable`
 * is the single retryability fact, decided by the throw site that knows it.
 * Never assign `name` here - `isPluginError` recognizes the contract by
 * name+data, not by class identity.
 */
export class PluginContextServiceError extends PluginError {
    constructor(code: string, message: string, retryable = false) {
        super({ code, message, ...(retryable ? { retryable } : {}) });
    }
}

export type PluginTerminalHostErrorCode =
    | 'PLUGIN_TERMINAL_HOST_CAPABILITY_REQUIRED'
    | 'PLUGIN_TERMINAL_HOST_SCOPE_RETIRED'
    | 'PLUGIN_TERMINAL_HOST_UNAVAILABLE'
    | 'PLUGIN_TERMINAL_HOST_UNRESOLVED_LAUNCH'
    | 'PLUGIN_TERMINAL_HOST_HANDLE_NOT_ACTIVE'
    | 'PLUGIN_TERMINAL_HOST_HANDLE_KIND_MISMATCH'
    | 'PLUGIN_TERMINAL_HOST_UNSUPPORTED_LAUNCH';

/**
 * Terminal-host failures reach plugin authors through the Agent session host
 * services, so they ARE canonical PluginErrors. Never assign `name` here -
 * `isPluginError` recognizes the contract by name+data, not by class identity.
 */
export class PluginTerminalHostError extends PluginError {
    constructor(code: PluginTerminalHostErrorCode, message: string) {
        super({ code, message });
    }
}
