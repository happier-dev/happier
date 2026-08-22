import {
    RequestAuthRequiredHeadersV1Schema,
    type QualifiedConnectedAccountRequestAuthUseV1,
} from '@happier-dev/protocol';

/**
 * Validates the only request-auth materialization shape that can be projected into the daemon
 * capability protocol. Both compatibility and manifest-qualified callers use this same parser;
 * it owns no credential access, selection, cache, or lifecycle state.
 */
export function parseHttpHeadersRequestAuthBearer(
    materialization: QualifiedConnectedAccountRequestAuthUseV1['materialization'],
    result: unknown,
): Readonly<{
    accessToken: string;
    requiredHeaders?: Readonly<Record<string, string>>;
}> {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
        throw new Error('request_auth_materialization_invalid');
    }
    const resultRecord = result as Readonly<Record<string, unknown>>;
    if (
        Reflect.ownKeys(resultRecord).some((key) =>
            typeof key !== 'string' || (key !== 'kind' && key !== 'headers'))
        || resultRecord.kind !== 'httpHeaders'
        || !resultRecord.headers
        || typeof resultRecord.headers !== 'object'
        || Array.isArray(resultRecord.headers)
    ) {
        throw new Error('request_auth_materialization_invalid');
    }
    const headersRecord = resultRecord.headers as Readonly<Record<string, unknown>>;
    const requestedNames = new Set(materialization.headerNames);
    const returnedByName = new Map<string, string>();
    for (const rawName of Reflect.ownKeys(headersRecord)) {
        if (typeof rawName !== 'string') {
            throw new Error('request_auth_materialization_invalid');
        }
        const name = rawName.toLowerCase();
        const rawValue = headersRecord[rawName];
        if (
            !requestedNames.has(name)
            || returnedByName.has(name)
            || typeof rawValue !== 'string'
            || rawValue.length === 0
            || /[\r\n]/u.test(rawValue)
        ) {
            throw new Error('request_auth_materialization_invalid');
        }
        returnedByName.set(name, rawValue);
    }
    const authorization = returnedByName.get('authorization');
    const bearer = authorization?.match(/^Bearer ([^\s\r\n]+)$/u);
    if (!bearer) {
        throw new Error('request_auth_oauth_bearer_required');
    }
    const requiredHeaders = RequestAuthRequiredHeadersV1Schema.parse(
        Object.fromEntries(
            [...returnedByName].filter(([name]) => name !== 'authorization'),
        ),
    );
    return Object.freeze({
        accessToken: bearer[1]!,
        ...(Object.keys(requiredHeaders).length > 0
            ? { requiredHeaders: Object.freeze(requiredHeaders) }
            : {}),
    });
}
