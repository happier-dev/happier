import type { AuthEntryActionV1, AuthEntryProjectionV1} from '@happier-dev/protocol/auth/entry';
import type { FeaturesResponse } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import {
    projectAuthenticationMethodCatalog,
    projectAuthenticationMethodCatalogFromAuthEntry,
} from '@happier-dev/cli-common/authentication/authMethodCatalog';
import type { ProjectedAuthenticationCatalog } from '@happier-dev/cli-common/authentication/authMethodCatalog';
import type { ProjectedAuthenticationAction, ProjectedAuthenticationMethod } from '@happier-dev/cli-common/authentication/authMethodCatalog';

/**
 * The email/password destination is exhaustive by action: `login`, `provision`
 * and `connect` each have their own controller. Dropping an action here would
 * silently strand it in the generic external-execution tail (L02-R28).
 */
export type EmailPasswordEntryAction = 'login' | 'provision' | 'connect';

export type HomeAuthenticationExecution =
    | Readonly<{ kind: 'generated_key' }>
    | Readonly<{ kind: 'key_entry' }>
    | Readonly<{ kind: 'mtls' }>
    | Readonly<{
        kind: 'email_password';
        action: EmailPasswordEntryAction;
        mode: 'keyed' | 'keyless' | 'either';
        /**
         * The Home's recommended protection for a new Account, resolved by the
         * Home's effective-method owner and carried on its `provision` action.
         */
        recommendedProvisionMode?: 'plain' | 'e2ee';
        /**
         * Carried on `login` only when the Home can mail a reset link now. Absent
         * means "Forgot password" could never arrive, so it is not offered.
         */
        passwordReset?: 'email';
    }>
    | Readonly<{ kind: 'oauth'; providerId: string; mode: 'keyed' | 'keyless' }>;

function isEmailPasswordEntryAction(value: string): value is EmailPasswordEntryAction {
    return value === 'login' || value === 'provision' || value === 'connect';
}

/**
 * Account modes a Home admits for a new email/password Account. The entry
 * projection carries Home policy in the action mode: `keyed` means E2EE only,
 * `keyless` means Plain only, and `either` leaves the protection choice to the
 * person creating the Account.
 */
export function resolveEmailPasswordProvisionModes(
    mode: 'keyed' | 'keyless' | 'either',
): readonly ('plain' | 'e2ee')[] {
    if (mode === 'keyed') return ['e2ee'];
    if (mode === 'keyless') return ['plain'];
    return ['plain', 'e2ee'];
}

/**
 * The protection a new email/password Account starts with: the Home's
 * recommendation when it is one of the permitted modes, otherwise the first
 * permitted mode. The person may still choose the other permitted mode.
 */
export function resolveEmailPasswordProvisionDefault(
    mode: 'keyed' | 'keyless' | 'either',
    recommended?: 'plain' | 'e2ee' | null,
): 'plain' | 'e2ee' {
    const permitted = resolveEmailPasswordProvisionModes(mode);
    return recommended && permitted.includes(recommended) ? recommended : permitted[0]!;
}

export type HomeAuthenticationAction = Readonly<{
    method: ProjectedAuthenticationMethod;
    action: ProjectedAuthenticationAction;
    execution: HomeAuthenticationExecution;
}>;

type AuthEntryAuthenticationAction = Extract<AuthEntryActionV1, { kind: 'authenticate' }>;

function authenticationActionsFrom(
    actions: readonly AuthEntryActionV1[],
): readonly AuthEntryAuthenticationAction[] {
    return actions.filter((action): action is AuthEntryAuthenticationAction => action.kind === 'authenticate');
}

/**
 * The feature catalog and auth-entry route are distinct acquisition boundaries,
 * but an advertised method/action pair has one execution meaning after either
 * boundary has normalized it.
 */
function projectAuthenticationExecution(
    method: ProjectedAuthenticationMethod,
    action: ProjectedAuthenticationAction,
): HomeAuthenticationExecution | null {
    const methodId = normalizeAuthenticationProviderId(method.id);
    if (methodId === 'key_challenge') {
        if (action.mode !== 'keyed' && action.mode !== 'either') return null;
        if (action.id === 'provision') return { kind: 'generated_key' };
        if (action.id === 'login') return { kind: 'key_entry' };
        return null;
    }
    if (methodId === 'mtls') {
        return action.id === 'login' && (action.mode === 'keyless' || action.mode === 'either')
            ? { kind: 'mtls' }
            : null;
    }
    if (methodId === 'email_password') {
        return isEmailPasswordEntryAction(action.id)
            ? { kind: 'email_password', action: action.id, mode: action.mode }
            : null;
    }
    if (action.id !== 'login' && action.id !== 'provision' && action.id !== 'connect') return null;
    const mode = action.mode === 'either'
        ? action.id === 'login' ? 'keyless' : 'keyed'
        : action.mode;
    return { kind: 'oauth', providerId: methodId, mode };
}

export type AuthenticationMethodCapabilities = Readonly<{
    catalog: ProjectedAuthenticationCatalog;
    usesStructuredMethods: boolean;
    legacyEnabledSignupMethodIds: readonly string[];
    legacyEnabledLoginMethodIds: readonly string[];
    keyedProvisionProviderIds: readonly string[];
    configuredKeyedProvisionProviderIds: readonly string[];
    keylessLoginMethodIds: readonly string[];
    configuredKeylessProviderIds: readonly string[];
    authenticationActions: readonly HomeAuthenticationAction[];
}>;

export function normalizeAuthenticationProviderId(value: unknown): string {
    return String(value ?? '').trim().toLowerCase();
}

function uniqueProviderIds(values: readonly unknown[]): readonly string[] {
    return [...new Set(values.map(normalizeAuthenticationProviderId).filter(Boolean))];
}

export function projectAuthEntryMethodCapabilities(
    projection: Extract<AuthEntryProjectionV1, { state: 'ready' | 'admission_required' }>,
): AuthenticationMethodCapabilities {
    const catalog = projectAuthenticationMethodCatalogFromAuthEntry(projection);
    const methods = new Map(catalog.methods.map((method) => [method.id, method]));
    const authenticationActions = authenticationActionsFrom(projection.actions).flatMap((row): HomeAuthenticationAction[] => {
        const method = methods.get(normalizeAuthenticationProviderId(row.methodId));
        if (!method) return [];
        const action: ProjectedAuthenticationAction = { id: row.action, mode: row.mode };
        const execution = projectAuthenticationExecution(method, action);
        if (!execution) return [];
        // The auth-entry row is the only carrier of the Home's recommendation;
        // keep it with the native provision execution instead of dropping it.
        return [{
            method,
            action,
            execution: execution.kind === 'email_password'
                ? {
                    ...execution,
                    ...(row.recommendedProvisionMode ? { recommendedProvisionMode: row.recommendedProvisionMode } : {}),
                    ...(row.passwordReset ? { passwordReset: row.passwordReset } : {}),
                }
                : execution,
        }];
    });
    const keyedProvisionProviderIds = uniqueProviderIds(authenticationActions.flatMap(({ method, action }) => (
        method.id !== 'key_challenge' && method.id !== 'mtls' && method.id !== 'email_password'
        && action.id === 'provision' && (action.mode === 'keyed' || action.mode === 'either')
            ? [method.id]
            : []
    )));
    const keylessLoginMethodIds = uniqueProviderIds(authenticationActions.flatMap(({ method, action }) => (
        method.id !== 'key_challenge' && method.id !== 'email_password'
        && action.id === 'login' && (action.mode === 'keyless' || action.mode === 'either')
            ? [method.id]
            : []
    )));
    return {
        catalog,
        usesStructuredMethods: true,
        legacyEnabledSignupMethodIds: [],
        legacyEnabledLoginMethodIds: [],
        keyedProvisionProviderIds,
        configuredKeyedProvisionProviderIds: keyedProvisionProviderIds,
        keylessLoginMethodIds,
        configuredKeylessProviderIds: keylessLoginMethodIds.filter((id) => id !== 'mtls'),
        authenticationActions,
    };
}

/**
 * Pure projection of the server's authentication-method capability. Ordinary Home consumers
 * retain the released signup/login fallback while stricter explicit-endpoint consumers can use
 * the configured/enabled structured projections without reinterpreting the wire payload.
 */
export function projectAuthenticationMethodCapabilities(
    features: FeaturesResponse | null,
): AuthenticationMethodCapabilities {
    const catalog = projectAuthenticationMethodCatalog(features ?? {});
    const usesStructuredMethods = catalog.provenance !== 'legacy';
    const legacyEnabledSignupMethodIds = uniqueProviderIds(
        (features?.capabilities?.auth?.signup?.methods ?? [])
            .filter((method) => method.enabled === true)
            .map((method) => method.id),
    );
    const legacyEnabledLoginMethodIds = uniqueProviderIds(
        (features?.capabilities?.auth?.login?.methods ?? [])
            .filter((method) => method.enabled === true)
            .map((method) => method.id),
    );

    const keyedProvisionProviderIds = usesStructuredMethods
        ? uniqueProviderIds(catalog.methods
            .filter((method) => method.id !== 'key_challenge' && method.id !== 'mtls' && method.id !== 'email_password'
                && method.enabledActions.some((action) => action.id === 'provision' && (action.mode === 'keyed' || action.mode === 'either')))
            .map((method) => method.id))
        : legacyEnabledSignupMethodIds.filter((id) => id !== 'anonymous');

    const keylessLoginMethodIds = usesStructuredMethods
        ? uniqueProviderIds(catalog.methods
            .filter((method) => method.id !== 'key_challenge' && method.id !== 'email_password'
                && method.enabledActions.some((action) => action.id === 'login' && (action.mode === 'keyless' || action.mode === 'either')))
            .map((method) => method.id))
        : legacyEnabledLoginMethodIds.filter((id) => id !== 'key_challenge');

    const oauthProviders = features?.capabilities?.oauth?.providers ?? {};
    const configuredKeyedProvisionProviderIds = usesStructuredMethods
        ? keyedProvisionProviderIds
        : keyedProvisionProviderIds.filter((id) => oauthProviders[id]?.configured === true);
    const configuredKeylessProviderIds = usesStructuredMethods
        ? keylessLoginMethodIds.filter((id) => id !== 'mtls')
        : keylessLoginMethodIds.filter((id) => id !== 'mtls' && oauthProviders[id]?.configured === true);
    const authenticationActions = catalog.methods.flatMap((method): HomeAuthenticationAction[] => {
        const methodId = normalizeAuthenticationProviderId(method.id);
        const isNativeMethod = methodId === 'key_challenge' || methodId === 'mtls' || methodId === 'email_password';
        if (!usesStructuredMethods && !isNativeMethod && oauthProviders[methodId]?.configured !== true) return [];
        return method.enabledActions.flatMap((action): HomeAuthenticationAction[] => {
            const execution = projectAuthenticationExecution(method, action);
            return execution ? [{ method, action, execution }] : [];
        });
    });

    return {
        catalog,
        usesStructuredMethods,
        legacyEnabledSignupMethodIds,
        legacyEnabledLoginMethodIds,
        keyedProvisionProviderIds,
        configuredKeyedProvisionProviderIds,
        keylessLoginMethodIds,
        configuredKeylessProviderIds,
        authenticationActions,
    };
}
