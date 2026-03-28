import { describe, expect, it } from 'vitest';

import {
    consumeRequestedSessionDirectoryFromEnvironment,
    resolveRequestedSessionDirectory,
    SESSION_REQUESTED_DIRECTORY_ENV,
} from './resolveRequestedSessionDirectory';

describe('resolveRequestedSessionDirectory', () => {
    it('prefers the explicit requested directory', () => {
        expect(resolveRequestedSessionDirectory({
            requestedDirectory: '/tmp/explicit-session-directory',
            env: {},
            cwd: '/private/tmp/explicit-session-directory',
        })).toBe('/tmp/explicit-session-directory');
    });

    it('consumes the daemon-seeded requested directory from the environment', () => {
        const env: NodeJS.ProcessEnv = {
            [SESSION_REQUESTED_DIRECTORY_ENV]: '/tmp/seeded-session-directory',
            PWD: '/private/tmp/seeded-session-directory',
        };

        expect(resolveRequestedSessionDirectory({
            env,
            cwd: '/private/tmp/seeded-session-directory',
        })).toBe('/tmp/seeded-session-directory');
        expect(env[SESSION_REQUESTED_DIRECTORY_ENV]).toBeUndefined();
    });

    it('uses a logical PWD when it resolves to the same directory', () => {
        const cwd = process.cwd();
        const env: NodeJS.ProcessEnv = { PWD: cwd };

        expect(resolveRequestedSessionDirectory({ env, cwd })).toBe(cwd);
    });

    it('prefers the stack-invoked cwd when present', () => {
        const env: NodeJS.ProcessEnv = {
            HAPPIER_STACK_INVOKED_CWD: '/tmp/happier-stack-invoked-cwd',
            PWD: '/tmp/happier-wrapper-cwd',
        };

        expect(resolveRequestedSessionDirectory({
            env,
            cwd: '/tmp/happier-wrapper-cwd',
        })).toBe('/tmp/happier-stack-invoked-cwd');
    });

    it('returns null when the requested directory env seed is blank', () => {
        const env: NodeJS.ProcessEnv = { [SESSION_REQUESTED_DIRECTORY_ENV]: '   ' };

        expect(consumeRequestedSessionDirectoryFromEnvironment(env)).toBeNull();
        expect(env[SESSION_REQUESTED_DIRECTORY_ENV]).toBeUndefined();
    });
});
