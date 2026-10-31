import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { expect } from 'vitest';

const execute = promisify(execFile);

/** Native Docker qualification of the network selection emitted by the real
 * backup owner. BusyBox substitutes only the image's network client; source,
 * image and P42 custody are exercised by the containing composed test.
 * Uses an isolated app network and ordinary bridge outbound, never an egress
 * network/policy. Opt in on a worker with Docker and its cached BusyBox image.
 */
export async function qualifyNativeBackupNetworking(createArgs: readonly string[]) {
    const docker = async (args: readonly string[]) => (await execute('docker', [...args])).stdout.trim();
    const image = await docker(['image', 'inspect', 'busybox:1.37', '--format', '{{.Id}}']);
    const appNetwork = `happier-cp30-app-${randomUUID()}`;
    const containers: string[] = [];
    let networkCreated = false;
    try {
        // The repository is outside the isolated application network. Run it
        // on the selected Docker engine too, so remote Engine sockets do not
        // confuse the worker process's host with the native host.
        const repository = await docker(['create', image, 'sh', '-c',
            'mkdir /www; printf destination-reached > /www/repository; exec httpd -f -p 8080 -h /www']);
        containers.push(repository);
        await docker(['start', repository]);
        const address = await docker(['inspect', '--format', '{{.NetworkSettings.Networks.bridge.IPAddress}}', repository]);
        const url = `http://${address}:8080/repository`;
        await docker(['network', 'create', '--internal', appNetwork]);
        networkCreated = true;
        const app = await docker(['create', '--network', appNetwork, '--network-alias', 'cp30-private-app', image,
            'httpd', '-f', '-p', '8080']);
        containers.push(app);
        await docker(['start', app]);
        const emittedNetwork = createArgs.flatMap((arg, index) =>
            arg === '--network' || arg === '--net' ? [arg, createArgs[index + 1]]
                : arg.startsWith('--network=') || arg.startsWith('--net=') ? [arg] : []);
        // These controls are the native RED: the superseded none setting and
        // the app network both lose the remote repository. Then run the exact
        // network choice emitted by the current owner as the deciding GREEN.
        for (const network of [['--network', 'none'], ['--network', appNetwork], emittedNetwork]) {
            const id = await docker(['create', ...network, image, 'sh', '-c',
                'wget -q -T 2 -O - "$1"', 'network-probe', url]);
            containers.push(id);
            const result = await execute('docker', ['start', '--attach', id]).then(
                value => ({ reachable: value.stdout === 'destination-reached', stdout: value.stdout, stderr: value.stderr }), error => ({ reachable: false, stdout: String(error.stdout), stderr: String(error.stderr) }));
            const expected = network === emittedNetwork;
            expect(result, expected ? `owner helper reaches remote destination ${url}` : 'native negative network control').toMatchObject({ reachable: expected });
            if (expected) {
                const networks = JSON.parse(await docker(['inspect', '--format', '{{json .NetworkSettings.Networks}}', id])) as Record<string, unknown>;
                expect(Object.keys(networks)).toEqual(['bridge']);
                expect(networks).not.toHaveProperty(appNetwork);
                const isolated = await docker(['create', ...network, image, 'sh', '-c',
                    'if wget -q -T 2 -O /dev/null http://cp30-private-app:8080; then exit 1; fi']);
                containers.push(isolated);
                await docker(['start', '--attach', isolated]);
                expect(await docker(['wait', isolated]), 'helper cannot reach the app network').toBe('0');
            }
        }
    } finally {
        for (const id of containers.reverse()) await docker(['rm', '--force', id]);
        if (networkCreated) await docker(['network', 'rm', appNetwork]);
    }
}
