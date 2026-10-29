import type { Metadata } from '../state/index.js';

export function resolveToolPath(path: string, metadata: Metadata | null): string {
    if (!metadata) {
        return path;
    }
    if (path.toLowerCase().startsWith(metadata.path.toLowerCase())) {
        // Check that the path is actually within the metadata path by ensuring
        // there's either an exact match or a path separator after the metadata path
        const remainder = path.slice(metadata.path.length);
        if (remainder === '' || remainder.startsWith('/')) {
            let out = remainder;
            if (out.startsWith('/')) {
                out = out.slice(1);
            }
            if (out === '') {
                return '<root>';
            }
            return out;
        }
    }
    return path;
}
