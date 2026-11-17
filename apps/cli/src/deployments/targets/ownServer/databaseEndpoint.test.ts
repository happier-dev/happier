import { describe, expect, it } from 'vitest';
import { readOwnServerDatabaseEndpointForHost } from './databaseEndpoint';
import type { ProjectNativeDockerPort } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';

const signal = new AbortController().signal;
const port = { target: 5432, published: 32123, protocol: 'tcp', bindAddress: '127.0.0.1' };
// Docker is the external boundary; locality and endpoint selection stay real.
const docker = (endpoint: string): ProjectNativeDockerPort => ({ engineId: 'selected-engine', async run() {
    return { exitCode: 0, stdout: JSON.stringify(endpoint) };
} });
describe('selected native database endpoint', () => {
    it('uses the assigned port only when the retained Docker context is local', async () => {
        expect(await readOwnServerDatabaseEndpointForHost({ docker: docker('unix:///var/run/docker.sock'),
            ports: [port, { ...port, target: 3000 }], containerPort: 5432, signal })).toEqual({ host: '127.0.0.1', port: 32123 });
        await expect(readOwnServerDatabaseEndpointForHost({ docker: docker('ssh://remote-engine'),
            ports: [port], containerPort: 5432, signal })).rejects.toMatchObject({ code: 'database_transport_unavailable' });
    });
    it('refuses public, unbound, neighboring and ambiguous ports', async () => {
        for (const ports of [[{ ...port, bindAddress: '0.0.0.0' }], [{ ...port, published: null }],
            [{ ...port, target: 3000 }], [port, port]]) {
            await expect(readOwnServerDatabaseEndpointForHost({ docker: docker('npipe:////./pipe/docker_engine'),
                ports, containerPort: 5432, signal })).rejects.toMatchObject({ code: 'database_transport_unavailable' });
        }
    });
});
