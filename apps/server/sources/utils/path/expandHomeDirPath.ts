import { homedir as defaultHomedir } from 'node:os';
import { join } from 'node:path';

export function resolveHomeDirFromEnvironment(env: NodeJS.ProcessEnv): string {
    const fromEnv = process.platform === 'win32'
        ? (env.USERPROFILE ?? env.HOME)
        : env.HOME;
    const trimmed = String(fromEnv ?? '').trim();
    return trimmed || defaultHomedir();
}

export function expandHomeDirPath(value: string, env: NodeJS.ProcessEnv): string {
    if (value === '~') return resolveHomeDirFromEnvironment(env);
    if (value.startsWith('~/') || value.startsWith('~\\')) {
        return join(resolveHomeDirFromEnvironment(env), value.slice(2));
    }
    return value;
}
