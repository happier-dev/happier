import { createPluginActionHandlerNotStartedError } from '@happier-dev/cli-common/plugins/registration/actionHandlerInvocation';
import type { PluginError } from '../errors.js';

/** A host Action transport fixture that proves no target handler was entered. */
export function createPluginActionHandlerUnavailableFixture(): PluginError {
    return createPluginActionHandlerNotStartedError({
        code: 'plugin_action_handler_missing',
        message: 'Plugin Action handler is unavailable',
    });
}
