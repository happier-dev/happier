import { constants } from 'node:fs';
import { access, readFile, realpath } from 'node:fs/promises';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { resolveWindowsCommandOnPath } from '../process/index.js';
import { resolveDirectJavaScriptRuntimeCommand } from './managedJavaScriptRuntime.js';

export type InstalledJavaScriptTool = Readonly<{
    executablePath: string;
    args: readonly string[];
    version?: string;
    environmentOverlay?: Readonly<Record<string, string>>;
}>;

const packages: Readonly<Record<string, readonly string[]>> = {
    npm: ['npm'], yarn: ['yarn', '@yarnpkg/cli-dist'], pnpm: ['pnpm', '@pnpm/exe'],
};
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Installed metadata only. Never boots a runtime, downloads a manager or invokes a PATH shim. */
export async function resolveInstalledJavaScriptTool(tool: string, processEnv: NodeJS.ProcessEnv = process.env): Promise<InstalledJavaScriptTool | null> {
    if (tool !== 'node' && !Object.hasOwn(packages, tool)) return null;
    const runtime = resolveDirectJavaScriptRuntimeCommand({ isBunRuntime: false, processEnv });
    if (!runtime || !isAbsolute(runtime) || !/^node(?:\.exe)?$/i.test(basename(runtime))) return null;
    const runtimeVersion = runtime === process.execPath ? process.versions.node : undefined;
    if (tool === 'node') return { executablePath: runtime, args: [], ...(runtimeVersion ? { version: runtimeVersion } : {}) };
    const candidates: string[] = [];
    if (process.platform === 'win32') {
        const command = await resolveWindowsCommandOnPath(tool, processEnv);
        if (command) {
            candidates.push(command);
            // npm's Windows shims are siblings of the installed node_modules.
            for (const name of packages[tool]) {
                const packageRoot = join(dirname(command), 'node_modules', name);
                try {
                    const pkg: unknown = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
                    if (record(pkg) && record(pkg.bin) && typeof pkg.bin[tool] === 'string') candidates.push(resolve(packageRoot, pkg.bin[tool]));
                } catch { /* An absent package is not installation authority. */ }
            }
        }
    } else {
        for (const directory of (processEnv.PATH ?? '').split(delimiter).filter(Boolean)) {
            const candidate = join(directory, tool);
            try { await access(candidate, constants.X_OK); candidates.push(candidate); break; }
            catch { /* Keep the host PATH selection order. */ }
        }
    }
    for (const candidate of candidates) {
        const entrypoint = await realpath(candidate).catch(() => null);
        if (!entrypoint || !/\.(?:c?js|mjs)$/i.test(entrypoint)) continue;
        for (let directory = dirname(entrypoint);;) {
            let pkg: unknown;
            try { pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')); }
            catch { pkg = undefined; }
            if (pkg !== undefined) {
                if (!record(pkg) || typeof pkg.name !== 'string' || !packages[tool].includes(pkg.name)
                    || typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(pkg.version)) break;
                const bin = typeof pkg.bin === 'string' ? pkg.bin : record(pkg.bin) ? pkg.bin[tool] : undefined;
                if (typeof bin !== 'string') break;
                const declared = resolve(directory, bin);
                const within = relative(directory, declared);
                if (isAbsolute(within) || within === '..' || within.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
                    || await realpath(declared).catch(() => null) !== entrypoint) break;
                return { executablePath: runtime, args: [entrypoint], version: pkg.version,
                    environmentOverlay: { PATH: [dirname(runtime), processEnv.PATH ?? ''].filter(Boolean).join(delimiter) } };
            }
            const parent = dirname(directory);
            if (parent === directory) break;
            directory = parent;
        }
    }
    return null;
}
