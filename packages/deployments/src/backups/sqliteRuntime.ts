/** The immutable helper identity acquired by the native image owner. */
export type SQLiteRuntimeV1 = Readonly<{
    image: string;
    version: string;
}>;

/** First publication supplies the source pin; unpublished helpers are unavailable. */
export const SQLITE_RUNTIME_V1: SQLiteRuntimeV1 | undefined = undefined;

export type SQLiteRuntimeUnavailableV1 = Readonly<{
    ok: false;
    code: 'deployment_sqlite_runtime_unavailable';
    reason: 'sqlite_backup_helper_not_published';
    remedy: 'wait_for_sqlite_backup_helper_publication';
    message: string;
}>;

/** Review and backup admission share the publication decision; no helper is acquired here. */
export function readSQLiteRuntimeAvailabilityV1(): Readonly<{ ok: true; runtime: SQLiteRuntimeV1 }> | SQLiteRuntimeUnavailableV1 {
    if (SQLITE_RUNTIME_V1) return { ok: true, runtime: SQLITE_RUNTIME_V1 };
    return { ok: false, code: 'deployment_sqlite_runtime_unavailable', reason: 'sqlite_backup_helper_not_published',
        remedy: 'wait_for_sqlite_backup_helper_publication', message: 'SQLite backup helper not yet published' };
}
