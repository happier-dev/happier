import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeCaddyImage, observeNativeCaddyContainer, parseNativeDockerEngineInfo,
    type MachineSetupNativeCommand, type MachineSetupNativeCommandResult } from '@happier-dev/cli-common/machineSetup';

/** Simulate only Docker/process IO; native parsing and the Caddy Unix transport
 * are real. This is constructed boundary evidence, not a real-Docker capture. */
export async function observeDeploymentDomainNativeForTest() {
    // Unix admin socket paths have a native byte limit, including under hstack.
    const root = await mkdtemp(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'hdd-'));
    const adminRoot = process.platform === 'win32' ? '\\\\.\\pipe\\' + randomUUID() : root;
    const seed = { admin: { listen: 'unix//run/happier-caddy/admin.sock|0660' } };
    const admin = createServer((_request, response) => {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ ...seed, apps: { http: { servers: {
            observed_public: { listen: [':443'], tls_connection_policies: [{}] },
        } } } }));
    });
    const close = async () => {
        try { if (admin.listening) await new Promise<void>((resolve, reject) => admin.close(error => error ? reject(error) : resolve())); }
        finally { await rm(root, { recursive: true, force: true }); }
    };
    try {
        await writeFile(join(root, 'seed.json'), JSON.stringify(seed));
        await new Promise<void>((resolve, reject) => {
            admin.once('error', reject);
            admin.listen(join(adminRoot, 'admin.sock'), resolve);
        });
        const container = { Id: 'domain-caddy-container', Name: '/domain-caddy',
            Config: { Image: nativeCaddyImage, Cmd: ['caddy', 'run', '--resume', '--config', '/etc/caddy/happier.json'],
                Labels: { 'dev.happier.machine-setup.recipe': 'caddy@1' } }, State: { Running: true },
            HostConfig: { RestartPolicy: { Name: 'unless-stopped' }, Binds: null, Mounts: [
                { Type: 'bind', Source: adminRoot, Target: '/run/happier-caddy' },
                { Type: 'bind', Source: join(root, 'seed.json'), Target: '/etc/caddy/happier.json' },
            ] }, NetworkSettings: { Networks: { domain_generation: {} },
                Ports: { '443/tcp': [{ HostIp: '203.0.113.7', HostPort: '443' }] } } };
        const reads: string[][] = [];
        const run = async (command: MachineSetupNativeCommand): Promise<MachineSetupNativeCommandResult> => {
            reads.push([...command.args]);
            if (command.executable !== 'docker') throw new Error('Expected native Docker boundary');
            const args = command.args;
            const stdout = args[0] === 'info' ? JSON.stringify({ ID: 'observed-domain-engine', OperatingSystem: 'Ubuntu 24.04.3 LTS' })
                : args[0] === 'container' && args[1] === 'ls' ? JSON.stringify(container.Id)
                : args[0] === 'container' && args[1] === 'inspect' ? JSON.stringify([container])
                : undefined;
            if (stdout === undefined) throw new Error('Read-only Domain discovery attempted a native effect');
            return { code: 0, stdout, stderr: '' };
        };
        const info = await run({ executable: 'docker', args: ['info', '--format', '{{json .}}'] });
        const engine = parseNativeDockerEngineInfo(info.stdout);
        const caddy = await observeNativeCaddyContainer({}, { run });
        const server = caddy.status === 'ready' ? caddy.servers.find(server => server.tls) : undefined;
        if (!engine || !server) throw new Error('Native Domain discovery did not settle ready');
        return { dockerEngineId: engine.id, nativeServer: server.serverId, reads, close };
    } catch (error) { await close(); throw error; }
}
