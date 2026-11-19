import { get } from 'node:http';
import { join } from 'node:path';
import type { ProjectNativeDockerPort } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';

/** Docker process boundary. Consumers still use the real filesystem and Unix forward. */
export function createRelayDockerFixture(networkId: string, networkName = networkId) {
    const relays = new Map<string, { id: string; directory: string }>();
    let container = 0;
    const fixture = {
        endpoint: 'unix:///var/run/docker.sock',
        driver: 'bridge',
        subnet: '172.22.0.0/16',
        gateway: '172.22.0.1' as string | undefined,
        failInspect: false,
        pullFailure: undefined as Error | undefined,
        failRemoval: false,
        hasRelay: (host: string) => relays.has(host),
        directory(host: string) {
            const relay = relays.get(host);
            if (!relay) throw new Error('Relay did not acquire container custody');
            return relay.directory;
        },
        socketPath(host: string) { return join(fixture.directory(host), 'forward.sock'); },
    };
    const ok = (stdout = '') => ({ exitCode: 0, stdout });
    const failure = { exitCode: 1, stdout: '' };
    const removeContainer = async (id: string) => {
        if (fixture.failRemoval) return failure;
        const entry = [...relays].find(([, value]) => value.id === id);
        if (!entry) throw new Error('Attempted removal without relay custody');
        relays.delete(entry[0]);
        return ok();
    };
    const docker: ProjectNativeDockerPort = { engineId: 'local', engineKind: 'native', removeOwnedContainer: removeContainer,
        async run(args) {
            const [resource, operation, argument] = args;
            if (resource === 'context' && operation === 'inspect') return ok(JSON.stringify(fixture.endpoint));
            if (resource === 'network' && operation === 'inspect' && (argument === networkId || argument === networkName)) {
                return fixture.failInspect ? failure : ok(JSON.stringify([{ Id: networkId, Name: networkName,
                    Driver: fixture.driver, Scope: 'local', IPAM: { Config: [{ Subnet: fixture.subnet, Gateway: fixture.gateway }] } }]));
            }
            if (resource === 'image' && operation === 'inspect') return fixture.pullFailure ? failure : ok();
            if (resource === 'image' && operation === 'pull') {
                if (fixture.pullFailure) throw fixture.pullFailure;
                return ok();
            }
            if (resource === 'container' && operation === 'ls') {
                const entry = [...relays].find(([host]) => args.includes(`name=^/${host}$`));
                return entry ? ok(`${entry[1].id} ${entry[1].directory}`) : ok();
            }
            if (resource === 'container' && operation === 'rm') return removeContainer(args[3]!);
            if (resource === 'container' && operation === 'create') {
                const host = args[args.indexOf('--name') + 1]!;
                const directory = args[args.indexOf('--label') + 1]!.split('=').slice(1).join('=');
                if (!directory || relays.has(host)) return failure;
                const id = (++container).toString(16).padStart(64, '0');
                relays.set(host, { id, directory });
                return ok(id);
            }
            if (resource === 'container' && operation === 'start' && [...relays.values()].some(relay => relay.id === argument)) return ok();
            throw new Error('Unexpected Docker fixture operation');
        },
    };
    return Object.assign(fixture, { docker });
}

export function readRelayHttpBody(socketPath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        // Each probe observes a new relay connection, including after a receiver moves.
        get({ socketPath, path: '/', agent: false }, response => {
            response.setEncoding('utf8');
            let body = '';
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => resolve(body));
            response.on('error', reject);
        }).on('error', reject);
    });
}
