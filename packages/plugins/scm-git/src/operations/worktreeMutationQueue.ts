import { dirname, join, resolve } from 'node:path';
import { resolveGitAdminPath } from '../checkoutIdentity.js';
import { readRepositoryFileSystem } from '../repositoryFileSystem.js';

const pending = new Map<string, Promise<void>>();
async function repositoryKey(cwd: string): Promise<string> {
    const files = readRepositoryFileSystem();
    let current = resolve(cwd);
    for (;;) {
        try {
            const dotGit = join(current, '.git');
            let common = dotGit;
            try {
                const text = Buffer.from(await files.readFile(dotGit)).toString('utf8');
                const commandCwd = files.commandPaths?.toCommandPath(current) ?? current;
                const admin = resolveGitAdminPath(commandCwd, text.trim());
                if (admin) {
                    const adminPath = files.commandPaths?.fromCommandPath(admin) ?? admin;
                    const relativeCommon = Buffer.from(await files.readFile(join(adminPath, 'commondir'))).toString('utf8').trim();
                    const commandCommon = resolve(admin, relativeCommon);
                    common = files.commandPaths?.fromCommandPath(commandCommon) ?? commandCommon;
                }
            } catch { /* A main checkout has a directory at .git. */ }
            const physical = await files.realpath(common);
            return process.platform === 'win32' ? physical.toLowerCase() : physical;
        } catch {
            const parent = dirname(current);
            if (parent === current) return resolve(cwd);
            current = parent;
        }
    }
}

/** One queue for the shared Git admin directory; unrelated repositories proceed independently. */
export async function withGitWorktreeMutation<T>(cwd: string, operation: () => Promise<T>): Promise<T> {
    const key = await repositoryKey(cwd);
    const previous = pending.get(key) ?? Promise.resolve();
    let release!: () => void;
    const settled = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => settled);
    pending.set(key, tail);
    await previous;
    try { return await operation(); }
    finally { release(); if (pending.get(key) === tail) pending.delete(key); }
}
