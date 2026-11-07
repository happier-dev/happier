import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

/** Reuse the local read-only file service; this never publishes files or changes its scopes/authentication. */
export async function resolveFileDownloadUrl(filePath: string): Promise<string | null> {
    const configPath = process.env.HAPPIER_FILES_DOWNLOAD_LINK_CONFIG;
    if (!configPath) return null;
    let raw: string;
    try {
        raw = await readFile(configPath, 'utf8');
    } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null;
        throw new Error('Unable to read the direct download service configuration');
    }
    const config: unknown = JSON.parse(raw);
    if (!config || typeof config !== 'object' || !('origin' in config) || typeof config.origin !== 'string'
        || !('roots' in config) || !config.roots || typeof config.roots !== 'object' || Array.isArray(config.roots)) {
        throw new Error('Invalid direct download service configuration');
    }
    const origin = new URL(config.origin);
    if (origin.protocol !== 'https:' || !origin.hostname.endsWith('.ts.net') || origin.username || origin.password
        || origin.pathname !== '/' || origin.search || origin.hash) {
        throw new Error('Direct downloads require a Tailscale HTTPS origin');
    }
    if (!isAbsolute(filePath)) return null;
    const absolutePath = resolve(filePath);
    for (const [scope, root] of Object.entries(config.roots)) {
        if (!/^[a-z0-9-]+$/.test(scope) || typeof root !== 'string' || !isAbsolute(root)) continue;
        const withinRoot = relative(resolve(root), absolutePath);
        if (!withinRoot || withinRoot === '..' || withinRoot.startsWith(`..${sep}`) || isAbsolute(withinRoot)) continue;

        // Match the service's no-symlink/special-file/hard-link contract, including root ancestors.
        let cursor = parse(absolutePath).root;
        for (const part of absolutePath.slice(cursor.length).split(sep)) {
            cursor = join(cursor, part);
            const info = await lstat(cursor);
            if (info.isSymbolicLink()) return null;
            if (cursor === absolutePath ? !info.isFile() || info.nlink !== 1 : !info.isDirectory()) return null;
        }
        const parts = withinRoot.split(sep);
        if (parts.some(part => /[\\/\u0000-\u001f\u007f]/.test(part))) return null;
        return `${origin.origin}/browse/${scope}/${parts.map(encodeURIComponent).join('/')}?download=1`;
    }
    return null;
}
