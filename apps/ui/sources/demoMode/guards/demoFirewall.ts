import { resetRuntimeFetch, setRuntimeFetch, type RuntimeFetch } from '@/utils/system/runtimeFetch';
import {
    resetServerProfilePersistenceSuspendForTests,
    resumeServerProfilePersistenceForDemo,
    suspendServerProfilePersistenceForDemo,
} from '@/sync/domains/server/serverProfiles';

type DemoFirewallChannel = 'runtimeFetch' | 'globalFetch';

export type DemoFirewallDenyLogEntry = Readonly<{
    channel: DemoFirewallChannel;
    url: string;
    method?: string;
    blockedAt: number;
}>;

let installDepth = 0;
let originalGlobalFetch: typeof globalThis.fetch | null = null;
let denyLog: DemoFirewallDenyLogEntry[] = [];

function stringifyInput(input: RequestInfo | URL): string {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.toString();
    return input.url;
}

function readMethod(input: RequestInfo | URL, init?: RequestInit): string | undefined {
    if (typeof init?.method === 'string') return init.method;
    if (typeof input === 'object' && 'method' in input && typeof input.method === 'string') {
        return input.method;
    }
    return undefined;
}

function readCurrentOrigin(): string | null {
    const location = (globalThis as { location?: { origin?: unknown; href?: unknown } }).location;
    if (typeof location?.origin === 'string' && location.origin.trim()) {
        return location.origin.trim();
    }
    if (typeof location?.href !== 'string' || !location.href.trim()) {
        return null;
    }
    try {
        return new URL(location.href).origin;
    } catch {
        return null;
    }
}

function hasPathSegmentPrefix(pathname: string, segment: string): boolean {
    return pathname === segment || pathname.startsWith(`${segment}/`);
}

function isApiOrSocketPath(pathname: string): boolean {
    const lowerPathname = pathname.toLowerCase();
    return hasPathSegmentPrefix(lowerPathname, '/v1')
        || hasPathSegmentPrefix(lowerPathname, '/api')
        || hasPathSegmentPrefix(lowerPathname, '/socket.io')
        || hasPathSegmentPrefix(lowerPathname, '/socket')
        || hasPathSegmentPrefix(lowerPathname, '/ws');
}

function hasStaticExtension(pathname: string): boolean {
    const lowerPathname = pathname.toLowerCase();
    return /\.(?:js|mjs|cjs|css|wasm|map|png|jpe?g|gif|webp|avif|svg|ico|ttf|otf|woff2?|mp4|webm|mp3|wav)$/.test(lowerPathname);
}

function isExpoMetroStaticPath(pathname: string): boolean {
    const lowerPathname = pathname.toLowerCase();
    if (lowerPathname.endsWith('.bundle')) return true;
    if (!hasStaticExtension(lowerPathname)) return false;
    return lowerPathname.startsWith('/_expo/')
        || lowerPathname.startsWith('/assets/')
        || lowerPathname.startsWith('/static/')
        || lowerPathname.includes('/node_modules/');
}

function shouldAllowSameOriginStaticFetch(input: RequestInfo | URL, init?: RequestInit): boolean {
    const method = (readMethod(input, init) ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return false;

    const currentOrigin = readCurrentOrigin();
    if (!currentOrigin) return false;

    let url: URL;
    try {
        url = new URL(stringifyInput(input), currentOrigin);
    } catch {
        return false;
    }

    if (url.origin !== currentOrigin) return false;
    if (isApiOrSocketPath(url.pathname)) return false;

    // Demo mode bans data egress, not the browser loading this app. Keep the
    // allow path constrained to same-origin Expo/Metro module and asset shapes:
    // bundle endpoints plus static/chunk/asset directories with script/font/media
    // extensions. Same-origin API or socket-looking paths are checked first so
    // a data endpoint cannot pass just by adding a static-looking suffix.
    return isExpoMetroStaticPath(url.pathname);
}

function blockDemoEgress(channel: DemoFirewallChannel, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = stringifyInput(input);
    denyLog = [
        ...denyLog,
        {
            channel,
            url,
            method: readMethod(input, init),
            blockedAt: Date.now(),
        },
    ];
    return Promise.reject(new Error(`Demo mode blocked network egress: ${url}`));
}

const denyRuntimeFetch: RuntimeFetch = (input, init) => blockDemoEgress('runtimeFetch', input, init);

function installGlobalFetchGuard(): void {
    originalGlobalFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        if (shouldAllowSameOriginStaticFetch(input, init) && originalGlobalFetch) {
            return originalGlobalFetch(input, init);
        }
        return blockDemoEgress('globalFetch', input, init);
    }) as typeof globalThis.fetch;
}

export function installDemoFirewall(): void {
    installDepth += 1;
    if (installDepth !== 1) return;
    denyLog = [];
    setRuntimeFetch(denyRuntimeFetch);
    installGlobalFetchGuard();
    // Demo mode bans data egress AND durable persistence of demo state: the seeded
    // demo relay server must never reach the real server-profiles store, or a hard
    // exit would strand the real profile on the dead demo server on next boot.
    suspendServerProfilePersistenceForDemo();
}

export function uninstallDemoFirewall(): void {
    if (installDepth === 0) return;
    installDepth -= 1;
    if (installDepth !== 0) return;

    resetRuntimeFetch();
    if (originalGlobalFetch) {
        globalThis.fetch = originalGlobalFetch;
    }
    originalGlobalFetch = null;
    resumeServerProfilePersistenceForDemo();
}

export function getDemoFirewallDenyLog(): readonly DemoFirewallDenyLogEntry[] {
    return denyLog;
}

export function resetDemoFirewallForTests(): void {
    installDepth = 1;
    uninstallDemoFirewall();
    denyLog = [];
    resetServerProfilePersistenceSuspendForTests();
}
