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
    return Object.freeze({ headers: Object.freeze(headers), facts: Object.freeze(parsedFacts.data),
        ...(typeof record.expiresAt === 'number' ? { expiresAt: record.expiresAt } : {}) });
}
