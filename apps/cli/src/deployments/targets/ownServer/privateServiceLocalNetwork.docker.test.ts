import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import type { DeploymentSourceMaterializationV1 } from '@happier-dev/plugin-sdk';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { MachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { createNativeComposeLifecycle } from '@/daemon/local/services/launch/nativeComposeLifecycle';
import { attachNativeComposeReferenceNetworks } from '@/daemon/local/services/launch/nativeComposeReferenceNetwork';
import { projectNativeComposeReview } from '@/workspaces/projectSetup/nativeComposeReview';
import { createManagedServicesOwner } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { createManagedServiceProcessSupervisorHost, type ProjectNativeDockerPort } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import { createUnavailableManagedServices } from '@/plugins/runtime/invocation/services/managedServicesAdapter';
import { resolveOwnServerDeploymentEnvironmentInstanceIdForHost } from './paths';
import { resolvePrivateServiceExportAdmissionForHost } from './privateServiceReference';
import { resolvePrivateServiceLocalContainerAddress } from './privateServiceLocalNetwork';

// Docker's installed context/plugins belong to the OS user; Happier state and
// every native resource below remain test-owned. No image acquisition is needed.
const nativeEnvironment = { ...process.env, HOME: userInfo().homedir };
// The canonical test Home intentionally excludes Docker from its executable
// projection. An explicit opt-in lends only this installed OS executable.
const dockerExecutable = process.env.HAPPIER_TEST_PRIVATE_SERVICE_DOCKER_EXECUTABLE ?? '';

it.skipIf(!dockerExecutable)(
    'reaches a same-Machine cross-Environment export through source container DNS when its host publication is unreachable', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-local-service-network-'));
        const prefix = `happier-local-ref-${randomUUID().slice(0, 12)}`;
        const sourceProject = `${prefix}-source`;
        const consumerProject = `${prefix}-consumer`;
        const consumerFile = join(root, 'consumer.compose.json');
        const consumerNetwork = `${consumerProject}_default`;
        const containers: string[] = [];
        const networks: string[] = [];
        const marker = `source-${randomUUID()}`;
        const lifetime = new AbortController();
        const owner = createManagedServicesOwner({
            processSupervisorHost: createManagedServiceProcessSupervisorHost({ custodyOwner: 'daemon' }),
            dependencies: createUnavailableManagedServices().dependencies,
            resolveScope: scope => scope,
        });
        const run: ProjectNativeDockerPort['run'] = (args, signal, inputBytes) => new Promise((resolve, reject) => {
            const child = execFile(dockerExecutable, [...args], { env: nativeEnvironment, encoding: 'utf8',
                ...(signal ? { signal } : {}) }, (error, stdout, stderr) => {
                if (error && typeof error.code !== 'number') { reject(error); return; }
                resolve({ exitCode: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
            });
            child.stdin?.end(inputBytes);
        });
        const checked = async (args: readonly string[]) => {
            const result = await run(args);
            expect(result.exitCode, result.stderr).toBe(0);
            return result.stdout.trim();
        };
        const machineId = 'local-reference-machine';
        const installationId = 'local-reference-installation';
        const sourceEnvironment = createDeploymentEnvironmentDetailV1();
        sourceEnvironment.environment.id = `${prefix}-source`;
        sourceEnvironment.environment.runtimeTargetLinkId = 'local-source-link';
        const exported = { key: 'web', service: 'web', containerPort: 8080, scheme: 'http',
            exposure: 'loopback' as const, transport: { kind: 'iroh' as const } };
        sourceEnvironment.content.ownServer = { rollout: 'recreate', autoRestorePreviousRelease: false, serviceExports: [exported] };
        sourceEnvironment.targetLinks[0]!.targetLink = { ...sourceEnvironment.targetLinks[0]!.targetLink,
            id: 'local-source-link', environmentId: sourceEnvironment.environment.id, machines: [machineId],
            members: [{ machineId, installationId, state: 'active' }] };
        const consumerEnvironment = createDeploymentEnvironmentDetailV1();
        consumerEnvironment.environment.id = `${prefix}-consumer`;
        const home = createServer((request, response) => {
            response.setHeader('content-type', 'application/json');
            if (request.url === '/v1/account/encryption-mode') { response.end(JSON.stringify({ mode: 'plain' })); return; }
            if (request.url !== `/v1/machines/${machineId}`) { response.writeHead(404).end('{}'); return; }
            response.end(JSON.stringify({ machine: { id: machineId, kind: 'persistent', revokedAt: null,
                replacedByMachineId: null, seq: 1, active: true, activeAt: 1, createdAt: 1, updatedAt: 1,
                metadata: encodePlainMachineStoredContent(MachinePublishedMetadataV1Schema.parse({ host: 'fixture', platform: 'linux',
                    happyCliVersion: '0.0.0', homeDir: root, happyHomeDir: root })), metadataVersion: 1,
                daemonState: encodePlainMachineStoredContent({ status: 'running', reachability: { revision: 1,
                    management: { daemon: 'ready', providers: [], publicSsh: 'closed' }, ingress: [], privateNetworks: [] } }),
                daemonStateVersion: 1, storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, installationId } }));
        });
        let source: DeploymentSourceMaterializationV1 | undefined;
        let sourceCompose: readonly string[] | undefined;
        let sourceContainerId: string | undefined;
        let consumerCreated = false;
        try {
            home.listen(0, '127.0.0.1');
            await once(home, 'listening');
            const homeAddress = home.address();
            if (!homeAddress || typeof homeAddress === 'string') throw new Error('Missing fixture Home address');
            const serverId = `http://127.0.0.1:${homeAddress.port}`;
            const engineId = await checked(['info', '--format', '{{.ID}}']);
            const image = await checked(['image', 'inspect', 'busybox:1.37', '--format', '{{.Id}}']);
            const document = JSON.stringify({ services: { web: { image, ports: ['127.0.0.1::8080'],
                command: ['sh', '-c', `mkdir -p /www; printf '%s' '${marker}' > /www/index.html; exec httpd -f -p 8080 -h /www`] } } });
            const environmentInstanceId = resolveOwnServerDeploymentEnvironmentInstanceIdForHost(serverId, sourceEnvironment.environment.id);
            const sourceRoot = join(root, 'source');
            await mkdir(sourceRoot, { recursive: true });
            await writeFile(join(sourceRoot, 'compose.yaml'), document, { flag: 'w' });
            source = { environmentId: sourceEnvironment.environment.id, environmentInstanceId, deploymentId: `${prefix}-release`,
                machineId, installationId, rootPath: sourceRoot, manifestFingerprint: 'docker-fixture',
                async assertCurrent() {}, async commit() {}, async abort() {} };
            const compose = ['compose', '--project-name', sourceProject, '--project-directory', source.rootPath,
                '--file', join(source.rootPath, 'compose.yaml')];
            sourceCompose = compose;
            networks.push(`${sourceProject}_default`);
            await checked([...compose, 'up', '--detach', '--no-build', '--pull', 'never']);
            const sourceId = await checked([...compose, 'ps', '--quiet', 'web']);
            sourceContainerId = sourceId;
            const sourceNetworkId = await checked(['network', 'inspect', `${sourceProject}_default`, '--format', '{{.Id}}']);
            const published = Number((await checked([...compose, 'port', 'web', '8080'])).split(':').at(-1));
            expect(Number.isInteger(published)).toBe(true);
            const probe = async (networkId: string, url: string) => {
                const id = await checked(['create', '--pull=never', '--network', networkId, image, 'wget', '-q', '-T', '2', '-O', '-', url]);
                containers.push(id);
                return run(['start', '--attach', id]);
            };
            // Same-fixture control proves the source before any negative assertion.
            const control = await probe(sourceNetworkId, `http://${sourceProject}-web-1:8080`);
            expect(control.exitCode, control.stderr).toBe(0);
            expect(control.stdout).toBe(marker);
            await checked(['network', 'create', consumerNetwork]);
            networks.push(consumerNetwork);
            const gateway = await checked(['network', 'inspect', consumerNetwork, '--format', '{{(index .IPAM.Config 0).Gateway}}']);
            const hostPublication = await probe(consumerNetwork, `http://${gateway}:${published}`);
            expect(hostPublication.exitCode, 'Fixture requires the host publication to be unreachable from a consumer').not.toBe(0);
            console.info('[private-service-local-network]', JSON.stringify({ sourceControl: control.exitCode,
                hostPublication: hostPublication.exitCode, sourceNetworkId }));
            const normalized = JSON.parse(await checked([...compose, 'config', '--format', 'json']));
            const configuration = projectNativeComposeReview(normalized, source.rootPath, value => value).services[0]!;
            const capture = createNativeComposeLifecycle({ args: compose, engineId,
                environment: { composeService: 'web', containerIds: [sourceId], facts: { configuration, containerImages: [] } },
                io: { run: request => run(request.args, request.signal, request.stdin) } });
            capture.bindLaunch({ command: dockerExecutable, args: compose, cwd: source.rootPath, env: nativeEnvironment, release() {} });
            await source.commit();
            await owner.superviseProject({ kind: 'environment', serverId, machineId, environmentId: source.environmentId,
                environmentInstanceId, deploymentId: source.deploymentId, release: source, composeService: 'web',
                serviceId: `${environmentInstanceId}/web`, appliedServiceExports: [exported], specIdentity: sourceProject,
                isCurrent: () => !lifetime.signal.aborted, releaseObservation: async () => {},
                nativeEffects: { keys: [{ kind: 'composeProject', dockerEndpoint: engineId, projectName: sourceProject }] },
                processSpec: { mode: { kind: 'native', observationOnly: true, builtinLifecycle: capture.lifecycle } } });
            const admission = await resolvePrivateServiceExportAdmissionForHost({
                source: { kind: 'reference', environmentId: source.environmentId, export: 'web', via: 'auto' },
                environment: consumerEnvironment, readEnvironment: async () => sourceEnvironment,
                host: { machineId, serverId, serverHttpBaseUrl: serverId,
                    credentials: { token: `h.${Buffer.from(JSON.stringify({ sub: 'fixture-owner' })).toString('base64url')}.s`, encryption: null } },
                context: {}, actionId: 'deployments.deploy', signal: lifetime.signal, owner,
                homeServerIdentityId: serverId, installationId, privateKey: new Uint8Array(64) });
            expect(admission.kind).toBe('local');
            if (admission.kind !== 'local') throw new Error('Expected the same-Machine source admission');
            const address = await resolvePrivateServiceLocalContainerAddress({ admission, owner,
                homeServerIdentityId: serverId, docker: { engineId, run }, signal: lifetime.signal });
            const referenceAddress = { machineId, installationId, phase: 'runtime' as const, name: 'SERVICE_URL',
                source: { kind: 'reference' as const, environmentId: source.environmentId, export: 'web', via: 'auto' as const },
                address: 'http://127.0.0.1:0', route: { kind: 'local' as const } };
            const model = { services: { app: { image, environment: { SERVICE_URL: referenceAddress.address },
                command: ['sh', '-c', 'exec wget -q -T 2 -O - "$$SERVICE_URL"'] } },
                networks: { default: { name: consumerNetwork, external: true } } };
            attachNativeComposeReferenceNetworks({ model, unresolvedModel: model, services: ['app'],
                referenceAddresses: [referenceAddress], networks: [{ source: referenceAddress.source, networkId: address.networkId }] });
            model.services.app.environment.SERVICE_URL = `http://${address.host}:${address.port}`;
            await writeFile(consumerFile, JSON.stringify(model));
            consumerCreated = true;
            const consumed = await run(['compose', '--project-name', consumerProject, '--file', consumerFile,
                'up', '--abort-on-container-exit', '--exit-code-from', 'app', '--no-build', '--pull', 'never']);
            expect(consumed.exitCode, consumed.stderr).toBe(0);
            expect(consumed.stdout).toContain(marker);
        } finally {
            lifetime.abort();
            const cleanupFailures: unknown[] = [];
            const clean = async (effect: () => Promise<unknown>) => { try { await effect(); } catch (error) { cleanupFailures.push(error); } };
            await clean(() => owner.dispose());
            if (consumerCreated) await clean(() => checked(['compose', '--project-name', consumerProject, '--file', consumerFile, 'down']));
            for (const id of containers.reverse()) await clean(() => checked(['rm', '--force', id]));
            if (sourceCompose) await clean(() => checked([...sourceCompose, 'down']));
            for (const id of networks.reverse()) await clean(async () => {
                // Compose removes its own network; the external consumer network
                // belongs to this fixture and is removed here by exact identity.
                const present = await run(['network', 'inspect', id]);
                if (present.exitCode === 0) await checked(['network', 'rm', id]);
            });
            await clean(() => new Promise<void>(resolve => home.close(() => resolve())));
            await clean(async () => { await source?.abort(); });
            await clean(() => rm(root, { recursive: true, force: true }));
            for (const id of containers) await clean(async () => expect((await run(['inspect', id])).exitCode).not.toBe(0));
            if (sourceContainerId) await clean(async () => expect((await run(['inspect', sourceContainerId!])).exitCode).not.toBe(0));
            for (const id of networks) await clean(async () => expect((await run(['network', 'inspect', id])).exitCode).not.toBe(0));
            console.info('[private-service-local-network-cleanup]', JSON.stringify({ containers: containers.length + (sourceContainerId ? 1 : 0),
                networks: networks.length, failures: cleanupFailures.length }));
            expect(cleanupFailures).toEqual([]);
        }
    },
);
