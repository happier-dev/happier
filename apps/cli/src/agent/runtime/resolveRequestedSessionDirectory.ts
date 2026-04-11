import { realpathSync } from 'node:fs';

import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';

export const SESSION_REQUESTED_DIRECTORY_ENV = 'HAPPIER_SESSION_REQUESTED_DIRECTORY' as const;
export const STACK_INVOKED_CWD_ENV = 'HAPPIER_STACK_INVOKED_CWD' as const;

function normalizeNonEmptyString(value: string | undefined | null): string | null {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return normalized.length > 0 ? normalized : null;
}

function resolveLogicalPwd(params: Readonly<{
    env: NodeJS.ProcessEnv;
    cwd: string;
}>): string | null {
    const pwd = normalizeNonEmptyString(params.env.PWD);
    if (!pwd) {
        return null;
    }

    try {
        if (realpathSync(pwd) === realpathSync(params.cwd)) {
            return pwd;
        }
    } catch {
        return null;
    }

    return null;
}

export function consumeRequestedSessionDirectoryFromEnvironment(
    env: NodeJS.ProcessEnv = process.env,
): string | null {
    const requestedDirectory = normalizeNonEmptyString(env[SESSION_REQUESTED_DIRECTORY_ENV]);
    delete env[SESSION_REQUESTED_DIRECTORY_ENV];
    return requestedDirectory;
}

export function resolveRequestedSessionDirectory(params?: Readonly<{
    requestedDirectory?: string | null;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
}>): string {
    const env = params?.env ?? process.env;
    const explicitDirectory = normalizeNonEmptyString(params?.requestedDirectory);
    if (explicitDirectory) {
        return expandHomeDirPath(explicitDirectory, env);
    }

    const cwd = params?.cwd ?? process.cwd();
    const requestedDirectory = consumeRequestedSessionDirectoryFromEnvironment(env);
    if (requestedDirectory) {
        return expandHomeDirPath(requestedDirectory, env);
    }

    const stackInvokedCwd = normalizeNonEmptyString(env[STACK_INVOKED_CWD_ENV]);
    if (stackInvokedCwd) {
        return expandHomeDirPath(stackInvokedCwd, env);
    }

    return expandHomeDirPath(resolveLogicalPwd({ env, cwd }) ?? cwd, env);
}
