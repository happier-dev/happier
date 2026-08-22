import { describe, expect, it } from 'vitest';

import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';

import {
    PluginExecClientError,
    createPluginExecClientAbortError,
    createPluginExecClientExitError,
} from './errors';
import { PluginExecError } from './hostService';

describe('plugin exec error contract', () => {
    it('delivers every exec-client failure through the canonical public PluginError contract', () => {
        const constructed = new PluginExecClientError(
            'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR',
            'JSON-RPC frame exceeded the configured size limit',
            { stderrPreview: 'boom', cause: new Error('cause') },
        );

        expect(constructed).toBeInstanceOf(PluginError);
        expect(isPluginError(constructed)).toBe(true);
        expect(constructed).toMatchObject({
            name: 'PluginError',
            code: 'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR',
            message: 'JSON-RPC frame exceeded the configured size limit',
            retryable: false,
            stderrPreview: 'boom',
        });
        expect(constructed.data).toMatchObject({
            name: 'PluginError',
            code: 'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR',
        });
        expect(constructed.cause).toBeInstanceOf(Error);

        const aborted = createPluginExecClientAbortError();
        expect(isPluginError(aborted)).toBe(true);
        expect(aborted.code).toBe('PLUGIN_EXEC_CLIENT_ABORTED');

        const exited = createPluginExecClientExitError(
            { exitCode: 0, signal: null },
            ' stderr tail ',
        );
        expect(isPluginError(exited)).toBe(true);
        expect(exited).toMatchObject({
            code: 'PLUGIN_EXEC_CLIENT_EXITED',
            cleanProcessExit: true,
            stderrPreview: 'stderr tail',
        });
    });

    it('delivers exec launch denials through the canonical public PluginError contract', () => {
        const denied = new PluginExecError(
            'PLUGIN_EXEC_PERMISSION_DENIED',
            'Process launch is not authorized for this plugin',
        );

        expect(denied).toBeInstanceOf(PluginError);
        expect(isPluginError(denied)).toBe(true);
        expect(denied).toMatchObject({
            name: 'PluginError',
            code: 'PLUGIN_EXEC_PERMISSION_DENIED',
            retryable: false,
        });
    });
});
