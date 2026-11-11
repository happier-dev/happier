import { RESTIC_VOLUME_STAGE_PATH_V1 as stage } from '@happier-dev/deployments';

/** Closed SQLite operations consumed by the existing pinned-container owner. */
export type NativeSqliteOperation = Readonly<{ kind: 'snapshot'; destination: 'backup' | 'previous' }>
    | Readonly<{ kind: 'integrity'; database: 'live' | 'restore' | 'previous' }>
    | Readonly<{ kind: 'pageSize' }>
    | Readonly<{ kind: 'normalize'; pageSize: number }>
    | Readonly<{ kind: 'activate'; source: 'restore' | 'previous' }>;

const files = { backup: `${stage}/backup.sqlite`, restore: `${stage}/restore.sqlite`, previous: `${stage}/previous.sqlite` } as const;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** livePath is produced by P41's admitted service-mount resolution. Stage names
 * are fixed here; no SQL or arbitrary container argv enters this codec. */
export function nativeSqliteCommand(operation: NativeSqliteOperation, livePath: string): Readonly<{
    argv: readonly string[]; writesLive: boolean;
}> {
    const prefix = ['-batch', '-bail'];
    switch (operation.kind) {
        case 'snapshot': return { argv: [...prefix, '-readonly', livePath,
            `VACUUM INTO ${literal(files[operation.destination])};`], writesLive: false };
        case 'pageSize': return { argv: [...prefix, '-readonly', livePath, 'PRAGMA page_size;'], writesLive: false };
        case 'integrity': return { argv: [...prefix, '-readonly', operation.database === 'live' ? livePath : files[operation.database],
            'PRAGMA integrity_check;'], writesLive: false };
        // SQLite's backup API cannot change page size in an existing WAL DB.
        // Normalize only the operation-owned stage; the live journal mode stays intact.
        case 'normalize': return { argv: [...prefix, files.restore,
            `PRAGMA journal_mode=DELETE; PRAGMA page_size=${operation.pageSize}; VACUUM;`], writesLive: false };
        case 'activate': return { argv: [...prefix, livePath, `.restore ${files[operation.source]}`], writesLive: true };
    }
}
