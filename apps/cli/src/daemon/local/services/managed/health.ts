import { LocalServiceLoopbackHostV1Schema } from '@happier-dev/protocol';

function isLoopbackHost(host: string): boolean {
    return LocalServiceLoopbackHostV1Schema.safeParse(host).success;
}

function normalizeHealthPath(path: string): string {
    const trimmed = path.trim();
    if (!trimmed) {
        return '/';
    }
    return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

export function resolveManagedLocalServiceHealthTarget(input: Readonly<{
    host: string;
    port: number;
    path: string;
}>): Readonly<{ ok: true; url: string } | { ok: false; reason: 'non_loopback_health_host' | 'invalid_health_port' }> {
    if (!isLoopbackHost(input.host)) {
        return { ok: false, reason: 'non_loopback_health_host' };
    }
    if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) {
        return { ok: false, reason: 'invalid_health_port' };
    }
    const host = input.host.includes(':') && !input.host.startsWith('[') ? `[${input.host}]` : input.host;
    return { ok: true, url: `http://${host}:${input.port}${normalizeHealthPath(input.path)}` };
}
