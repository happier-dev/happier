import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { parseLinuxProcNetTcpListeners } from '@/daemon/local/services/inventory/platform/linux';
import { readProcessCensus } from '@/processes/census/processCensus';

/** Unprivileged Linux cannot bind privileged ports even to test occupancy.
 * Read the kernel table for occupancy. Attribute only a confirmed conflict. */
export async function readNativeCaddyHostListeners(port?: number): Promise<readonly { address: string; port: number; name?: string }[]> {
    if (process.platform !== 'linux') return [];
    if (port !== undefined) {
        const { scanPlatformLocalServices } = await import('@/daemon/local/services/inventory/platform/scan');
        const { listeners } = await scanPlatformLocalServices({ includeProcessFacts: false });
        const selected = listeners.filter(listener => listener.port === port);
        const pids = selected.flatMap(listener => listener.pid === undefined ? [] : [listener.pid]);
        if (!pids.length) return selected;
        const census = await readProcessCensus({ freshness: 'fresh', pids, fields: ['executablePath'] });
        if (census.status !== 'ok') return selected;
        const names = new Map(census.rows.map(row => [row.pid, row.executablePath ? basename(row.executablePath) : row.name]));
        return selected.map(listener => ({ ...listener, name: listener.pid === undefined ? undefined : names.get(listener.pid) }));
    }
    // Preserve either address family's positive facts if the other is unavailable.
    const [tcp4, tcp6] = await Promise.all([readFile('/proc/net/tcp', 'utf8').catch(() => ''),
        readFile('/proc/net/tcp6', 'utf8').catch(() => '')]);
    return parseLinuxProcNetTcpListeners({ tcp4, tcp6, inodeToPid: new Map() });
}
