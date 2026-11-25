import { isIPv4 } from 'node:net';
import { execFileWithDeadline } from '@happier-dev/cli-common/process';

import { resolveProxyForUrl } from '@/utils/proxy/resolveProxyForUrl';

/** Decide from the configured direct endpoint and the Linux kernel's route. */
export async function observeOffTailnetHomeRoute(serverUrl: string, signal: AbortSignal): Promise<boolean> {
    if (process.platform !== 'linux') return false;
    try {
        const { hostname } = new URL(serverUrl);
        if (!isIPv4(hostname) || !hostname.startsWith('100.')) return false;
        const secondOctet = Number(hostname.split('.')[1]);
        if (secondOctet < 64 || secondOctet > 127
            || resolveProxyForUrl({ targetUrl: serverUrl, env: process.env }).mode === 'proxy') return false;
        const { stdout } = await execFileWithDeadline('ip', ['-j', '-4', 'route', 'get', hostname], { encoding: 'utf8', signal });
        const routes: unknown = JSON.parse(stdout.toString());
        const route: unknown = Array.isArray(routes) && routes.length === 1 ? routes[0] : undefined;
        return !!route && typeof route === 'object' && 'dev' in route
            && typeof route.dev === 'string' && route.dev !== '' && route.dev !== 'tailscale0';
    } catch {
        return false;
    }
}
