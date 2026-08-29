/**
 * The `posthog-api` Connected Account runtime.
 *
 * V1 ships exactly one mode: the administrator-configured Personal API key pilot. It is
 * deliberately not a claim that a pasted personal credential is a generally installable
 * integration — an administrator grants the documented read scopes and names the exact
 * deployment. Cloud OAuth authorization-code remains the canonical Connected Accounts
 * OAuth owner's path and is not reimplemented here, and arbitrary self-hosted OAuth is
 * unsupported until that deployment's metadata is characterized.
 *
 * The deployment is explicit non-secret Connected Account configuration carrying
 * `semantic: 'connectedAccountOrigin'`, so the host normalizes it, admits it at
 * HostAccess, and republishes it as this account's `connectedAccountOrigins`. That
 * published value is the source's only routing authority; nothing here guesses a region,
 * probes a neutral origin, or fans out across deployments.
 *
 * Confirmation is one minimal documented read that proves the capability V1 actually
 * needs: this credential can enumerate at least one organization on that exact
 * deployment. No credential, header, response body, organization name, or slug ever
 * leaves this module.
 */

import type {
    ConnectedAccountAuthenticationContext as PluginConnectedAccountAuthenticationContext,
    ConnectedAccountHealthResult as PluginConnectedAccountHealthResult,
    ConnectedAccountManualCompletion as PluginConnectedAccountManualCompletion,
    ConnectedAccountRuntime as PluginConnectedAccountRuntime,
} from '@happier-dev/plugin-sdk/connected-accounts';

import { organizationsListPath } from '../api/paths.js';
import {
    parsePosthogDirectoryPage,
    parsePosthogOrganizationRow,
} from '../api/types/directory.js';
import {
    POSTHOG_API_ORIGIN_FIELD_ID,
    POSTHOG_PERSONAL_API_KEY_FIELD_ID,
    POSTHOG_PERSONAL_API_KEY_MODE_ID,
} from '../posthogContracts.js';
import { normalizePosthogApiOrigin } from './origin.js';

const EMPTY_HTTP_HEADERS: Readonly<Record<string, string>> = Object.freeze({});

/** One bounded page is all a confirmation needs; it never walks the listing. */
const CONFIRMATION_QUERY = '?limit=1';

export const POSTHOG_ACCOUNT_DIAGNOSTIC_CODES = {
    originUndeclared: 'posthog_origin_undeclared',
    credentialRejected: 'posthog_personal_api_key_rejected',
    credentialUnavailable: 'posthog_credentials_unavailable',
    verificationUnavailable: 'posthog_verification_unavailable',
} as const;

type PosthogReadContext = Parameters<PluginConnectedAccountRuntime['status']>[0];

function diagnostic(code: string, message: string) {
    return { code, severity: 'error' as const, message };
}

/**
 * Reads the exact declared deployment from this account's own configuration.
 *
 * There is no fallback. An account without a declared origin has no route, and
 * defaulting one would send a read credential at a deployment the administrator never
 * named.
 */
function readConfiguredOrigin(
    configuration: Readonly<{ values: Readonly<Record<string, unknown>> }>,
): string | null {
    const configured = configuration.values[POSTHOG_API_ORIGIN_FIELD_ID];
    if (typeof configured !== 'string') {
        return null;
    }
    const normalized = normalizePosthogApiOrigin(configured);
    return normalized.ok ? (normalized.origin as string) : null;
}

function connectionDisplayName(origin: string): string {
    try {
        return new URL(origin).host;
    } catch {
        return origin;
    }
}

type PosthogConfirmation =
    | Readonly<{ status: 'confirmed'; origin: string }>
    | Readonly<{
        status: 'rejected';
        diagnostic: ReturnType<typeof diagnostic>;
    }>
    | Readonly<{
        status: 'unavailable';
        diagnostic: ReturnType<typeof diagnostic>;
    }>;

function hasEnumerableOrganization(body: Uint8Array): boolean {
    try {
        const decoded: unknown = JSON.parse(new TextDecoder().decode(body));
        const page = parsePosthogDirectoryPage(decoded, parsePosthogOrganizationRow);
        return page !== null && page.rows.length > 0;
    } catch {
        return false;
    }
}

async function confirmPosthogCredential(
    input: Readonly<{ personalApiKey: string; origin: string }>,
    context: Pick<PluginConnectedAccountAuthenticationContext, 'services' | 'signal'>,
    options?: Readonly<{ signal?: AbortSignal }>,
): Promise<PosthogConfirmation> {
    const signal = options?.signal ?? context.signal;
    let response: Awaited<ReturnType<typeof context.services.http.request>>;
    try {
        response = await context.services.http.request({
            url: `${input.origin}${organizationsListPath()}${CONFIRMATION_QUERY}`,
            method: 'GET',
            headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${input.personalApiKey}`,
            },
            // A redirect here would carry the credential to an origin the declared
            // HostAccess grant never admitted.
            redirect: 'error',
        }, { signal });
    } catch (error) {
        if (signal.aborted) throw error;
        return {
            status: 'unavailable',
            diagnostic: diagnostic(
                POSTHOG_ACCOUNT_DIAGNOSTIC_CODES.verificationUnavailable,
                'PostHog could not be reached to confirm this connection.',
            ),
        };
    }

    if (response.status === 401 || response.status === 403) {
        return {
            status: 'rejected',
            diagnostic: diagnostic(
                POSTHOG_ACCOUNT_DIAGNOSTIC_CODES.credentialRejected,
                'PostHog rejected this personal API key for the requested read scopes.',
            ),
        };
    }
    if (response.status !== 200 || !hasEnumerableOrganization(response.body)) {
        return {
            status: 'unavailable',
            diagnostic: diagnostic(
                POSTHOG_ACCOUNT_DIAGNOSTIC_CODES.verificationUnavailable,
                'PostHog did not confirm an organization this connection can read.',
            ),
        };
    }
    return { status: 'confirmed', origin: input.origin };
}

async function completeManualConnection(
    input: PluginConnectedAccountManualCompletion,
    context: PluginConnectedAccountAuthenticationContext,
    options?: Readonly<{ signal?: AbortSignal }>,
) {
    const personalApiKey = input.fields[POSTHOG_PERSONAL_API_KEY_FIELD_ID]?.trim() ?? '';
    if (personalApiKey === '') {
        return {
            status: 'rejected' as const,
            diagnostic: diagnostic(
                POSTHOG_ACCOUNT_DIAGNOSTIC_CODES.credentialRejected,
                'PostHog requires a personal API key with the documented read scopes.',
            ),
        };
    }
    const origin = readConfiguredOrigin(context.configuration);
    if (origin === null) {
        return {
            status: 'rejected' as const,
            diagnostic: diagnostic(
                POSTHOG_ACCOUNT_DIAGNOSTIC_CODES.originUndeclared,
                'This PostHog connection declares no deployment to reach.',
            ),
        };
    }

    const confirmation = await confirmPosthogCredential(
        { personalApiKey, origin },
        context,
        options,
    );
    if (confirmation.status !== 'confirmed') return confirmation;

    await context.attemptCredentials.set(
        POSTHOG_PERSONAL_API_KEY_FIELD_ID,
        personalApiKey,
        options,
    );
    return {
        status: 'connected' as const,
        displayName: connectionDisplayName(confirmation.origin),
        // The confirmation proves enumeration, not a scope grant. PostHog does not echo
        // the granted scopes here, and asserting them would be a capability claim this
        // module cannot verify; the first real read reports the true answer.
        scopes: [],
    };
}

async function readHealth(
    context: PosthogReadContext,
    options?: Readonly<{ signal?: AbortSignal }>,
): Promise<PluginConnectedAccountHealthResult> {
    const origin = readConfiguredOrigin(context.configuration);
    if (origin === null) {
        return {
            status: 'reconnectRequired',
            diagnostic: diagnostic(
                POSTHOG_ACCOUNT_DIAGNOSTIC_CODES.originUndeclared,
                'This PostHog connection declares no deployment to reach.',
            ),
        };
    }
    const personalApiKey
        = (await context.credentials.get(POSTHOG_PERSONAL_API_KEY_FIELD_ID, options))?.trim() ?? '';
    if (personalApiKey === '') {
        return {
            status: 'unavailable',
            diagnostic: diagnostic(
                POSTHOG_ACCOUNT_DIAGNOSTIC_CODES.credentialUnavailable,
                'PostHog credentials are unavailable; reconnect the account.',
            ),
        };
    }
    const confirmation = await confirmPosthogCredential(
        { personalApiKey, origin },
        context,
        options,
    );
    if (confirmation.status !== 'confirmed') {
        // A refused credential needs a reconnect; an unreachable deployment does not,
        // because the connection itself was never shown to be wrong.
        return confirmation.status === 'rejected'
            ? { status: 'reconnectRequired', diagnostic: confirmation.diagnostic }
            : { status: 'unavailable', diagnostic: confirmation.diagnostic };
    }
    return { status: 'connected', displayName: connectionDisplayName(confirmation.origin) };
}

const posthogConnectedAccountRuntimeDefinition: PluginConnectedAccountRuntime = {
    authentication: {
        modes: {
            [POSTHOG_PERSONAL_API_KEY_MODE_ID]: {
                kind: 'manual',
                complete: completeManualConnection,
            },
        },
    },
    async refresh(context, options) {
        // A pasted personal API key has no refresh exchange. Reporting current health is
        // the honest answer rather than a rotation this credential never has.
        return readHealth(context, options);
    },
    async revoke() {
        return { status: 'remoteUnsupported' };
    },
    async status(context, options) {
        return readHealth(context, options);
    },
    async materialize(request, context, options) {
        if (request.kind !== 'httpHeaders') {
            throw new Error('PostHog connected accounts support HTTP-header materialization only');
        }
        const origin = readConfiguredOrigin(context.configuration);
        if (origin === null || request.origin !== origin) {
            throw new Error('PostHog connected accounts cannot materialize credentials for this origin');
        }
        if (!request.headerNames.some((name) => name.toLowerCase() === 'authorization')) {
            return { kind: 'httpHeaders', headers: EMPTY_HTTP_HEADERS };
        }
        const personalApiKey
            = (await context.credentials.get(POSTHOG_PERSONAL_API_KEY_FIELD_ID, options))?.trim()
                ?? '';
        if (personalApiKey === '') {
            throw new Error('PostHog connected-account credentials are unavailable');
        }
        return { kind: 'httpHeaders', headers: { authorization: `Bearer ${personalApiKey}` } };
    },
};

export const posthogConnectedAccountRuntime = Object.freeze(
    posthogConnectedAccountRuntimeDefinition,
);
