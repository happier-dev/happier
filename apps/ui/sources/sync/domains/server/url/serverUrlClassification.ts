function stripBrackets(hostname: string): string {
    const host = String(hostname ?? '').trim();
    if (host.startsWith('[') && host.endsWith(']')) return host.slice(1, -1);
    return host;
}

function isPrivateIpv4(hostname: string): boolean {
    const host = String(hostname ?? '').trim();
    const parts = host.split('.');
    if (parts.length !== 4) return false;
    const nums = parts.map((p) => Number(p));
    if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    const [a, b] = nums;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true; // link-local
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (used by some VPNs like Tailscale)
    return false;
}

function isLocalishIpv6(hostname: string): boolean {
    const raw = stripBrackets(hostname).toLowerCase();
    if (!raw) return false;
    if (raw === '::1') return true;
    // ULA: fc00::/7 (typically fd00::/8)
    if (raw.startsWith('fc') || raw.startsWith('fd')) return true;
    // Link-local: fe80::/10
    if (raw.startsWith('fe8') || raw.startsWith('fe9') || raw.startsWith('fea') || raw.startsWith('feb')) return true;
    return false;
}

export function isLocalishHostname(hostname: string): boolean {
    const host = stripBrackets(String(hostname ?? '').trim().toLowerCase());
    if (!host) return false;

    if (host === 'localhost' || host === '0.0.0.0' || host === '::1') return true;
    if (host.endsWith('.localhost') || host.endsWith('.local')) return true;
    if (!host.includes('.')) return true; // likely a LAN hostname

    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return isPrivateIpv4(host);
    if (host.includes(':')) return isLocalishIpv6(host);

    return false;
}

export function isLoopbackHostname(hostname: string): boolean {
    const host = stripBrackets(String(hostname ?? '').trim().toLowerCase());
    if (!host) return false;
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1') return true;
    if (host.endsWith('.localhost')) return true;
    return false;
}

export function isLocalishServerUrl(serverUrl: string): boolean {
    try {
        const url = new URL(serverUrl);
        return isLocalishHostname(url.hostname);
    } catch {
        return false;
    }
}

export function isLoopbackServerUrl(serverUrl: string): boolean {
    try {
        const url = new URL(serverUrl);
        return isLoopbackHostname(url.hostname);
    } catch {
        return false;
    }
}

export function isInsecureRemoteHttpServerUrl(serverUrl: string): boolean {
    try {
        const url = new URL(serverUrl);
        if (url.protocol !== 'http:') return false;
        return !isLocalishHostname(url.hostname);
    } catch {
        return false;
    }
}

export function canSafelyAutoAdoptCanonicalServerUrl(params: Readonly<{
    currentUrl: string;
    advertisedUrl: string;
}>): boolean {
    let current: URL;
    let advertised: URL;
    try {
        current = new URL(params.currentUrl);
        advertised = new URL(params.advertisedUrl);
    } catch {
        return false;
    }

    if (advertised.protocol !== 'http:' && advertised.protocol !== 'https:') return false;
    if (current.protocol === 'https:' && advertised.protocol === 'http:') return false;

    const currentPath = current.pathname.replace(/\/+$/, '');
    const advertisedPath = advertised.pathname.replace(/\/+$/, '');

    // Safe upgrade: same host/path, http -> https.
    if (current.protocol === 'http:' && advertised.protocol === 'https:' && current.host === advertised.host && currentPath === advertisedPath) {
        return true;
    }

    const currentLocalish = isLocalishHostname(current.hostname);
    const advertisedLocalish = isLocalishHostname(advertised.hostname);

    // Safe upgrade: local-only URL -> non-local canonical URL (shareable).
    if (currentLocalish && !advertisedLocalish) return true;

    return false;
}
