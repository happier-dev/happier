import { open, realpath } from 'node:fs/promises';

import { AsyncTtlCache } from '@happier-dev/protocol';

import { logger } from '@/ui/logger';

type VersionFact = Readonly<{ identity: string; version: string }>;

/** Inventory reuse only; launch/install verification continues to own its fresh probes. */
export class CliVersionCache {
    // One current executable fact per provider, rather than one entry per historical fingerprint.
    #caches = new Map<string, AsyncTtlCache<VersionFact>>();

    clear(): void {
        // Pending probes may finish, but can publish only into their retired cache instance.
        this.#caches = new Map<string, AsyncTtlCache<VersionFact>>();
    }

    async read(params: Readonly<{
        name: string;
        resolvedPath: string;
        nativeInstall: boolean;
        fresh: boolean;
        probeKey: string;
        probe: () => Promise<string | null>;
    }>): Promise<string | null> {
        let cache = this.#caches.get(params.name);
        if (!cache || params.fresh) {
            cache = new AsyncTtlCache<VersionFact>({ successTtlMs: Infinity, errorTtlMs: 0 });
            this.#caches.set(params.name, cache);
        }
        const identity = params.nativeInstall ? await readNativeExecutableIdentity(params.resolvedPath) : null;
        const cached = cache.get(params.name);
        if (!params.fresh && identity && cached?.kind === 'success' && cached.value.identity === identity) {
            return cached.value.version;
        }
        const run = async () => {
            const version = await params.probe();
            // Updates may retarget a launcher while the bounded process probe is running.
            // Admit only an observation bracketed by the same executable identity.
            if (identity && version && await readNativeExecutableIdentity(params.resolvedPath) === identity) {
                cache.setSuccess(params.name, { identity, version });
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

async function readNativeExecutableIdentity(path: string): Promise<string | null> {
    try {
        const resolved = await realpath(path);
        const file = await open(resolved, 'r');
        try {
            const header = Buffer.alloc(4);
            const { bytesRead } = await file.read(header, 0, header.length, 0);
            if (bytesRead < 4) return null;
            const magic = header.readUInt32BE(0);
            // Eligibility, not executable validation: exclude opaque script/shim launchers.
            const native = magic === 0x7f454c46 // ELF
                || header.subarray(0, 2).toString('ascii') === 'MZ' // PE
                || [0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic); // Mach-O
            if (!native) return null;
            const info = await file.stat();
            return JSON.stringify([resolved, info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs]);
        } finally { await file.close(); }
    } catch (error) {
        logger.warn('[capabilities] Native CLI version identity unavailable; probing without version reuse', { error });
        return null;
    }
}
