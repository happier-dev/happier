import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OwnServerDeploymentInputBasisV1Schema, type DeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol';
import { createDeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import type { DeploymentChildExecutionProofV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { create as createTar } from 'tar';
import { describe, expect, it } from 'vitest';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import { createDeploymentExecEnvPortForHost } from '@/deployments/secrets/deploymentExecEnvPort';
import { prepareEnvironmentSecretBindingsForLaunch } from '@/deployments/secrets/prepareEnvironmentSecretBindingsForLaunch';
import { createDeploymentSourceMaterializationPort } from '@/deployments/targets/ownServer/exactCommitRelease';
import { captureOwnServerDeploymentSource, createOwnServerSourceCustodyReader } from '@/deployments/targets/ownServer/sourceProvenance';
import { createOwnServerDockerBoundary } from '@/deployments/targets/ownServer/ownServerDeployment.testkit';
import type { ProjectNativeToolchainIo } from '@/workspaces/toolchain/prepareProjectNativeToolchain';
import { createScmBackendRegistry } from '@/scm/registry';
import { createRegisteredScmBackendAdapter } from '@/scm/pluginBackends/registeredScmBackendAdapter';
import { createGitBackend, createGitScmBackendRuntimeRegistration } from '../../../../../../../packages/plugins/scm-git/src/backend';
import { createNativeComposeLifecycle } from './nativeComposeLifecycle';
import { machineNativeEffectAdmission } from './machineNativeEffectAdmission';

type StorageOptions = Readonly<{
    sourceKind?: 'repository' | 'stored';
    volumes?: readonly unknown[];
    imageVolumes?: readonly string[];
    topVolumes?: Readonly<Record<string, unknown>>;
    replicas?: number;
    machines?: number;
    readOnly?: boolean;
    shared?: boolean;
    activate?: boolean;
    absentIncumbent?: boolean;
    incumbentBind?: Readonly<{ source: string; target: string; foreign?: boolean; service?: string; status?: string }>;
    incumbentBinds?: readonly Readonly<{ source: string; target: string; service: string }>[];
    beforeActivate?: () => Promise<void>;
    onIncumbentServicesChanged?(services: readonly string[]): Promise<void>;
    exactIncumbent?: 'valid' | 'wrong-root' | 'wrong-source' | 'wrong-restoration' | 'foreign-environment' | 'changed-mount';
}>;

async function withStorageFixture(run: (fixture: Readonly<{
    render(options: StorageOptions): Promise<unknown>;
    sourcePath: string;
    advanceSource(): Promise<void>;
    nativeMutations: string[];
    renderedBindSources: string[];
    incumbentReceiptReads: string[];
}>) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), 'happier-native-storage-'));
    try {
        const configDocker = await createOwnServerDockerBoundary(join(root, 'config-docker'));
        const nativeConfiguration = (request: Parameters<ProjectNativeToolchainIo['run']>[0], args: readonly string[]) => execFileSync(
            process.execPath, [configDocker.executablePath, ...args], { cwd: request.cwd, env: request.env, encoding: 'utf8',
                ...(request.stdin ? { input: Buffer.from(request.stdin) } : {}) });
        const repository = join(root, 'repository');
        await mkdir(join(repository, 'config'), { recursive: true });
        await writeFile(join(repository, 'config', 'settings.json'), '{"port":3000}');
        const seedDatabase = new DatabaseSync(join(repository, 'config', 'state.sqlite'));
        try { seedDatabase.exec("CREATE TABLE rows (value TEXT NOT NULL); INSERT INTO rows VALUES ('source sample')"); }
        finally { seedDatabase.close(); }
        await writeFile(join(repository, 'compose.yaml'), 'services:\n  app:\n    image: app:latest\n');
        const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
        git('init', '--quiet'); git('config', 'user.name', 'Deployment Storage Fixture');
        git('config', 'user.email', 'storage@example.test'); git('add', '.'); git('commit', '--quiet', '-m', 'source');
        const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({ definition: { id: 'git' }, qualifiedId: 'scm-git/git',
            executableDefinition: { repoModes: ['.git'], capabilities: createGitBackend().declaredCapabilities!, commands: [{ installableKey: 'git-cli', command: 'git' }] },
            registration: createGitScmBackendRuntimeRegistration() })]);
        let selectedDeploymentId = 'deployment';
        const admission = () => {
            return { environmentId: 'environment', environmentInstanceId: 'instance', deploymentId: 'deployment', machineId: 'machine-a',
                installationId: 'installation-a', sourcePath: repository, commitSha: git('rev-parse', 'HEAD'),
                deploymentRoot: join(root, 'deployments'), artifactDirectory: join(root, 'artifacts'), async assertCurrent() {} };
        };
        const sourcePort = createDeploymentSourceMaterializationPort({ registry,
            async admit() { return { ...admission(), deploymentId: selectedDeploymentId }; } });
        let source = await sourcePort.materialize({ environmentId: 'environment', deploymentId: selectedDeploymentId });
        await source.commit();
        const history: DeploymentReceiptDetailV1[] = [];
        const signal = new AbortController().signal;
        const nativeMutations: string[] = [];
        const renderedBindSources: string[] = [];
        const incumbentReceiptReads: string[] = [];
        const exec = createStablePluginExecService({ signal,
            isOccurrenceCurrent: () => true, resolveExecutable: async () => ({ command: '/docker' }), resolvePath: async path => String(path),
            systemTools: { async resolve(request) { return { grantId: 'docker-fixture', toolId: request.toolId, displayName: 'Docker fixture', source: 'system', executablePath: '/docker', launch: { kind: 'binary', executablePath: '/docker' } }; } } });
        const createEnvPort = () => createDeploymentExecEnvPortForHost({ source, phase: 'runtime', signal, isCurrent: () => true,
            prepare: ({ phase }: Readonly<{ phase: 'build' | 'runtime'; signal: AbortSignal }>) => prepareEnvironmentSecretBindingsForLaunch({ phase, environmentId: source.environmentId,
                machineId: source.machineId, installationId: source.installationId, installationPrivateSeed: new Uint8Array(32),
                bindings: [], grants: [], assertCurrent: () => source.assertCurrent() }) });
        try {
            await run({ get sourcePath() { return source.rootPath; }, nativeMutations, renderedBindSources, incumbentReceiptReads,
                async advanceSource() {
                    const custody = await captureOwnServerDeploymentSource({ source, admission: { ...admission(), deploymentId: selectedDeploymentId } });
                    const template = createDeploymentReceiptDetailV1();
                    const approvedInputBasis = OwnServerDeploymentInputBasisV1Schema.parse({ v: 1, environmentId: source.environmentId,
                        environmentRevision: 1, targetLinkId: template.deployment.targetLinkId, targetLinkRevision: 1,
                        sourceIntent: { ...template.content.sourceIntent, sha: git('rev-parse', 'HEAD') },
                        manifestFingerprint: source.manifestFingerprint, configInputDigests: [], physicalProjectName: 'happier-native-storage',
                        toolVersion: '2.39.4', services: ['app'], profiles: [], members: [{ machineId: source.machineId,
                            installationId: source.installationId }], bindings: [], images: template.content.images });
                    history.unshift(createDeploymentReceiptDetailV1({ deployment: { ...template.deployment,
                        id: source.deploymentId, environmentId: source.environmentId },
                        content: { ...template.content, ownServer: { approvedInputBasis, sources: [custody] } } }));
                    selectedDeploymentId = `${selectedDeploymentId}-next`;
                    source = await sourcePort.materialize({ environmentId: 'environment', deploymentId: selectedDeploymentId });
                    await source.commit();
                }, async render(options) {
                const envPort = createEnvPort();
                const config = Buffer.from(JSON.stringify({ os: 'linux', architecture: 'amd64', config: {
                    Volumes: Object.fromEntries((options.imageVolumes ?? []).map(path => [path, {}])) } }));
                const configDigest = `sha256:${createHash('sha256').update(config).digest('hex')}`;
                const manifestDigest = `sha256:${'b'.repeat(64)}`;
                await writeFile(join(root, `${configDigest.slice(7)}.json`), config);
                await writeFile(join(root, 'manifest.json'), JSON.stringify([{ Config: `${configDigest.slice(7)}.json`, Layers: [] }]));
                const archive = join(root, 'image.tar');
                await createTar({ cwd: root, file: archive }, [`${configDigest.slice(7)}.json`, 'manifest.json']);
                const model = { services: { app: { image: 'app:latest', volumes: options.volumes ?? [], read_only: options.readOnly ?? false,
                    deploy: { replicas: options.replicas ?? 1 }, configs: [{ source: 'settings', target: '/settings' }],
                    secrets: [{ source: 'password', target: 'password' }], tmpfs: ['/tmp'] } },
                    configs: { settings: { content: 'safe' } }, secrets: { password: { external: true } }, volumes: options.topVolumes ?? {} };
                let activeProjectName: string | undefined;
                let activated = false;
                let nativeMountChanged = false;
                const projectInput = { kind: 'environmentProject' as const, exec, envPort, source, files: ['compose.yaml'], services: ['app'],
                    images: [{ service: 'app', platform: 'linux/amd64', configDigest, manifestDigest }],
                    sourceKind: options.sourceKind ?? 'repository' as const,
                    storage: { runtimeMachineCount: options.machines ?? 2,
                        ...(options.shared ? { sharedData: { environmentRoot: join(root, 'deployments', 'instance'),
                            readSourceCustody: createOwnServerSourceCustodyReader({ deploymentRoot: join(root, 'deployments'),
                                environmentId: source.environmentId,
                                environmentInstanceId: 'instance', machineId: source.machineId, installationId: source.installationId,
                                async assertCurrent() { await source.assertCurrent(); },
                                history: (async function* () { if (!options.exactIncumbent) yield* history; })(),
                                ...(options.exactIncumbent ? { async readIncumbentReceipt(fact: NonNullable<DeploymentChildExecutionProofV1['nativeIncumbentSource']>) {
                                    const deploymentId = fact.restorationForDeploymentId ?? fact.sourceDeploymentId;
                                    incumbentReceiptReads.push(deploymentId);
                                    const receipt = history.find(value => value.deployment.id === deploymentId);
                                    if (!receipt) throw new Error('Only the exact native incumbent receipt is admitted');
                                    const opened = structuredClone(receipt);
                                    const source = opened.content.ownServer!.sources![0];
                                    if (options.exactIncumbent === 'wrong-root') source.rootFingerprint = '0'.repeat(64);
                                    if (options.exactIncumbent === 'wrong-source') source.deploymentId = 'unrelated-source';
                                    if (options.exactIncumbent === 'wrong-restoration') source.restorationForDeploymentId = 'unrelated-restoration';
                                    if (options.exactIncumbent === 'foreign-environment') opened.deployment.environmentId = 'another-environment';
                                    if (options.exactIncumbent === 'changed-mount') nativeMountChanged = true;
                                    return opened;
                                } } : {}) }) } } : {}) },
                    // Only Docker process output and save's archive are replaced. The
                    // native codec, source materializer, image proof and env owner run.
                    io: { async resolveTool() { return null; }, async run(request: Parameters<ProjectNativeToolchainIo['run']>[0]) {
                        const args = request.args;
                        const projectIndex = args.indexOf('--project-name');
                        if (projectIndex >= 0) activeProjectName = args[projectIndex + 1];
                        const projectFilter = args.find(arg => arg.startsWith('label=com.docker.compose.project='));
                        if (projectFilter) activeProjectName = projectFilter.slice('label=com.docker.compose.project='.length);
                        if (args.includes('version')) return { exitCode: 0, stdout: args.includes('compose') ? '2.39.4' : 'linux/amd64' };
                        if (args.includes('info')) return { exitCode: 0, stdout: JSON.stringify({ ID: 'engine', OperatingSystem: 'Linux' }) };
                        const binds = options.incumbentBinds ?? (options.incumbentBind ? [options.incumbentBind] : []);
                        const observed = activated || !binds.length ? [undefined] : binds;
                        if (args.includes('--type') && args.includes('container')) return { exitCode: 0, stdout: JSON.stringify(observed.map((bind, index) =>
                            ({ Id: (index === 0 ? 'c' : 'd').repeat(64), Image: manifestDigest, RestartCount: 0,
                                Config: { Labels: { 'com.docker.compose.project': options.incumbentBind?.foreign ? 'foreign' : activeProjectName,
                                    'com.docker.compose.service': bind?.service ?? 'app' } },
                                Mounts: bind ? [{ Type: 'bind', Source: nativeMountChanged ? `${bind.source}.changed` : bind.source, Destination: bind.target }] : [],
                                State: { Status: !activated ? options.incumbentBind?.status ?? 'running' : 'running',
                                    Health: { Status: 'healthy' } }, NetworkSettings: { Ports: {} } }))) };
                        if (args[0] === 'ps') return { exitCode: 0, stdout: activated ? 'c'.repeat(64)
                            : binds.map((_bind, index) => (index === 0 ? 'c' : 'd').repeat(64)).join('\n') };
                        if (args.includes('config')) {
                            const stdout = args.includes('--no-interpolate') ? JSON.stringify(model)
                                : nativeConfiguration(request, args);
                            return { exitCode: 0, stdout };
                        }
                        if (args.includes('inspect')) return { exitCode: 0, stdout: JSON.stringify([{ Id: manifestDigest, Descriptor: { digest: manifestDigest } }]) };
                        if (args.includes('save')) { await copyFile(archive, args[args.indexOf('--output') + 1]); return { exitCode: 0, stdout: '' }; }
                        nativeMutations.push(args.join(' '));
                        if (options.activate && (args.includes('tag') || args.includes('up') || args.includes('stop') || args.includes('start'))) {
                            if (args.includes('up')) {
                                const effective = JSON.parse(nativeConfiguration(request, [...args.slice(0, args.indexOf('up')), 'config', '--format', 'json']));
                                renderedBindSources.push(...effective.services.app.volumes
                                    .filter((mount: { type: string }) => mount.type === 'bind').map((mount: { source: string }) => mount.source));
                                activated = true;
                            }
                            return { exitCode: 0, stdout: '' };
                        }
                        throw new Error('Review must not activate or mutate images');
                    } }, async settleNative() {} };
                const project = createNativeComposeLifecycle(projectInput);
                try {
                    const rendered = await project.render();
                    // Review is the owner's final effective model, after shared
                    // bind projection; earlier config also runs discovery passes.
                    renderedBindSources.push(...rendered.review.services.flatMap(service => service.mounts
                        .flatMap(mount => mount.type === 'bind' && mount.source !== null ? [mount.source] : [])));
                    activeProjectName = rendered.projectName;
                    await options.beforeActivate?.();
                    if (options.activate) await machineNativeEffectAdmission.run({ operation: { operationId: 'seed-operation', kind: 'deployments.deploy', signal },
                        keys: rendered.keys, settleNative: project.settleNative }, context => project.activate({ render: rendered, context, signal,
                            onIncumbentServicesChanged: options.onIncumbentServicesChanged }));
                    return rendered;
                }
                finally { await project.dispose(); }
            } });
        } finally { await source.abort(); }
    } finally { await rm(root, { recursive: true, force: true }); }
}

describe('resolved image and effective Compose storage admission', () => {
    it('reviews a mixed native incumbent outside selected and serving receipts through one exact custody read', async () => {
        await withStorageFixture(async fixture => {
            const priorDatabasePath = join(fixture.sourcePath, 'config', 'state.sqlite');
            const database = new DatabaseSync(priorDatabasePath);
            try { database.exec("UPDATE rows SET value = 'mixed incumbent row'"); } finally { database.close(); }
            await fixture.advanceSource();
            const options = { machines: 1, shared: true, exactIncumbent: 'valid' as const,
                volumes: [{ type: 'bind', source: join(fixture.sourcePath, 'config', 'state.sqlite'), target: '/new.sqlite' }],
                incumbentBind: { source: priorDatabasePath, target: '/old.sqlite', service: 'old_app' } };
            await fixture.render(options);
            expect(fixture.renderedBindSources.at(-1)).toBe(join(fixture.sourcePath, '..', '..', 'shared', 'config', 'state.sqlite'));
            expect(fixture.incumbentReceiptReads).toEqual(['deployment']);
            expect(fixture.nativeMutations).toEqual([]);
            for (const exactIncumbent of ['wrong-root', 'wrong-source', 'wrong-restoration', 'foreign-environment', 'changed-mount'] as const) {
                await expect(fixture.render({ ...options, exactIncumbent })).rejects.toMatchObject({ code: 'deployment_source_unavailable' });
            }
            expect(fixture.nativeMutations).toEqual([]);
            await fixture.render({ ...options, activate: true });
            const sharedPath = join(fixture.sourcePath, '..', '..', 'shared', 'config', 'state.sqlite');
            const shared = new DatabaseSync(sharedPath);
            try { expect(shared.prepare('SELECT value FROM rows').get()?.value).toBe('mixed incumbent row'); } finally { shared.close(); }
        });
    });
    it.each(['file', 'directory'] as const)('carries the actual prior SQLite row from a %s bind across source materialization and service plus mount-target rename', async priorKind => {
        await withStorageFixture(async fixture => {
            const priorDatabasePath = join(fixture.sourcePath, 'config', 'state.sqlite');
            const priorMountPath = priorKind === 'directory' ? join(fixture.sourcePath, 'config') : priorDatabasePath;
            const priorTarget = priorKind === 'directory' ? '/old-data' : '/old.sqlite';
            await fixture.render({ machines: 1, shared: true,
                volumes: [{ type: 'bind', source: priorMountPath, target: priorTarget }] });
            const database = new DatabaseSync(priorDatabasePath);
            try { database.exec("UPDATE rows SET value = 'actual incumbent row'"); } finally { database.close(); }
            await fixture.advanceSource();
            const candidateDatabasePath = join(fixture.sourcePath, 'config', 'state.sqlite');
            await fixture.render({ machines: 1, shared: true, activate: true,
                volumes: [{ type: 'bind', source: candidateDatabasePath, target: '/new.sqlite' }],
                incumbentBind: { source: priorMountPath, target: priorTarget, service: 'old_app' } });
            const sharedPath = join(fixture.sourcePath, '..', '..', 'shared', 'config', 'state.sqlite');
            const shared = new DatabaseSync(sharedPath);
            try { expect(shared.prepare('SELECT value FROM rows').get()?.value).toBe('actual incumbent row'); } finally { shared.close(); }
            const candidate = new DatabaseSync(candidateDatabasePath);
            try { expect(candidate.prepare('SELECT value FROM rows').get()?.value).toBe('source sample'); } finally { candidate.close(); }
            expect(fixture.nativeMutations).toContain(`stop ${'c'.repeat(64)}`);
            if (priorKind === 'directory') {
                const settings = join(fixture.sourcePath, 'config', 'settings.json');
                await fixture.render({ machines: 1, shared: true,
                    volumes: [{ type: 'bind', source: settings, target: '/settings.json' }],
                    incumbentBind: { source: priorMountPath, target: priorTarget, service: 'old_app' } });
                expect(fixture.renderedBindSources.at(-1)).toBe(settings);
                const fresh = join(fixture.sourcePath, 'config', 'new.sqlite');
                await writeFile(fresh, 'new candidate data');
                await fixture.render({ machines: 1, shared: true, activate: true,
                    volumes: [{ type: 'bind', source: fresh, target: priorTarget }],
                    incumbentBind: { source: priorMountPath, target: priorTarget } });
                expect(await readFile(join(sharedPath, '..', 'new.sqlite'), 'utf8')).toBe('new candidate data');
            }
            await rm(sharedPath);
            const secondIncumbent = candidateDatabasePath;
            const divergent = new DatabaseSync(secondIncumbent);
            try { divergent.exec("UPDATE rows SET value = 'divergent incumbent row'"); } finally { divergent.close(); }
            await fixture.advanceSource();
            fixture.nativeMutations.length = 0;
            await expect(fixture.render({ machines: 1, shared: true, activate: true,
                volumes: [{ type: 'bind', source: join(fixture.sourcePath, 'config', 'state.sqlite'), target: '/new.sqlite' }],
                incumbentBinds: [{ source: priorDatabasePath, target: '/old.sqlite', service: 'old_app' },
                    { source: secondIncumbent, target: '/other.sqlite', service: 'other_app' }] }))
                .rejects.toMatchObject({ code: 'deployment_source_unavailable' });
            expect(fixture.nativeMutations).toEqual([]);
        });
    });
    it('refuses existing shared destinations through a linked shared root or parent without mutating external data', async () => {
        for (const linkedRoot of [true, false]) await withStorageFixture(async fixture => {
            const shared = join(fixture.sourcePath, '..', '..', 'shared');
            const outside = join(shared, '..', '..', 'outside');
            await mkdir(join(outside, 'data', 'link'), { recursive: true });
            await writeFile(join(outside, 'data', 'link', 'file'), 'outside row');
            await mkdir(join(fixture.sourcePath, 'data', 'link'), { recursive: true });
            await writeFile(join(fixture.sourcePath, 'data', 'link', 'file'), 'candidate row');
            if (linkedRoot) await symlink(outside, shared, 'junction');
            else {
                await mkdir(join(shared, 'data'), { recursive: true });
                await symlink(join(outside, 'data', 'link'), join(shared, 'data', 'link'), 'junction');
            }
            await expect(fixture.render({ machines: 1, shared: true, activate: true,
                volumes: [{ type: 'bind', source: join(fixture.sourcePath, 'data', 'link', 'file'), target: '/database.sqlite' }] }))
                .rejects.toMatchObject({ code: 'deployment_source_unavailable' });
            expect(await readFile(join(outside, 'data', 'link', 'file'), 'utf8')).toBe('outside row');
            expect(fixture.nativeMutations).toEqual([]);
        });
        await withStorageFixture(async fixture => {
            const shared = join(fixture.sourcePath, '..', '..', 'shared');
            const outside = join(shared, '..', '..', 'outside');
            await mkdir(join(shared, 'data', 'link'), { recursive: true });
            await mkdir(outside, { recursive: true });
            await writeFile(join(shared, 'data', 'link', 'file'), 'shared row');
            await writeFile(join(outside, 'file'), 'outside row');
            await mkdir(join(fixture.sourcePath, 'data', 'link'), { recursive: true });
            await writeFile(join(fixture.sourcePath, 'data', 'link', 'file'), 'candidate row');
            await expect(fixture.render({ machines: 1, shared: true, activate: true,
                volumes: [{ type: 'bind', source: join(fixture.sourcePath, 'data', 'link', 'file'), target: '/database.sqlite' }],
                async beforeActivate() {
                    await rm(join(shared, 'data', 'link'), { recursive: true });
                    await symlink(outside, join(shared, 'data', 'link'), 'junction');
                } })).rejects.toMatchObject({ code: 'deployment_source_unavailable' });
            expect(await readFile(join(outside, 'file'), 'utf8')).toBe('outside row');
            expect(fixture.nativeMutations).toEqual([]);
        });
    });
    it('quiesces an owning ancestor shared bind before seeding a new child file and refuses foreign writers', async () => {
        await withStorageFixture(async fixture => {
            const sharedData = join(fixture.sourcePath, '..', '..', 'shared', 'data');
            await mkdir(sharedData, { recursive: true });
            await mkdir(join(fixture.sourcePath, 'data'));
            await writeFile(join(fixture.sourcePath, 'data', 'new.sqlite'), 'candidate row');
            const volumes = [{ type: 'bind', source: join(fixture.sourcePath, 'data', 'new.sqlite'), target: '/database.sqlite' }];
            for (const status of ['running', 'paused', 'restarting']) {
                fixture.nativeMutations.length = 0;
                const stopped: string[][] = [];
                await fixture.render({ machines: 1, shared: true, activate: true, volumes,
                    incumbentBind: { source: sharedData, target: '/data', status },
                    async onIncumbentServicesChanged(services) {
                        // Starting a candidate withdraws the definite-down fact before native readiness settles.
                        expect(fixture.nativeMutations.some(command => command.includes(' up '))).toBe(false);
                        stopped.push([...services]);
                    } });
                expect(fixture.nativeMutations).toContain(`stop ${'c'.repeat(64)}`);
                expect(stopped).toEqual([['c'.repeat(64)], []]);
                expect(await readFile(join(sharedData, 'new.sqlite'), 'utf8')).toBe('candidate row');
                await rm(join(sharedData, 'new.sqlite'));
            }
            fixture.nativeMutations.length = 0;
            await expect(fixture.render({ machines: 1, shared: true, activate: true, volumes,
                incumbentBind: { source: sharedData, target: '/data', foreign: true } })).rejects.toMatchObject({ code: 'deployment_source_unavailable' });
            expect(fixture.nativeMutations).toEqual([]);
        });
    });
    it.each(['repository', 'stored'] as const)('seeds %s shared directory and SQLite data once without replacing later app rows', async sourceKind => {
        await withStorageFixture(async fixture => {
            await mkdir(join(fixture.sourcePath, 'data'));
            await writeFile(join(fixture.sourcePath, 'data', 'row'), 'incumbent row');
            if (process.platform !== 'win32') await symlink('/unread-external-data', join(fixture.sourcePath, 'data', 'link'));
            const databasePath = join(fixture.sourcePath, 'config', 'state.sqlite');
            const updateDatabase = new DatabaseSync(databasePath);
            try { updateDatabase.exec("UPDATE rows SET value = 'modified tracked row'"); } finally { updateDatabase.close(); }
            const volumes = [
                { type: 'bind', source: join(fixture.sourcePath, 'data'), target: '/data' },
                { type: 'bind', source: databasePath, target: '/database.sqlite' },
            ];
            await fixture.render({ sourceKind, machines: 1, shared: true, activate: true, absentIncumbent: true, volumes });
            const shared = join(fixture.sourcePath, '..', '..', 'shared');
            expect(await readFile(join(shared, 'data', 'row'), 'utf8')).toBe('incumbent row');
            const sharedDatabase = new DatabaseSync(join(shared, 'config', 'state.sqlite'));
            try { expect(sharedDatabase.prepare('SELECT value FROM rows').get()?.value).toBe('modified tracked row'); }
            finally { sharedDatabase.close(); }
            expect((await lstat(join(shared, 'config', 'state.sqlite'))).isFile()).toBe(true);
            expect((await lstat(join(shared, 'data'))).isSymbolicLink()).toBe(false);
            if (process.platform !== 'win32') expect(await readlink(join(shared, 'data', 'link'))).toBe('/unread-external-data');
            await writeFile(join(shared, 'data', 'row'), 'app row');
            await writeFile(join(fixture.sourcePath, 'data', 'row'), 'new source sample');
            await fixture.render({ sourceKind, machines: 1, shared: true, activate: true, volumes });
            expect(await readFile(join(shared, 'data', 'row'), 'utf8')).toBe('app row');
            expect(await readFile(join(fixture.sourcePath, 'data', 'row'), 'utf8')).toBe('new source sample');
        });
    });

    it('renders mutable release binds directly under shared while leaving unchanged config inputs in source', async () => {
        await withStorageFixture(async fixture => {
            await mkdir(join(fixture.sourcePath, 'data'));
            await writeFile(join(fixture.sourcePath, 'data', 'row'), 'incumbent');
            await writeFile(join(fixture.sourcePath, 'config', 'settings.json'), 'mutable sqlite row');
            await fixture.render({ machines: 1, shared: true, volumes: [
                { type: 'bind', source: join(fixture.sourcePath, 'data'), target: '/data' },
                { type: 'bind', source: join(fixture.sourcePath, 'config', 'settings.json'), target: '/database.sqlite' },
                { type: 'bind', source: join(fixture.sourcePath, 'compose.yaml'), target: '/source-compose.yaml', read_only: true },
                { type: 'bind', source: '/absolute/external', target: '/external' },
            ] });
            expect(fixture.renderedBindSources.slice(-4)).toEqual([
                join(fixture.sourcePath, '..', '..', 'shared', 'data'),
                join(fixture.sourcePath, '..', '..', 'shared', 'config', 'settings.json'),
                join(fixture.sourcePath, 'compose.yaml'), '/absolute/external',
            ]);
            // Review projects the mapping without copying incumbent data or
            // asking Docker to stop/activate any application.
            expect(fixture.nativeMutations).toEqual([]);
        });
    });
    it('refuses image-declared writable state before activation, including read_only containers', async () => {
        await withStorageFixture(async fixture => {
            for (const readOnly of [false, true]) await expect(fixture.render({ imageVolumes: ['/var/lib/data'], readOnly }))
                .rejects.toMatchObject({ code: 'stateful_service_multi_machine', details: { service: 'app', target: '/var/lib/data' } });
            expect(fixture.nativeMutations).toEqual([]);
        });
    });

    it('admits explicit read-only image overrides, ordinary read-only binds, tmpfs, configs and secrets', async () => {
        await withStorageFixture(async fixture => {
            expect(await fixture.render({ imageVolumes: ['/data/', '/tmp', '/settings', '/run/secrets/password'], volumes: [
                { type: 'volume', source: 'data', target: '/data', read_only: true },
                { type: 'bind', source: '/absolute/config', target: '/config', read_only: true },
            ], topVolumes: { data: { name: 'data' } } })).toMatchObject({ storage: { warnings: [] } });
            expect(fixture.nativeMutations).toEqual([]);
        });
    });

    it('refuses anonymous, external and network-driver volumes in multi-server mode', async () => {
        await withStorageFixture(async fixture => {
            await expect(fixture.render({ volumes: [{ type: 'volume', target: '/anonymous' }] }))
                .rejects.toMatchObject({ code: 'stateful_service_multi_machine', details: { target: '/anonymous' } });
            for (const volume of [{ name: 'network', external: true }, { name: 'network', driver: 'nfs' },
                { name: 'network', driver: 'local', driver_opts: { type: 'nfs', device: ':/data' } }]) {
                await expect(fixture.render({ volumes: [{ type: 'volume', source: 'network', target: '/data', read_only: true }], topVolumes: { network: volume } }))
                    .rejects.toMatchObject({ code: 'stateful_service_multi_machine', details: { reason: 'unsupported_storage' } });
            }
        });
    });

    it('rechecks unchanged manifest file/directory binds and refuses added or modified runtime bytes', async () => {
        await withStorageFixture(async fixture => {
            const volumes = [{ type: 'bind', source: join(fixture.sourcePath, 'config'), target: '/config' }];
            expect(await fixture.render({ volumes })).toMatchObject({ storage: { warnings: [{ kind: 'writable_source', service: 'app', target: '/config' }] } });
            expect(await fixture.render({ volumes: [{ type: 'bind', source: join(fixture.sourcePath, 'config', 'settings.json'), target: '/settings.json' }] }))
                .toMatchObject({ storage: { warnings: [{ kind: 'writable_source', service: 'app', target: '/settings.json' }] } });
            await writeFile(join(fixture.sourcePath, 'config', 'runtime-data'), 'mutable');
            await expect(fixture.render({ volumes })).rejects.toMatchObject({ code: 'stateful_service_multi_machine' });
            await writeFile(join(fixture.sourcePath, 'config', 'settings.json'), '{"port":3001}');
            await expect(fixture.render({ volumes: [{ type: 'bind', source: join(fixture.sourcePath, 'config', 'settings.json'), target: '/settings.json' }] }))
                .rejects.toMatchObject({ code: 'stateful_service_multi_machine' });
            await expect(fixture.render({ volumes: [{ type: 'bind', source: '/shared/data', target: '/data' }] }))
                .rejects.toMatchObject({ code: 'stateful_service_multi_machine' });
        });
    });

    it('warns for one-host replicas sharing writable named storage, but not isolated anonymous image volumes', async () => {
        await withStorageFixture(async fixture => {
            expect(await fixture.render({ machines: 1, replicas: 3, imageVolumes: ['/data'],
                volumes: [{ type: 'volume', source: 'data', target: '/data' }], topVolumes: { data: { name: 'data' } } }))
                .toMatchObject({ storage: { warnings: [{ kind: 'concurrent_writers', service: 'app', target: '/data', replicas: 3 }] } });
            expect(await fixture.render({ machines: 1, replicas: 3, imageVolumes: ['/data'] })).toMatchObject({ storage: { warnings: [] } });
        });
    });
});
