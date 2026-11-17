import { admitPsqlInput as admitSharedPsqlInput, PostgresqlInputError } from '@happier-dev/databases/postgresql';
import { PluginError } from '@happier-dev/plugin-sdk/errors';

/** The shared dialect owns lexical admission; native callers retain their typed boundary failure. */
function rethrowNativePsqlInputError(error: unknown): never {
    if (error instanceof PostgresqlInputError) {
        throw new PluginError({ code: error.code, message: 'The read-only database query is unavailable',
            details: { reason: error.reason } });
    }
    throw error;
}

export function admitPsqlInput(sql: string, mode: 'query' | 'dump'): string;
export function admitPsqlInput(sql: AsyncIterable<Uint8Array>, mode: 'dump'): Promise<void>;
export function admitPsqlInput(sql: string | AsyncIterable<Uint8Array>, mode: 'query' | 'dump'): string | Promise<void> {
    if (typeof sql === 'string') {
        try { return admitSharedPsqlInput(sql, mode); }
        catch (error) { return rethrowNativePsqlInputError(error); }
    }
    return admitSharedPsqlInput(sql, 'dump').catch(rethrowNativePsqlInputError);
}
