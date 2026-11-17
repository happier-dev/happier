import type { CodeEditorCompletionSource } from '@happier-dev/plugin-ui/presentation';

export type DatabaseCompletionMetadata = Readonly<{
    schemas?: readonly Readonly<{ name: string }>[];
    relations?: readonly Readonly<{ name: string; kind: string }>[];
    columns?: readonly Readonly<{ name: string; nativeType: string }>[];
}>;

/** Samples already held metadata; completing SQL never scans a database. */
export function createDatabaseCompletionSource(read: () => DatabaseCompletionMetadata): CodeEditorCompletionSource {
    return {
        async complete(_position, signal) {
            if (signal.aborted) return null;
            const metadata = read();
            const items = [
                ...(metadata.schemas ?? []).map(schema => ({ label: schema.name })),
                ...(metadata.relations ?? []).map(relation => ({ label: relation.name, detail: relation.kind })),
                ...(metadata.columns ?? []).map(column => ({ label: column.name, detail: column.nativeType })),
            ];
            return items.length ? items : null;
        },
    };
}
