import { isAcceptedHappierUrlProtocol, resolveAppUrlScheme } from '@/utils/url/appScheme';

export type ParsedTerminalConnectUrl = Readonly<{
    publicKeyB64Url: string;
    serverUrl: string | null;
    pairing?: Readonly<{
        secretB64Url: string;
        createdAtMs: number;
        expiresAtMs: number;
    }>;
    supportsTokenOnly?: true;
}>;

const SAFE_SERVER_PROTOCOLS = new Set(['http:', 'https:']);
const TERMINAL_CONNECT_WEB_PATH = '/terminal/connect';

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
        if (!SAFE_SERVER_PROTOCOLS.has(parsed.protocol)) return null;
        if (!isTerminalConnectWebPathname(parsed.pathname)) return null;

        const hashTail = String(parsed.hash ?? '').replace(/^#/, '');
        const source = hashTail || String(parsed.search ?? '').replace(/^\?/, '');
        if (!source) return null;

        const params = new URLSearchParams(source);
        const key = (params.get('key') ?? '').trim();
        if (!key) return null;

        const serverUrl = normalizeServerUrl(params.get('server') ?? '');
        return withPairingContext({ publicKeyB64Url: key, serverUrl }, params);
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

function withPairingContext(
    base: Omit<ParsedTerminalConnectUrl, 'pairing' | 'supportsTokenOnly'>,
    params: URLSearchParams,
): ParsedTerminalConnectUrl {
    const pairing = parsePairingContext(params);
    if (!pairing) return base;
    return {
        ...base,
        pairing,
        ...(params.get('supportsTokenOnly') === '1' ? { supportsTokenOnly: true } : {}),
    };
}

function buildPairingQuerySuffix(
    pairing: ParsedTerminalConnectUrl['pairing'],
    supportsTokenOnly: boolean,
): string {
    if (!pairing) return '';
    return `&pairingSecret=${encodeURIComponent(pairing.secretB64Url)}`
        + `&createdAt=${pairing.createdAtMs}`
        + `&expiresAt=${pairing.expiresAtMs}`
        + (supportsTokenOnly ? '&supportsTokenOnly=1' : '');
}

export function buildTerminalConnectDeepLink(params: Readonly<{
    publicKeyB64Url: string;
    serverUrl: string | null | undefined;
    pairing?: ParsedTerminalConnectUrl['pairing'];
    supportsTokenOnly?: boolean;
}>): string {
    const terminalPrefix = `${resolveAppUrlScheme()}://terminal?`;
    const publicKeyB64Url = String(params.publicKeyB64Url ?? '').trim();
    const safeServerUrl = normalizeServerUrl(params.serverUrl ?? '');
    const pairingSuffix = buildPairingQuerySuffix(params.pairing, params.supportsTokenOnly === true);
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
}>): string {
    const publicKeyB64Url = String(params.publicKeyB64Url ?? '').trim();
    const safeServerUrl = normalizeServerUrl(params.serverUrl ?? '');

    const serverSuffix = safeServerUrl ? `&server=${encodeURIComponent(safeServerUrl)}` : '';
    const hash =
        `#key=${encodeURIComponent(publicKeyB64Url)}${serverSuffix}`
        + `${buildPairingQuerySuffix(params.pairing, params.supportsTokenOnly === true)}`;

    return `${TERMINAL_CONNECT_WEB_PATH}${hash}`;
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

    const params = new URLSearchParams(tail);
    const key = (params.get('key') ?? '').trim();
    if (!key) return null;

    const serverUrl = normalizeServerUrl(params.get('server') ?? '');
    return withPairingContext({ publicKeyB64Url: key, serverUrl }, params);
}
