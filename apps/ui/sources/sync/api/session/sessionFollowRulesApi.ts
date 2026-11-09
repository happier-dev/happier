import {
    SESSION_FOLLOW_RULES_ROUTE_V1,
    ListSessionFollowRulesResponseV1Schema,
} from '@happier-dev/protocol/sessions/follow/sessionFollowRuleV1';
import { openSessionFollowRuleContentV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleContentCodecV1';
import type { OpenedSessionFollowRuleV1 } from '@happier-dev/protocol/sessions/follow/actions';
import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { classifyAccountStorageReadFailure, resolveAccountStorageContext, resolveAccountStorageContextForDisclosure } from '@/sync/encryption/accountStorageContext';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { SESSION_FOLLOW_HTTP_PATHS_V1, SessionAutoFollowPreferencesResponseSchema } from '@happier-dev/protocol/sessions/follow/api';
import type { SessionAutoFollowPreferencesV1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

export type OpenedSessionFollowRule = OpenedSessionFollowRuleV1;
export type SessionFollowRulesSnapshot = Readonly<{ status: 'ready'; accountId?: string; rules: readonly OpenedSessionFollowRule[];
    defaultPreferences?: SessionAutoFollowPreferencesV1 }>
    | Readonly<{ status: 'unavailable'; reason: string }>;

/** One screen's acquired private census; provenance is checked before reuse. */
export type AcquiredSessionFollowRulesSnapshot = Readonly<{
    status: 'ready';
    serverId: string;
    accountId: string;
    mode: 'plain' | 'e2ee';
    credentialScopeKey: string;
    rules: readonly OpenedSessionFollowRule[];
    defaultPreferences?: SessionAutoFollowPreferencesV1;
}>;
export type SessionFollowRulesReadResult = AcquiredSessionFollowRulesSnapshot
    | Extract<SessionFollowRulesSnapshot, { status: 'unavailable' }>;
export type SessionFollowReadInputs = Readonly<{ rules: SessionFollowRulesReadResult }>;

/** Reuse admitted content only within its exact Home, Account, credential and mode. */
export function assertSessionFollowRulesScope(snapshot: SessionFollowRulesReadResult, current: Readonly<{
    serverId: string; accountId: string; mode: 'plain' | 'e2ee'; credentialScopeKey: string;
}>): asserts snapshot is AcquiredSessionFollowRulesSnapshot {
    if (snapshot.status !== 'ready') throw new Error(snapshot.reason);
    if (!areServerProfileIdentifiersEquivalent(snapshot.serverId, current.serverId)
        || snapshot.accountId !== current.accountId || snapshot.credentialScopeKey !== current.credentialScopeKey) {
        throw new Error('scope-retired');
    }
    if (snapshot.mode !== current.mode) throw new Error('account-mode-mismatch');
}

/** Complete private census: an unreadable neighbor cannot become an empty rule set. */
export async function readSessionFollowRuleCensus(params: Readonly<{
    mode: 'plain' | 'e2ee';
    material: AccountScopedCryptoMaterial | null;
    request(path: string, init?: RequestInit): Promise<Response>;
    assertCurrent(): void;
    signal?: AbortSignal;
}>): Promise<readonly OpenedSessionFollowRule[]> {
    params.assertCurrent();
    const response = await params.request(SESSION_FOLLOW_RULES_ROUTE_V1, { method: 'GET', signal: params.signal });
    params.assertCurrent();
    if (!response.ok) throw new Error(response.status === 401 ? 'unauthorized' : response.status === 403 ? 'forbidden'
        : response.status === 404 ? 'unsupported' : 'unreachable');
    const value = ListSessionFollowRulesResponseV1Schema.parse(await response.json());
    params.assertCurrent();
    return value.rules.map(({ content, ...rule }) => {
        const opened = openSessionFollowRuleContentV1({ ...rule, content, mode: params.mode, material: params.material });
        if (opened.status !== 'opened') throw new Error(opened.reason);
        return { ...rule, definition: opened.definition };
    });
}

type SessionFollowRuleReadOptions = Readonly<{
    expectedAccountId?: string; rules?: SessionFollowRulesReadResult;
}>;

/** The ordinary captured Action context owns both private-rule projections. */
async function acquireSessionFollowRules(serverId: string, signal: AbortSignal | undefined,
    options: SessionFollowRuleReadOptions | undefined, includeDefaultPreferences: boolean,
): Promise<SessionFollowRulesReadResult> {
    if (options?.rules?.status === 'unavailable') return options.rules;
    try {
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const context = await captureLazyActionAccountContext(serverId, signal);
        try {
            context.assertCurrent();
            if (options?.expectedAccountId !== undefined && context.accountId !== options.expectedAccountId) throw new Error('scope-retired');
            const { encryption } = await context.resolveAccountEncryption();
            const account = await resolveAccountStorageContext(context.credentials, { encryption, request: context.request, usage: 'identity' });
            context.assertCurrent();
            const provenance = { serverId: context.serverId, accountId: context.accountId, mode: account.mode,
                credentialScopeKey: resolveAuthCredentialsScopeKey(context.credentials) };
            if (options?.rules) assertSessionFollowRulesScope(options.rules, provenance);
            const readDefaults = async () => {
                if (!includeDefaultPreferences) return undefined;
                if (options?.rules?.status === 'ready' && options.rules.defaultPreferences) return options.rules.defaultPreferences;
                const response = await context.request(SESSION_FOLLOW_HTTP_PATHS_V1.preferences, { method: 'GET', signal });
                context.assertCurrent();
                if (!response.ok) throw new Error(response.status === 401 ? 'unauthorized'
                    : response.status === 403 ? 'forbidden' : response.status === 404 ? 'unsupported' : 'unreachable');
                return SessionAutoFollowPreferencesResponseSchema.parse(await response.json());
            };
            const [rules, defaultPreferences] = await Promise.all([options?.rules?.status === 'ready' ? options.rules.rules : readSessionFollowRuleCensus({
                mode: account.mode,
                material: account.mode === 'plain' ? null : resolveAccountScopedCryptoMaterialFromCredentials(context.credentials),
                request: context.request, assertCurrent: context.assertCurrent, signal,
            }), readDefaults()]);
            context.assertCurrent();
            const current = await resolveAccountStorageContextForDisclosure(context.credentials, { encryption, request: context.request });
            context.assertCurrent();
            if (current.mode !== account.mode) return { status: 'unavailable', reason: 'account-mode-mismatch' };
            if (options?.rules?.status === 'ready' && (!includeDefaultPreferences || options.rules.defaultPreferences)) return options.rules;
            return { status: 'ready', ...provenance, rules, ...(defaultPreferences ? { defaultPreferences } : {}) };
        } finally { context.dispose(); }
    } catch (error) {
        return { status: 'unavailable', reason: classifyAccountStorageReadFailure(error, signal) };
    }
}

/** Rule previews and Following need the private census, independent of Activity defaults. */
export function readSessionFollowRuleInputs(serverId: string, signal?: AbortSignal, options?: SessionFollowRuleReadOptions
): Promise<SessionFollowRulesReadResult> {
    return acquireSessionFollowRules(serverId, signal, options, false);
}

/** Activity also needs the operational preferences that normalize into personal default rules. */
export function readSessionFollowRules(serverId: string, signal?: AbortSignal, options?: SessionFollowRuleReadOptions
): Promise<SessionFollowRulesReadResult> {
    return acquireSessionFollowRules(serverId, signal, options, true);
}
