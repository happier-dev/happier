import { readFile } from 'node:fs/promises';
import { parseLinuxProcNetTcpListeners } from '@/daemon/local/services/inventory/platform/linux';

/** Unprivileged Linux cannot bind privileged ports even to test occupancy.
 * Reuse the listener inventory's kernel decoder without scanning process owners. */
export async function readNativeCaddyHostListeners(): Promise<readonly { address: string; port: number }[]> {
    if (process.platform !== 'linux') return [];
    // Preserve either address family's positive facts if the other is unavailable.
    const [tcp4, tcp6] = await Promise.all([readFile('/proc/net/tcp', 'utf8').catch(() => ''),
        readFile('/proc/net/tcp6', 'utf8').catch(() => '')]);
    return parseLinuxProcNetTcpListeners({ tcp4, tcp6, inodeToPid: new Map() });
}
