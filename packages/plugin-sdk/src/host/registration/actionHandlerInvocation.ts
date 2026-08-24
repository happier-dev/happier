import { PluginError, type PluginErrorData } from '../../errors.js';

/**
 * Constructs the one Action outcome a host can prove before target handler
 * entry. Author-facing `PluginError` construction deliberately cannot mint
 * this lifecycle fact.
 */
export function createPluginActionHandlerNotStartedError(
    data: Omit<PluginErrorData, 'name' | 'actionHandlerInvocation'>,
): PluginError {
    const error = new PluginError(data);
    Object.defineProperty(error, 'actionHandlerInvocation', {
        value: 'notStarted',
        enumerable: true,
        writable: false,
        configurable: false,
    });
    Object.defineProperty(error, 'data', {
        value: Object.freeze({ ...error.data, actionHandlerInvocation: 'notStarted' as const }),
        enumerable: true,
        writable: false,
        configurable: false,
    });
    return error;
}
