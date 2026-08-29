import { describe, expect, it } from 'vitest';

import {
    isPluginActionHandlerInvocationNotStartedAdvisory,
    PluginError,
} from '../../errors.js';
import { createPluginActionHandlerNotStartedError } from './index.js';

describe('createPluginActionHandlerNotStartedError', () => {
    it('stamps the host-reported pre-handler outcome used as an Action retry advisory', () => {
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
        expect(isPluginActionHandlerInvocationNotStartedAdvisory(error)).toBe(true);
    });
});
