import type { NativeSshTunnelProbeResult } from './types';

export const DEFAULT_NATIVE_SSH_TUNNEL_PROBE_TIMEOUT_MS = 5_000;

export async function probeNativeSshTunnel(url: string): Promise<NativeSshTunnelProbeResult> {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return { ok: false, reason: 'remote-service-unreachable' };
    }
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
        return { ok: false, reason: 'loopback-bind-failed' };
    }
    try {
        const healthUrl = new URL('/health', parsed);
        const controller = new AbortController();
        const timeout = setTimeout(() => {
            controller.abort();
        }, DEFAULT_NATIVE_SSH_TUNNEL_PROBE_TIMEOUT_MS);
        let response: Response;
        try {
            response = await fetch(healthUrl.toString(), {
                signal: controller.signal,
            });
        } finally {
            clearTimeout(timeout);
        }
        if (response.ok) {
            return { ok: true };
        }
        if (isCaptivePortalResponse(response, healthUrl)) {
            return { ok: false, reason: 'network-captive-portal' };
        }
        return { ok: false, reason: 'remote-service-unreachable' };
    } catch {
        return { ok: false, reason: 'remote-service-unreachable' };
    }
}

function isCaptivePortalResponse(response: Response, healthUrl: URL): boolean {
    if (response.status === 407 || response.status === 511) {
        return true;
    }
    if (!response.redirected) {
        return false;
    }
    try {
        const redirectedUrl = new URL(response.url);
        return redirectedUrl.origin !== healthUrl.origin;
    } catch {
        return true;
    }
}
