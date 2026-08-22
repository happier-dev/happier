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
