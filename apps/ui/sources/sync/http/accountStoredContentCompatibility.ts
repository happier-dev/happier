import {
    ACCOUNT_STORED_CONTENT_COMPATIBILITY_HTTP_HEADER,
    AccountStoredContentCompatibilityDeclarationV1Schema,
    AccountStoredContentCompatibilityServerRequirementsV1Schema,
    CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
    buildAccountStoredContentCompatibilityHttpHeadersV1,
    type AccountStoredContentCompatibilityDeclarationV1,
    type AccountStoredContentCompatibilityServerRequirementsV1,
} from '@happier-dev/protocol';

const serverRequirementsByUrl = new Map<
    string,
    AccountStoredContentCompatibilityServerRequirementsV1
>();

const accountStoredContentCompatibilityRequestDeclaration = Symbol(
    'accountStoredContentCompatibilityRequestDeclaration',
);

type AccountStoredContentCompatibilityRequestInit = RequestInit & {
    [accountStoredContentCompatibilityRequestDeclaration]?:
        AccountStoredContentCompatibilityDeclarationV1;
};

export type AccountStoredContentCompatibilityUnavailableReason =
    | 'server-requirements-unavailable'
    | 'server-protocol-too-old'
    | 'client-protocol-too-old';

export type AccountStoredContentCompatibilityHeaderResolution =
    | Readonly<{
        status: 'available';
        declaration: AccountStoredContentCompatibilityDeclarationV1;
        headers: Headers;
    }>
    | Readonly<{
        status: 'unavailable';
        reason: AccountStoredContentCompatibilityUnavailableReason;
    }>;

export class AccountStoredContentCompatibilityUnavailableError extends Error {
    public readonly reason: AccountStoredContentCompatibilityUnavailableReason;

    constructor(reason: AccountStoredContentCompatibilityUnavailableReason) {
        super(`Account stored-content compatibility is unavailable: ${reason}`);
        this.name = 'AccountStoredContentCompatibilityUnavailableError';
        this.reason = reason;
    }
}

function normalizeServerUrl(raw: string): string | null {
    try {
        const parsed = new URL(raw);
        parsed.search = '';
        parsed.hash = '';
        return parsed.toString().replace(/\/+$/, '');
    } catch {
        return null;
    }
}

/** Removes a caller-provided compatibility header until this owner reissues one. */
export function stripAccountStoredContentCompatibilityHeader(
    input?: HeadersInit,
): Headers {
    const headers = new Headers(input);
    headers.delete(ACCOUNT_STORED_CONTENT_COMPATIBILITY_HTTP_HEADER);
    return headers;
}

export function recordAccountStoredContentServerRequirements(params: Readonly<{
    serverUrl: string;
    requirements: AccountStoredContentCompatibilityServerRequirementsV1 | undefined;
}>): void {
    const serverUrl = normalizeServerUrl(params.serverUrl);
    if (!serverUrl) return;
    const parsed = AccountStoredContentCompatibilityServerRequirementsV1Schema
        .safeParse(params.requirements);
    if (!parsed.success) {
        serverRequirementsByUrl.delete(serverUrl);
        return;
    }
    serverRequirementsByUrl.set(serverUrl, parsed.data);
}

/**
 * Resolves one declared stored-content protocol against the requirements most
 * recently observed for this server. The implicit default advertises optional
 * additive response support, while an explicit declaration remains an
 * operation requirement. A caller cannot select a protocol by supplying a raw
 * header: this is the single header owner.
 */
export function resolveAccountStoredContentCompatibilityHeaders(
    input?: HeadersInit,
    params?: Readonly<{
        serverUrl: string;
        declaration?: AccountStoredContentCompatibilityDeclarationV1;
    }>,
): AccountStoredContentCompatibilityHeaderResolution {
    const headers = new Headers(input);
    const serverUrl = params ? normalizeServerUrl(params.serverUrl) : null;
    const requirements = serverUrl
        ? serverRequirementsByUrl.get(serverUrl)
        : undefined;
    if (!requirements) {
        return { status: 'unavailable', reason: 'server-requirements-unavailable' };
    }

    const hasExplicitDeclaration = params?.declaration !== undefined;
    const declaration = AccountStoredContentCompatibilityDeclarationV1Schema.parse(
        params?.declaration
        ?? CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    );
    const requiredServerProtocolVersion = hasExplicitDeclaration
        ? declaration.protocolVersion
        : CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION;
    if (requirements.currentProtocolVersion < requiredServerProtocolVersion) {
        return { status: 'unavailable', reason: 'server-protocol-too-old' };
    }
    if (requirements.minimumProtocolVersion > declaration.protocolVersion) {
        return { status: 'unavailable', reason: 'client-protocol-too-old' };
    }
    const declarationHeaders =
        buildAccountStoredContentCompatibilityHttpHeadersV1(
            declaration,
        );
    for (const [name, value] of Object.entries(declarationHeaders)) {
        headers.set(name, value);
    }
    return { status: 'available', declaration, headers };
}

/**
 * Carries an explicitly admitted declaration through the UI request pipeline
 * without treating a caller-supplied HTTP header as authority. The metadata is
 * a module-private symbol and is revalidated at the canonical header owner.
 */
export function withAccountStoredContentCompatibilityRequestDeclaration(
    input: RequestInit,
    declaration: AccountStoredContentCompatibilityDeclarationV1,
): RequestInit {
    const request = { ...input } as AccountStoredContentCompatibilityRequestInit;
    request[accountStoredContentCompatibilityRequestDeclaration] =
        AccountStoredContentCompatibilityDeclarationV1Schema.parse(declaration);
    return request;
}

export function readAccountStoredContentCompatibilityRequestDeclaration(
    input: RequestInit | undefined,
): AccountStoredContentCompatibilityDeclarationV1 | null {
    const candidate = (input as AccountStoredContentCompatibilityRequestInit | undefined)
        ?.[accountStoredContentCompatibilityRequestDeclaration];
    const parsed = AccountStoredContentCompatibilityDeclarationV1Schema.safeParse(candidate);
    return parsed.success ? parsed.data : null;
}

export function withCurrentAccountStoredContentCompatibilityHeaders(
    input?: HeadersInit,
    params?: Readonly<{
        serverUrl: string;
        declaration?: AccountStoredContentCompatibilityDeclarationV1;
    }>,
): Headers {
    const resolution = resolveAccountStoredContentCompatibilityHeaders(input, params);
    return resolution.status === 'available'
        ? resolution.headers
        : stripAccountStoredContentCompatibilityHeader(input);
}
