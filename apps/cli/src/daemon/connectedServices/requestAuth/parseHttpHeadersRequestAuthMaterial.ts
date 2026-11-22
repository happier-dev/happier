import { RequestAuthHeaderMapV1Schema, RequestAuthFactsV1Schema } from '@happier-dev/protocol/connect/connected-account-request-auth';
import type { QualifiedConnectedAccountRequestAuthUseV1, RequestAuthFactsV1 } from '@happier-dev/protocol';
import { ConnectedAccountRequestAuthError } from './ConnectedAccountRequestAuthService';

/** The plugin adapter boundary for complete declared request-auth material. */
export function parseHttpHeadersRequestAuthMaterial(
    materialization: QualifiedConnectedAccountRequestAuthUseV1['materialization'],
    result: unknown,
): Readonly<{ headers: Readonly<Record<string, string>>; facts: RequestAuthFactsV1; expiresAt?: number }> {
    const invalid = (): never => {
        throw new ConnectedAccountRequestAuthError('request_auth_credential_unavailable', { causeCode: 'request_auth_materialization_invalid' });
    };
    if (!result || typeof result !== 'object' || Array.isArray(result)) return invalid();
    const record = result as Readonly<Record<string, unknown>>;
    if (Reflect.ownKeys(record).some(key => typeof key !== 'string'
        || !['kind', 'headers', 'facts', 'expiresAt', 'usageAccountScope'].includes(key))
        || record.kind !== 'httpHeaders'
        || (record.usageAccountScope !== undefined && record.usageAccountScope !== 'personal'
            && record.usageAccountScope !== 'workspace' && record.usageAccountScope !== 'unknown')
        || (record.expiresAt !== undefined && (!Number.isSafeInteger(record.expiresAt) || Number(record.expiresAt) < 0))) return invalid();
    const parsedHeaders = RequestAuthHeaderMapV1Schema.safeParse(record.headers);
    const parsedFacts = RequestAuthFactsV1Schema.safeParse(record.facts === undefined ? {} : record.facts);
    if (!parsedHeaders.success || !parsedFacts.success) return invalid();
    const requested = new Set(materialization.headerNames);
    const headers = Object.fromEntries(Object.entries(parsedHeaders.data).map(([name, value]) => [name.toLowerCase(), value]));
    if (Object.keys(headers).some(name => !requested.has(name))) return invalid();
    if (materialization.queryParameterNames?.some(name => typeof parsedFacts.data[name] !== 'string' || !parsedFacts.data[name])) return invalid();
    return Object.freeze({ headers: Object.freeze(headers), facts: Object.freeze(parsedFacts.data),
        ...(typeof record.expiresAt === 'number' ? { expiresAt: record.expiresAt } : {}) });
}

/** Only facts admitted as query selectors can leave the request-auth host for an outbound request. */
export function projectRequestAuthQueryParameters(
    materialization: QualifiedConnectedAccountRequestAuthUseV1['materialization'],
    facts: RequestAuthFactsV1,
): Readonly<Record<string, string>> | undefined {
    if (!materialization.queryParameterNames?.length) return undefined;
    // The materialization parser requires a nonempty string for each declared name.
    return Object.fromEntries(materialization.queryParameterNames.map(name => [name, facts[name] as string]));
}
