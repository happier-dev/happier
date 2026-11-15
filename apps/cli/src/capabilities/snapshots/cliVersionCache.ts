import { open, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';

import { AsyncTtlCache } from '@happier-dev/protocol/common/asyncTtlCache';

import { logger } from '@/ui/logger';

export type CliVersionProbeResult = Readonly<{ version: string | null; successful: boolean }>;

type VersionFact = Readonly<{ identity: string; probeKey: string; version: string }>;
type FailedProbe = Readonly<{ identity: string; probeKey: string }>;

/**
 * Inventory reuse only; launch/install verification continues to own its fresh probes.
 *
 * A version is a fact about the executable that answered it, so it is held until that
 * executable changes on disk, not for a period of time. Native binaries are keyed on their
 * real path and stat identity. A script launcher (npm/node bin, shell or `.cmd` wrapper) is
 * keyed on its real path and stat, the stat of every file it names (its resolved target),
 * and the nearest `package.json` of each, so `npm i -g`, a vendor update or a reinstall
 * changes the key and the next read probes again. An unchanged CLI costs stat calls only.
 */
export class CliVersionCache {
    // One current executable fact per Agent, rather than one entry per historical fingerprint.
    #caches = new Map<string, AsyncTtlCache<VersionFact>>();
    #failures = new Map<string, FailedProbe>();

    clear(): void {
        // Pending probes may finish, but can publish only into their retired cache instance.
        this.#caches = new Map<string, AsyncTtlCache<VersionFact>>();
        this.#failures = new Map<string, FailedProbe>();
    }

    async read(params: Readonly<{
        name: string;
        resolvedPath: string;
        fresh: boolean;
        /** The admitted environment projection; a different one is a different observation. */
        probeKey: string;
        /** Resolves a bare command a wrapper launcher execs (PATH lookup, no process). */
        resolveCommand?: (command: string) => string | null;
        probe: () => Promise<CliVersionProbeResult>;
    }>): Promise<string | null> {
        let cache = this.#caches.get(params.name);
        if (!cache || params.fresh) {
            cache = new AsyncTtlCache<VersionFact>({ successTtlMs: Infinity, errorTtlMs: 0 });
            this.#caches.set(params.name, cache);
        }
        const identity = await readExecutableIdentity(params.resolvedPath, params.resolveCommand);
        const cached = cache.get(params.name);
        if (!params.fresh && identity && cached?.kind === 'success'
            && cached.value.identity === identity && cached.value.probeKey === params.probeKey) {
            return cached.value.version;
        }
        const failures = this.#failures;
        const failed = failures.get(params.name);
        // A probe that yielded no version (no answer, a failed process, a timeout) is remembered
        // under the same executable identity as a success, so it runs again only when the CLI
        // changes on disk or on an explicit refresh. A failed process's banner is never held.
        if (!params.fresh && identity && failed && failed.identity === identity && failed.probeKey === params.probeKey) {
            return null;
        }
        const run = async () => {
            const { version, successful } = await params.probe();
            if (!(successful && version) && identity) {
                failures.set(params.name, { identity, probeKey: params.probeKey });
            } else failures.delete(params.name);
            // Updates may retarget a launcher while the bounded process probe is running.
            // Admit only an observation bracketed by the same executable identity.
            if (successful && identity && version
                && await readExecutableIdentity(params.resolvedPath, params.resolveCommand) === identity) {
                cache.setSuccess(params.name, { identity, probeKey: params.probeKey, version });
            }
            return version;
        };
        // Explicit recovery never waits on an older ordinary observation. Only the existing
        // bounded process probe is coalesced; filesystem identity reads happen beforehand.
        return params.fresh ? await run() : await cache.runDedupe(
            JSON.stringify([params.name, params.resolvedPath, identity, params.probeKey]), run,
        );
    }
}

const NATIVE_MAGICS = [0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca];
// A launcher is a small wrapper; a larger script is the program itself (e.g. a bundled cli.js)
// and is fully keyed by its own stat and package.json without reading its text.
const LAUNCHER_TEXT_MAX_BYTES = 64 * 1024;

function statIdentity(path: string, info: Readonly<{ dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }>): unknown[] {
    return [path, info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs];
}

async function readExecutableIdentity(path: string, resolveCommand?: (command: string) => string | null): Promise<string | null> {
    try {
        const resolved = await realpath(path);
        const file = await open(resolved, 'r');
        try {
            const info = await file.stat();
            const header = Buffer.alloc(4);
            const { bytesRead } = await file.read(header, 0, header.length, 0);
            const native = bytesRead >= 4 && (header.readUInt32BE(0) === 0x7f454c46 // ELF
                || header.subarray(0, 2).toString('ascii') === 'MZ' // PE
                || NATIVE_MAGICS.includes(header.readUInt32BE(0))); // Mach-O
            if (native) return JSON.stringify(statIdentity(resolved, info));
            const text = info.size <= LAUNCHER_TEXT_MAX_BYTES
                ? (await file.read(Buffer.alloc(info.size), 0, info.size, 0)).buffer.toString('utf8') : '';
            const targets = await readLauncherTargets(resolved, text, resolveCommand);
            const packages = await Promise.all([resolved, ...targets.map(target => target[0] as string)].map(readNearestPackageJsonIdentity));
            return JSON.stringify(['launcher', statIdentity(resolved, info), targets, [...new Set(packages.map(p => JSON.stringify(p)))]]);
        } finally { await file.close(); }
    } catch (error) {
        logger.warn('[capabilities] CLI version identity unavailable; probing without version reuse', { error });
        return null;
    }
}

/** Files a wrapper names: quoted or bare path tokens (relative to the launcher), and the command it execs. */
async function readLauncherTargets(launcher: string, text: string, resolveCommand?: (command: string) => string | null): Promise<unknown[][]> {
    if (!text) return [];
    const base = dirname(launcher);
    const candidates = new Set<string>();
    const normalized = text
        .replace(/%~?dp0%?\\?/gi, `${base}/`)
        .replace(/\$\{?basedir\}?\/?/g, `${base}/`)
        .replace(/\$\(\s*dirname\s+"?\$0"?\s*\)\/?/g, `${base}/`);
    for (const match of normalized.matchAll(/["'`]([^"'`\r\n]+)["'`]|([^\s"'`;|&()<>]+)/g)) {
        const token = (match[1] ?? match[2] ?? '').trim();
        if (!token || /^[a-z]+:\/\//i.test(token)) continue;
        if (token.includes('/') || token.includes('\\') || token.startsWith('.')) {
            candidates.add(isAbsolute(token) ? token : resolve(base, token));
        }
    }
    const exec = /(?:^|\n)\s*exec\s+("?)([^\s"]+)\1/.exec(normalized)?.[2];
    if (exec && !exec.includes('/') && !exec.includes('\\')) {
        const command = resolveCommand?.(exec);
        if (command) candidates.add(command);
    }
    const targets: unknown[][] = [];
    for (const candidate of [...candidates].sort()) {
        try {
            const real = await realpath(candidate);
            if (real === launcher) continue;
            const info = await stat(real);
            if (info.isFile()) targets.push(statIdentity(real, info));
        } catch { /* Not a file this launcher can reach; not part of its identity. */ }
    }
    return targets;
}

async function readNearestPackageJsonIdentity(file: string): Promise<unknown[] | null> {
    const root = parse(file).root;
    for (let directory = dirname(file); ; directory = dirname(directory)) {
        const candidate = join(directory, 'package.json');
        const info = await stat(candidate).catch(() => null);
        if (info?.isFile()) return statIdentity(candidate, info);
        if (directory === root || dirname(directory) === directory) return null;
    }
}
