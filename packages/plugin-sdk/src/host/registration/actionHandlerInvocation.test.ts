import { describe, expect, it } from 'vitest';

import {
    isPluginActionHandlerInvocationKnownNotStarted,
    PluginError,
} from '../../errors.js';
import { createPluginActionHandlerNotStartedError } from './index.js';

describe('createPluginActionHandlerNotStartedError', () => {
    it('stamps the host-proven pre-handler outcome through the host registration boundary', () => {
        const error = createPluginActionHandlerNotStartedError({
            code: 'plugin_action_unavailable',
            message: 'Plugin Action is unavailable to this caller',
            retryable: true,
        });

        expect(error).toBeInstanceOf(PluginError);
        expect(error).toMatchObject({
            code: 'plugin_action_unavailable',
            retryable: true,
            actionHandlerInvocation: 'notStarted',
            data: {
                name: 'PluginError',
                code: 'plugin_action_unavailable',
                actionHandlerInvocation: 'notStarted',
            },
        });
        expect(Object.isFrozen(error.data)).toBe(true);
        expect(isPluginActionHandlerInvocationKnownNotStarted(error)).toBe(true);
    });
});
