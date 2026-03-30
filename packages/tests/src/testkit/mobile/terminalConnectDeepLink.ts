import { resolveMobileAppScheme } from './mobileAppScheme';

const SAFE_SERVER_PROTOCOLS = new Set(['http:', 'https:']);
const TERMINAL_CONNECT_WEB_PATH = '/terminal/connect';

function normalizeWebPathname(pathname: string): string {
  return String(pathname ?? '').replace(/\/+$/, '');
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

type ParsedTerminalConnectWebUrl = Readonly<{
  key: string;
  serverUrl: string | null;
}>;

function parseTerminalConnectWebUrl(raw: string): ParsedTerminalConnectWebUrl | null {
  try {
    const parsed = new URL(raw);
    if (!SAFE_SERVER_PROTOCOLS.has(parsed.protocol)) return null;
    if (normalizeWebPathname(parsed.pathname) !== TERMINAL_CONNECT_WEB_PATH) return null;

    const hashTail = String(parsed.hash ?? '').replace(/^#/, '');
    const source = hashTail || String(parsed.search ?? '').replace(/^\?/, '');
    if (!source) return null;

    const params = new URLSearchParams(source);
    const key = String(params.get('key') ?? '').trim();
    if (!key) return null;

    return {
      key,
      serverUrl: normalizeServerUrl(String(params.get('server') ?? '')),
    };
  } catch {
    return null;
  }
}

export function resolveTerminalConnectDeepLink(
  raw: string,
  options?: Readonly<{
    env?: NodeJS.ProcessEnv;
    serverUrl?: string | null;
  }>,
): string {
  const parsed = parseTerminalConnectWebUrl(raw);
  if (!parsed) return '';

  const scheme = resolveMobileAppScheme(options?.env ?? process.env);
  const normalizedServerUrl = normalizeServerUrl(options?.serverUrl ?? '') ?? parsed.serverUrl;
  const prefix = `${scheme}://terminal?`;

  if (!normalizedServerUrl) {
    return `${prefix}key=${encodeURIComponent(parsed.key)}`;
  }

  return `${prefix}key=${encodeURIComponent(parsed.key)}&server=${encodeURIComponent(normalizedServerUrl)}`;
}
