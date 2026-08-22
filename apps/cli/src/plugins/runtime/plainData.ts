import { cloneStrictPluginJsonValue } from '@happier-dev/protocol/plugins/actions/json-schema-validation';

export type ClonePluginPlainDataOptions = Readonly<{
    path?: string;
    invalid(message: string): Error;
}>;

export function clonePluginPlainData<T>(value: T, options: ClonePluginPlainDataOptions): T {
    try {
        return cloneStrictPluginJsonValue(value, options.path ?? 'value') as T;
    } catch (error) {
        throw options.invalid(
            error instanceof Error ? error.message : `${options.path ?? 'value'} must contain strict JSON data`,
        );
    }
}
