import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function normalizePathLike(pathLike: string): string {
    return String(pathLike ?? '').trim().replaceAll('\\', '/');
}

export function projectPathFromModuleUrl(moduleUrl: string): string {
    const modulePath = fileURLToPath(moduleUrl);
    const normalized = normalizePathLike(modulePath);
    for (const snapshotMarker of ['/.runner-snapshots/', '/dist/.runner-snapshots/']) {
        const snapshotIndex = normalized.lastIndexOf(snapshotMarker);
        if (snapshotIndex < 0) continue;
        const afterMarker = normalized.slice(snapshotIndex + snapshotMarker.length);
        const snapshotName = afterMarker.split('/')[0]?.trim();
        if (snapshotName) {
            return normalized.slice(0, snapshotIndex + snapshotMarker.length + snapshotName.length);
        }
    }

    let nearestTreeMarkerIndex = -1;
    // `/.dist.hstack-backup/` is the stack PM's supported rename-aside layout
    // for `dist` during a rebuild; modules booting from it still resolve to
    // the owning package root.
    for (const marker of ['/src/', '/dist/', '/package-dist/', '/.dist.hstack-backup/']) {
        nearestTreeMarkerIndex = Math.max(nearestTreeMarkerIndex, normalized.lastIndexOf(marker));
    }
    if (nearestTreeMarkerIndex >= 0) {
        return normalized.slice(0, nearestTreeMarkerIndex);
    }

    return resolve(dirname(modulePath), '..');
}

export function projectPath() {
    return projectPathFromModuleUrl(import.meta.url);
}
