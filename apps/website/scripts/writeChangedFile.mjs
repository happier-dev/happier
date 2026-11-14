/**
 * Generated website files are build inputs (Vite, the SSR prerender, the
 * client bundle). Rewriting identical bytes moves their mtime and invalidates
 * every cache keyed on it, so each generator here publishes only real changes.
 */
import { mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Writes `contents` unless the file already holds exactly those bytes. Returns whether it wrote. */
export function writeChangedFileSync(path, contents) {
    try {
        if (readFileSync(path, 'utf8') === contents) return false;
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, 'utf8');
    return true;
}

/**
 * Makes `dir` hold exactly `files` (relative path → contents): changed files are
 * written, unchanged ones are left alone, files no longer produced are removed.
 */
export function syncGeneratedDirectorySync(dir, files) {
    const wanted = new Set([...files.keys()].map((path) => join(dir, path)));
    let written = 0;
    let removed = 0;
    for (const [path, contents] of files) if (writeChangedFileSync(join(dir, path), contents)) written += 1;
    const prune = (current) => {
        let entries;
        try {
            entries = readdirSync(current, { withFileTypes: true });
        } catch (error) {
            if (error?.code === 'ENOENT') return;
            throw error;
        }
        for (const entry of entries) {
            const path = join(current, entry.name);
            if (entry.isDirectory()) {
                prune(path);
                if (readdirSync(path).length === 0) rmdirSync(path);
            } else if (!wanted.has(path)) {
                unlinkSync(path);
                removed += 1;
            }
        }
    };
    prune(dir);
    return { written, removed };
}
