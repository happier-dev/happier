import { PluginError, type PluginErrorData } from '../../errors.js';

/**
 * Creates the host-reported Action outcome marker used by the canonical
 * transport before target handler entry. Consumers may use the marker as an
 * advisory retry signal only when it arrives through that transport.
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
