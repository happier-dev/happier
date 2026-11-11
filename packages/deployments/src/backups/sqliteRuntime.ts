/** The immutable helper identity acquired by the native image owner. */
export type SQLiteRuntimeV1 = Readonly<{
    image: string;
    version: string;
}>;

/** First publication supplies the source pin; unpublished helpers are unavailable. */
export const SQLITE_RUNTIME_V1: SQLiteRuntimeV1 | undefined = undefined;
