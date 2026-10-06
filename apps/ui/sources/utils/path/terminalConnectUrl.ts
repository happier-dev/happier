import { isAcceptedHappierUrlProtocol, resolveAppUrlScheme } from '@/utils/url/appScheme';
import {
    normalizeServerIdentityIdCapability,
    encodeTerminalConnectLinkV4Payload,
    parseTerminalConnectLinkV4Parameters,
    type HomeConnectionDescriptorV1,
} from '@happier-dev/protocol';
import { canonicalizeServerUrl } from '@/sync/domains/server/url/serverUrlCanonical';
import { resolveEffectiveServerUrlOverride } from '@/sync/domains/server/url/serverUrlOverridePolicy';

export type ParsedTerminalConnectUrl = Readonly<{
    wireVersion?: 4;
    publicKeyB64Url: string;
    serverUrl: string | null;
    serverIdentityId?: string;
    pairing?: Readonly<{
        secretB64Url: string;
        createdAtMs: number;
        expiresAtMs: number;
    }>;
    supportsTokenOnly?: true;
    homeConnectionDescriptor?: HomeConnectionDescriptorV1;
    compatibility?: Readonly<{
        provenance: 'cli-v0.2.11-preview.2-url-only-v3';
        admission: 'update_required';
    }>;
}>;

export type TerminalConnectRouteParams = Readonly<Record<string, string | string[] | undefined>>;

export type TerminalConnectPreAuthTargetDecision = Readonly<{
    pendingServerUrl: string;
    canNavigateToAuth: boolean;
}>;

export async function resolveTerminalConnectPreAuthTarget(params: Readonly<{
    requestedServerUrl: string | null | undefined;
    activeServerUrl: string | null | undefined;
    homeConnectionDescriptor?: HomeConnectionDescriptorV1;
    allowLegacyLoopbackOverride?: boolean;
}>): Promise<TerminalConnectPreAuthTargetDecision | null> {
    const activeServerUrl = canonicalizeServerUrl(String(params.activeServerUrl ?? ''));
    const descriptorServerUrl = params.homeConnectionDescriptor
        ? canonicalizeServerUrl(params.homeConnectionDescriptor.canonicalServerUrl)
        : '';
    if (params.homeConnectionDescriptor) {
        // Canonical Home identity is custody, not the carrier this device uses.
        const { resolveHomeEnrollmentTransport } = await import('@/auth/enrollment/homeEnrollmentTransport');
        const resolution = await resolveHomeEnrollmentTransport(params.homeConnectionDescriptor);
        if (resolution.ok) await resolution.transport.close();
        return descriptorServerUrl
            ? { pendingServerUrl: descriptorServerUrl, canNavigateToAuth: resolution.ok }
            : null;
    }
    const requestedServerUrl = descriptorServerUrl
        || canonicalizeServerUrl(String(params.requestedServerUrl ?? ''));
    const effectiveServerUrl = resolveEffectiveServerUrlOverride({
        requestedServerUrl,
        activeServerUrl,
        allowLoopbackOverride: params.allowLegacyLoopbackOverride === true,
    });
    const pendingServerUrl = effectiveServerUrl || activeServerUrl;
    return pendingServerUrl ? { pendingServerUrl, canNavigateToAuth: true } : null;
}

const SAFE_SERVER_PROTOCOLS = new Set(['http:', 'https:']);
export const TERMINAL_CONNECT_WEB_PATH = '/terminal/connect';

function parseTerminalConnectParameters(params: URLSearchParams): ParsedTerminalConnectUrl | null {
    if (params.has('v4')) {
        const envelope = parseTerminalConnectLinkV4Parameters(params);
        if (!envelope) return null;
        return {
            wireVersion: 4,
            publicKeyB64Url: envelope.publicKeyB64Url,
            serverUrl: null,
            serverIdentityId: envelope.homeConnectionDescriptor.homeServerIdentityId,
            pairing: {
                secretB64Url: envelope.pairing.secretB64Url,
                createdAtMs: envelope.pairing.createdAtMs,
                expiresAtMs: envelope.pairing.expiresAtMs,
            },
            ...(envelope.pairing.supportsTokenOnly ? { supportsTokenOnly: true } : {}),
            homeConnectionDescriptor: envelope.homeConnectionDescriptor,
        };
    }

    const key = (params.get('key') ?? '').trim();
    if (!key) return null;
    const serverUrl = normalizeServerUrl(params.get('server') ?? '');
    const releasedCompatibility = parseReleasedUrlOnlyV3Compatibility({ publicKeyB64Url: key, serverUrl }, params);
    if (releasedCompatibility) return releasedCompatibility;
    return withPairingContext({ publicKeyB64Url: key, serverUrl }, params);
}

function normalizeServerUrl(raw: string): string | null {
    const value = String(raw ?? '').trim();
    if (!value) return null;
    try {
        const parsed = new URL(value);
        if (!SAFE_SERVER_PROTOCOLS.has(parsed.protocol)) return null;
        return parsed.toString().replace(/\/+$/, '');
    } catch {
        return null;
    }
}

export function normalizeTerminalConnectPathname(pathname: string): string {
    let value = String(pathname ?? '').trim();
    if (!value.startsWith('/')) {
        value = `/${value}`;
    }
    return value.replace(/\/+$/, '') || '/';
}

export function isTerminalConnectWebPathname(pathname: string): boolean {
    return normalizeTerminalConnectPathname(pathname) === TERMINAL_CONNECT_WEB_PATH;
}

function parseTerminalConnectWebUrl(raw: string): ParsedTerminalConnectUrl | null {
    try {
        const parsed = new URL(raw);
        // Bundled macOS/Linux Tauri webviews carry app routes on this local origin.
        const isLocalTauriCarrier = parsed.protocol === 'tauri:' && parsed.host === 'localhost';
        if (!SAFE_SERVER_PROTOCOLS.has(parsed.protocol) && !isLocalTauriCarrier) return null;
        if (!isTerminalConnectWebPathname(parsed.pathname)) return null;

        const hashTail = String(parsed.hash ?? '').replace(/^#/, '');
        const source = hashTail || String(parsed.search ?? '').replace(/^\?/, '');
        if (!source) return null;

        return parseTerminalConnectParameters(new URLSearchParams(source));
    } catch {
        return null;
    }
}

function parsePairingContext(params: URLSearchParams): ParsedTerminalConnectUrl['pairing'] {
    const secretB64Url = (params.get('pairingSecret') ?? '').trim();
    const createdAtMs = Number(params.get('createdAt'));
    const expiresAtMs = Number(params.get('expiresAt'));
    if (
        !secretB64Url
        || !Number.isSafeInteger(createdAtMs)
        || !Number.isSafeInteger(expiresAtMs)
        || createdAtMs < 0
        || expiresAtMs <= createdAtMs
    ) {
        return undefined;
    }
    return { secretB64Url, createdAtMs, expiresAtMs };
}

/**
 * Read adapter pinned to cli-v0.2.11-preview.2's immutable URL-only V3 writer.
 * It grants neither stable identity nor descriptor authority; those remain for
 * the normal authenticated observation/adoption boundary.
 */
function parseReleasedUrlOnlyV3Compatibility(
    base: Pick<ParsedTerminalConnectUrl, 'publicKeyB64Url' | 'serverUrl'>,
    params: URLSearchParams,
): ParsedTerminalConnectUrl | null {
    const required = new Set(['key', 'pairingSecret', 'createdAt', 'expiresAt']);
    const allowed = new Set([...required, 'server']);
    const keys = [...params.keys()];
    if (keys.length !== required.size + (params.has('server') ? 1 : 0) || keys.some((key) => !allowed.has(key))) return null;
    if ([...required].some((key) => params.getAll(key).length !== 1)) return null;
    if (params.has('server') && params.getAll('server').length !== 1) return null;
    if (params.has('server') && !base.serverUrl) return null;
    const pairing = parsePairingContext(params);
    if (!pairing) return null;
    return {
        ...base,
        pairing,
        compatibility: {
            provenance: 'cli-v0.2.11-preview.2-url-only-v3',
            admission: 'update_required',
        },
    };
}

function withPairingContext(
    base: Omit<ParsedTerminalConnectUrl, 'pairing' | 'supportsTokenOnly' | 'serverIdentityId'>,
    params: URLSearchParams,
): ParsedTerminalConnectUrl | null {
    const pairing = parsePairingContext(params);
    const hasPairingInput = ['pairingSecret', 'createdAt', 'expiresAt', 'serverIdentityId', 'supportsTokenOnly']
        .some((key) => params.has(key));
    if (!pairing) return hasPairingInput ? null : base;
    const serverIdentityId = normalizeServerIdentityIdCapability(params.get('serverIdentityId'));
    if (!serverIdentityId) return null;
    return {
        ...base,
        serverIdentityId,
        pairing,
        ...(params.get('supportsTokenOnly') === '1' ? { supportsTokenOnly: true } : {}),
    };
}

function buildPairingQuerySuffix(
    pairing: ParsedTerminalConnectUrl['pairing'],
    supportsTokenOnly: boolean,
    serverIdentityId: string | null | undefined,
): string {
    if (!pairing) return '';
    const normalizedServerIdentityId = normalizeServerIdentityIdCapability(serverIdentityId);
    if (!normalizedServerIdentityId) {
        throw new Error('Authenticated terminal pairing requires a stable Home identity');
    }
    return `&pairingSecret=${encodeURIComponent(pairing.secretB64Url)}`
        + `&createdAt=${pairing.createdAtMs}`
        + `&expiresAt=${pairing.expiresAtMs}`
        + `&serverIdentityId=${encodeURIComponent(normalizedServerIdentityId)}`
        + (supportsTokenOnly ? '&supportsTokenOnly=1' : '');
}

function buildTerminalConnectV4Payload(params: Readonly<{
    publicKeyB64Url: string;
    pairing?: ParsedTerminalConnectUrl['pairing'];
    supportsTokenOnly?: boolean;
    homeConnectionDescriptor: HomeConnectionDescriptorV1;
}>): string {
    if (!params.pairing) throw new Error('Terminal connect V4 requires authenticated pairing context');
    return encodeTerminalConnectLinkV4Payload({
        v: 4,
        publicKeyB64Url: String(params.publicKeyB64Url ?? '').trim(),
        pairing: {
            v: 3,
            ...params.pairing,
            homeServerIdentityId: params.homeConnectionDescriptor.homeServerIdentityId,
            supportsTokenOnly: params.supportsTokenOnly === true,
        },
        homeConnectionDescriptor: params.homeConnectionDescriptor,
    });
}

export function buildTerminalConnectDeepLink(params: Readonly<{
    publicKeyB64Url: string;
    serverUrl: string | null | undefined;
    pairing?: ParsedTerminalConnectUrl['pairing'];
    supportsTokenOnly?: boolean;
    serverIdentityId?: string;
    homeConnectionDescriptor?: HomeConnectionDescriptorV1;
}>): string {
    const terminalPrefix = `${resolveAppUrlScheme()}://terminal?`;
    const publicKeyB64Url = String(params.publicKeyB64Url ?? '').trim();
    if (params.homeConnectionDescriptor) {
        const payload = buildTerminalConnectV4Payload({ ...params, homeConnectionDescriptor: params.homeConnectionDescriptor });
        return `${terminalPrefix}v4=${payload}`;
    }
    const safeServerUrl = normalizeServerUrl(params.serverUrl ?? '');
    const pairingSuffix = buildPairingQuerySuffix(params.pairing, params.supportsTokenOnly === true, params.serverIdentityId);
    if (!safeServerUrl && !pairingSuffix) {
        return `${terminalPrefix}${publicKeyB64Url}`;
    }
    const serverSuffix = safeServerUrl ? `&server=${encodeURIComponent(safeServerUrl)}` : '';
    return `${terminalPrefix}key=${encodeURIComponent(publicKeyB64Url)}${serverSuffix}${pairingSuffix}`;
}

export function buildTerminalConnectWebHref(params: Readonly<{
    publicKeyB64Url: string;
    serverUrl: string | null | undefined;
    pairing?: ParsedTerminalConnectUrl['pairing'];
    supportsTokenOnly?: boolean;
    serverIdentityId?: string;
    homeConnectionDescriptor?: HomeConnectionDescriptorV1;
}>): string {
    const publicKeyB64Url = String(params.publicKeyB64Url ?? '').trim();
    if (params.homeConnectionDescriptor) {
        const payload = buildTerminalConnectV4Payload({ ...params, homeConnectionDescriptor: params.homeConnectionDescriptor });
        return `${TERMINAL_CONNECT_WEB_PATH}#v4=${payload}`;
    }
    const safeServerUrl = normalizeServerUrl(params.serverUrl ?? '');

    const serverSuffix = safeServerUrl ? `&server=${encodeURIComponent(safeServerUrl)}` : '';
    const hash =
        `#key=${encodeURIComponent(publicKeyB64Url)}${serverSuffix}`
        + `${buildPairingQuerySuffix(params.pairing, params.supportsTokenOnly === true, params.serverIdentityId)}`;

    return `${TERMINAL_CONNECT_WEB_PATH}${hash}`;
}

/** Translates an incoming link to the web carrier without upgrading its pairing authority. */
export function resolveTerminalConnectWebHref(url: string): string | null {
    const terminal = parseTerminalConnectUrl(url);
    if (!terminal) return null;
    if (terminal.compatibility?.admission === 'update_required') {
        // cli-v0.2.11-preview.2's released V3 shape must reach the same read adapter on web.
        // The current writer correctly refuses to generate that identity-free pairing shape.
        const parsed = new URL(url);
        const parameters = parsed.hash.slice(1) || parsed.search.slice(1);
        return `${TERMINAL_CONNECT_WEB_PATH}#${parameters}`;
    }
    return buildTerminalConnectWebHref(terminal);
}

export function buildTerminalConnectAuthRedirectHref(params: Readonly<{
    serverUrl: string | null | undefined;
}>): string {
    const safeServerUrl = normalizeServerUrl(params.serverUrl ?? '');
    if (!safeServerUrl) return '/';
    return `/?server=${encodeURIComponent(safeServerUrl)}`;
}

export function parseTerminalConnectUrl(url: string): ParsedTerminalConnectUrl | null {
    const raw = String(url ?? '');
    let parsed: URL | null = null;
    try {
        parsed = new URL(raw);
    } catch {
        parsed = null;
    }

    if (!parsed || !isAcceptedHappierUrlProtocol(parsed.protocol) || parsed.hostname !== 'terminal') {
        return parseTerminalConnectWebUrl(raw);
    }

    const tail = raw.slice(`${parsed.protocol}//terminal?`.length);
    if (!tail) return null;

    // Legacy format: happier://terminal?<publicKeyB64Url>
    // Canonical format: happier://terminal?key=<publicKeyB64Url>&server=<encodedServerUrl>
    const looksLikeQuery = tail.includes('=') || tail.includes('&');
    if (!looksLikeQuery) {
        return { publicKeyB64Url: tail, serverUrl: null };
    }

    return parseTerminalConnectParameters(new URLSearchParams(tail));
}

const TERMINAL_CONNECT_ROUTE_PARAM_NAMES = new Set([
    'v4',
    'key',
    'server',
    'serverIdentityId',
    'pairingSecret',
    'createdAt',
    'expiresAt',
    'supportsTokenOnly',
]);

function readFirstRouteParam(value: string | string[] | undefined): string {
    return typeof value === 'string'
        ? value
        : Array.isArray(value)
            ? String(value[0] ?? '')
            : '';
}

/**
 * Adapts Expo Router's decoded search-parameter projection to the canonical
 * terminal deep-link parser. The route owns no pairing or capability rules.
 */
export function parseTerminalConnectRouteParams(
    searchParams: TerminalConnectRouteParams,
): ParsedTerminalConnectUrl | null {
    const params = new URLSearchParams();
    for (const name of TERMINAL_CONNECT_ROUTE_PARAM_NAMES) {
        const value = readFirstRouteParam(searchParams[name]);
        if (value) params.set(name, value);
    }

    if (!params.get('key')?.trim() && !params.get('v4')?.trim()) {
        const legacyKeys = Object.keys(searchParams)
            .filter((name) => !TERMINAL_CONNECT_ROUTE_PARAM_NAMES.has(name));
        if (legacyKeys.length !== 1) return null;
        const legacyKey = legacyKeys[0]?.trim();
        if (!legacyKey) return null;
        params.set('key', legacyKey);
    }

    return parseTerminalConnectUrl(`${resolveAppUrlScheme()}://terminal?${params.toString()}`);
}
