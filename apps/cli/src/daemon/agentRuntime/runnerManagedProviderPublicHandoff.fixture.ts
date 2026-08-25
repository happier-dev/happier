import { chmod, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDaemonArchivePluginChangePreparer } from '@/plugins/daemon/archiveChangePreparer';
import {
    createDaemonPluginChangeService,
    DaemonPluginChangePreparationError,
} from '@/plugins/daemon/changeService';
import { packLocalPlugin } from '@/plugins/packaging/pack';
import type {
    PluginRegistryRuntimeLifecycle,
} from '@/plugins/store/registry/currentState';

const PLUGIN_SDK_ROOT = fileURLToPath(new URL(
    '../../../../../packages/plugin-sdk/',
    import.meta.url,
));
const PLUGIN_SDK_SOURCE_ROOT = join(PLUGIN_SDK_ROOT, 'src');

export const PUBLIC_HANDOFF_AGENT_PLUGIN_ID =
    'acme.public-handoff-agent';
export const PUBLIC_HANDOFF_PROVIDER_PLUGIN_ID =
    'acme.public-provider-handoff';
export const PUBLIC_HANDOFF_AGENT_ID = 'public-handoff-agent';
export const PUBLIC_HANDOFF_PROVIDER_ID = 'gateway';
export const PUBLIC_HANDOFF_AGENT_SYSTEM_TOOL_ID =
    'public-handoff-agent-cli';
export const PUBLIC_HANDOFF_AGENT_PROVIDER_ENV_KEY =
    'PUBLIC_PROVIDER_TOKEN';
export const PUBLIC_HANDOFF_PROVIDER_BEARER_ENV_KEY =
    'PUBLIC_PROVIDER_DOWNSTREAM_BEARER';
export const PUBLIC_HANDOFF_PROVIDER_SERVICE_ID =
    'public-provider-managed';
export const PUBLIC_HANDOFF_PROVIDER_BINARY_NAME =
    'happier-public-provider-fixture';
export const PUBLIC_HANDOFF_PROVIDER_ENDPOINT_ID = 'responses';

export type PublicHandoffFixtureArchivePhase =
    | 'archive pack'
    | 'archive install request'
    | 'archive installation commit';

export type PackedPublicHandoffFixture = Readonly<{
    pluginId: string;
    version: string;
    archivePath: string;
    archiveDigest: string;
    archiveIntegrity: string;
    archiveSizeBytes: number;
}>;

async function writeExternalAuthorPackage(input: Readonly<{
    pluginRoot: string;
    packageName: string;
    version: string;
    files: readonly string[];
}>): Promise<void> {
    await rm(input.pluginRoot, { recursive: true, force: true });
    await mkdir(join(input.pluginRoot, 'node_modules', '@happier-dev'), {
        recursive: true,
    });
    await symlink(
        PLUGIN_SDK_SOURCE_ROOT,
        join(input.pluginRoot, 'node_modules', '@happier-dev', 'plugin-sdk'),
        process.platform === 'win32' ? 'junction' : 'dir',
    );
    await writeFile(join(input.pluginRoot, 'package.json'), JSON.stringify({
        name: input.packageName,
        version: input.version,
        type: 'module',
        keywords: ['happier-plugin'],
        happier: { manifest: '.happier-plugin/plugin.json' },
        files: input.files,
        dependencies: { '@happier-dev/plugin-sdk': '0.0.0' },
    }, null, 2), 'utf8');
}

export async function writePublicHandoffAgentPluginFixture(input: Readonly<{
    pluginRoot: string;
    version: string;
    generation: 'G' | 'H';
}>): Promise<void> {
    await writeExternalAuthorPackage({
        pluginRoot: input.pluginRoot,
        packageName: 'happier-plugin-acme-public-handoff-agent',
        version: input.version,
        files: ['index.ts', 'agentRuntime.ts'],
    });
    await writeFile(join(input.pluginRoot, 'agentRuntime.ts'), [
        `export const fixtureAgentGeneration = ${JSON.stringify(input.generation)};`,
        'export function publicHandoffAgentRuntimeFactory() {',
        '  return {',
        '    fixtureAgentGeneration,',
        '    sessions: {',
        '      async open() {',
        '        return {',
        "          async send() { return { status: 'admitted' }; },",
        '          async cancel() {},',
        '          watch() { return { dispose() {} }; },',
        '          async dispose() {},',
        '        };',
        '      },',
        '    },',
        '  };',
        '}',
        '',
    ].join('\n'), 'utf8');
    await writeFile(join(input.pluginRoot, 'index.ts'), [
        "import { definePlugin } from '@happier-dev/plugin-sdk';",
        "import { publicHandoffAgentRuntimeFactory } from './agentRuntime.js';",
        'const providerBinding = Object.freeze({',
        '  v: 1, adapterVersion: 1,',
        "  prepare() { return { v: 1, materialization: 'spawnEnv' }; },",
        '  async materialize(input) {',
        "    if (input.credential.kind !== 'apiKey') throw new Error('Public handoff fixture requires the managed bearer');",
        "    return { v: 1, kind: 'spawnEnv', env: [{",
        `      name: ${JSON.stringify(PUBLIC_HANDOFF_AGENT_PROVIDER_ENV_KEY)}, value: input.credential.value, source: 'provider',`,
        '    }] };',
        '  },',
        '});',
        'const plugin = definePlugin({',
        `  id: ${JSON.stringify(PUBLIC_HANDOFF_AGENT_PLUGIN_ID)},`,
        `  version: ${JSON.stringify(input.version)},`,
        `  displayName: ${JSON.stringify(`Public handoff Agent fixture ${input.generation}`)},`,
        "  engines: { happier: '^0.2.0' },",
        "  entrypoints: { daemon: './dist/index.js' },",
        '  hostAccess: { required: [{',
        "    id: 'agent-process', capability: 'process', reason: 'Launch the fixture Agent process',",
        `    scope: { executables: [{ kind: 'systemTool', id: ${JSON.stringify(PUBLIC_HANDOFF_AGENT_SYSTEM_TOOL_ID)} }],`,
        `      envKeys: [${JSON.stringify(PUBLIC_HANDOFF_AGENT_PROVIDER_ENV_KEY)}] },`,
        '  }], optional: [] },',
        '  agents: {',
        `    ${JSON.stringify(PUBLIC_HANDOFF_AGENT_ID)}: {`,
        '      declaration: {',
        "        title: 'Public handoff Agent', runtime: { kind: 'custom' }, primary: 'sessions',",
        "        capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },",
        '        providerRequirements: {',
        "          acceptsProtocols: ['openai-responses'], required: { streaming: true, toolRoundTrips: true },",
        "          credentialSupport: { supportsNoAuth: true, apiKeyTransports: [{ protocol: 'openai-responses',",
        "            destination: { kind: 'httpHeader', names: 'anyValidated', formats: ['raw', 'bearer'] } }] },",
        `          authIsolation: { suppressConnectedServiceIds: [], ownedEnvKeys: [${JSON.stringify(PUBLIC_HANDOFF_AGENT_PROVIDER_ENV_KEY)}] },`,
        "          materialization: 'spawnEnv', applyPolicy: 'restart_session', supportsFreeformModelIds: true,",
        '        },',
        '      },',
        '      factory: publicHandoffAgentRuntimeFactory, providerBinding,',
        "      sessionRunnerFactory: { module: './agentRuntime.js', export: 'publicHandoffAgentRuntimeFactory', runtimeApiVersion: 1 },",
        '    },',
        '  },',
        '  systemTools: {',
        `    ${JSON.stringify(PUBLIC_HANDOFF_AGENT_SYSTEM_TOOL_ID)}: { title: 'Public handoff Agent CLI',`,
        `      executableNames: [${JSON.stringify(process.platform === 'win32' ? 'node.exe' : 'node')}] },`,
        '  },',
        '});',
        'export const manifest = plugin.manifest;',
        'export const activate = plugin.activate;',
        '',
    ].join('\n'), 'utf8');
}

export async function writePublicHandoffProviderPluginFixture(input: Readonly<{
    pluginRoot: string;
    version: string;
    generation: 'P' | 'Q';
}>): Promise<void> {
    await writeExternalAuthorPackage({
        pluginRoot: input.pluginRoot,
        packageName: 'happier-plugin-acme-public-provider-handoff',
        version: input.version,
        files: ['index.ts', 'tools/unpacked'],
    });
    const runtimeBinaryName = process.platform === 'win32'
        ? `${PUBLIC_HANDOFF_PROVIDER_BINARY_NAME}.exe`
        : PUBLIC_HANDOFF_PROVIDER_BINARY_NAME;
    const runtimeBinaryPath = join(
        input.pluginRoot,
        'tools',
        'unpacked',
        runtimeBinaryName,
    );
    await mkdir(join(input.pluginRoot, 'tools', 'unpacked'), {
        recursive: true,
    });
    await writeFile(
        runtimeBinaryPath,
        `#!/bin/sh\n# public-provider-fixture ${input.generation}\nexit 0\n`,
        'utf8',
    );
    if (process.platform !== 'win32') {
        await chmod(runtimeBinaryPath, 0o755);
    }
    await writeFile(join(input.pluginRoot, 'index.ts'), [
        "import { definePlugin } from '@happier-dev/plugin-sdk';",
        `export const fixtureProviderGeneration = ${JSON.stringify(input.generation)};`,
        'const runtime = Object.freeze({',
        '  async start(request, context) {',
        '    const service = await context.managedServices.supervise({',
        `      id: ${JSON.stringify(PUBLIC_HANDOFF_PROVIDER_SERVICE_ID)},`,
        "      clientAccess: { kind: 'hostBearer',",
        `        injectEnvironmentKey: ${JSON.stringify(PUBLIC_HANDOFF_PROVIDER_BEARER_ENV_KEY)},`,
        "        headerName: 'authorization', scheme: 'Bearer' },",
        "      mode: { kind: 'spawn', launch: { executable: { kind: 'packaged-runtime-binary',",
        "        directorySegments: ['tools', 'unpacked'],",
        `        executableBaseName: ${JSON.stringify(PUBLIC_HANDOFF_PROVIDER_BINARY_NAME)} },`,
        "        env: { HOST: '127.0.0.1', FIXTURE_PROVIDER_GENERATION: fixtureProviderGeneration } },",
        "        endpoint: { kind: 'assignAndInject', host: '127.0.0.1', port: { kind: 'allocated' }, inject: { portEnvironmentKey: 'PORT' } } },",
        "      healthCheck: { kind: 'http', target: { kind: 'servicePath', path: '/healthz' } },",
        '    }, { signal: context.signal });',
        '    const snapshot = await service.waitUntilHealthy({ signal: context.signal });',
        "    if (snapshot.state !== 'healthy' || snapshot.baseUrl === null) { await service.dispose(); throw new Error('Public handoff fixture did not become healthy'); }",
        '    return { service, endpoints: request.endpointTemplateIds.map((endpointTemplateId) => ({',
        "      endpointTemplateId, endpoint: { kind: 'servicePath', path: '/v1' },",
        '    })) };',
        '  },',
        '});',
        'const plugin = definePlugin({',
        `  id: ${JSON.stringify(PUBLIC_HANDOFF_PROVIDER_PLUGIN_ID)},`,
        `  version: ${JSON.stringify(input.version)},`,
        `  displayName: ${JSON.stringify(`Public managed Provider handoff fixture ${input.generation}`)},`,
        "  engines: { happier: '^0.2.0' }, entrypoints: { daemon: './dist/index.js' },",
        '  providers: {',
        `    ${JSON.stringify(PUBLIC_HANDOFF_PROVIDER_ID)}: { declaration: {`,
        "      v: 1, name: 'Public handoff gateway', kind: 'aggregator',",
        "      credential: { kind: 'apiKey', required: false, slotId: 'apiKey', transports: [{",
        "        id: 'runtime-bearer', protocols: ['openai-responses'], uses: ['runtime'],",
        "        destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' } }] },",
        `      endpointTemplates: [{ id: ${JSON.stringify(PUBLIC_HANDOFF_PROVIDER_ENDPOINT_ID)}, protocol: 'openai-responses', baseUrl: 'https://example.test/v1',`,
        "        capabilities: { streaming: 'supported', toolRoundTrips: 'supported', statefulResponses: 'unknown', reasoningControls: 'supported' } }],",
        "      catalog: { source: 'static', manualModelPolicy: 'allowed', staticModels: [{ id: 'gpt-public-p-composed', name: 'GPT public P composed',",
        "        capabilities: { toolRoundTrips: 'supported', reasoningControls: 'supported' } }] },",
        `      managedRuntime: { kind: 'managed', endpointTemplateIds: [${JSON.stringify(PUBLIC_HANDOFF_PROVIDER_ENDPOINT_ID)}] },`,
        '    }, runtime },',
        '  },',
        '});',
        'export const manifest = plugin.manifest;',
        'export const activate = plugin.activate;',
        '',
    ].join('\n'), 'utf8');
}

export function createPublicHandoffArchiveChangeService(
    happyHomeDir: string,
    runtimeLifecycle?: PluginRegistryRuntimeLifecycle,
) {
    let pendingChangeSequence = 0;
    const prepareArchive = createDaemonArchivePluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle: runtimeLifecycle ?? {
            prepare: async () => Object.freeze({
                abort: async () => undefined,
                adopt: async () => undefined,
            }),
        },
    });
    return createDaemonPluginChangeService({
        prepare: async (request) => {
            try {
                return await prepareArchive(request);
            } catch (error) {
                throw new DaemonPluginChangePreparationError(
                    'fixture_archive_prepare_failed',
                    error instanceof Error ? error.message : String(error),
                );
            }
        },
        createPendingChangeId: () => `public-handoff-${++pendingChangeSequence}`,
    });
}

export async function packPublicHandoffFixture(input: Readonly<{
    archivePath: string;
    onPhase?: (phase: PublicHandoffFixtureArchivePhase) => void;
    pluginId: string;
    pluginRoot: string;
}>): Promise<PackedPublicHandoffFixture> {
    input.onPhase?.('archive pack');
    const packed = await packLocalPlugin({
        locator: input.pluginRoot,
        outPath: input.archivePath,
    });
    if (!packed.ok) {
        throw new Error(packed.diagnostics.map((entry) => entry.message).join('\n'));
    }
    if (packed.pluginId !== input.pluginId) {
        throw new Error(
            `Packed fixture identity mismatch: expected ${input.pluginId}, received ${packed.pluginId}`,
        );
    }
    return Object.freeze({
        pluginId: packed.pluginId,
        version: packed.version,
        archivePath: packed.archivePath,
        archiveDigest: packed.archiveDigest,
        archiveIntegrity: packed.archiveIntegrity,
        archiveSizeBytes: packed.archiveSizeBytes,
    });
}

export async function commitPackedPublicHandoffFixture(input: Readonly<{
    changeService: ReturnType<typeof createPublicHandoffArchiveChangeService>;
    onPhase?: (phase: PublicHandoffFixtureArchivePhase) => void;
    packed: PackedPublicHandoffFixture;
}>): Promise<PackedPublicHandoffFixture & Readonly<{
    immutableGenerationId: string;
}>> {
    input.onPhase?.('archive install request');
    const requested = await input.changeService.requestPluginChange({
        kind: 'installArchive',
        locator: input.packed.archivePath,
        expectedIntegrity: input.packed.archiveIntegrity,
    });
    if (requested.kind !== 'reviewRequired') {
        throw new Error(
            `Expected archive review for ${input.packed.pluginId}, received ${JSON.stringify(requested)}`,
        );
    }
    input.onPhase?.('archive installation commit');
    const committed = await input.changeService.decidePluginChange({
        pendingChangeId: requested.pendingChangeId,
        decision: 'installAndTrust',
        actorEvidence: {
            kind: 'authenticatedLocalUser',
            interactionId: `public-handoff-${input.packed.pluginId}`,
            occurredAtMs: 1,
        },
    });
    if (committed.kind !== 'committed' || !committed.appliedGeneration) {
        throw new Error(`Expected archive commit for ${input.packed.pluginId}, received ${committed.kind}`);
    }
    return Object.freeze({
        ...input.packed,
        immutableGenerationId: committed.appliedGeneration,
    });
}

export async function packAndCommitPublicHandoffFixture(input: Readonly<{
    archivePath: string;
    changeService: ReturnType<typeof createPublicHandoffArchiveChangeService>;
    onPhase?: (phase: PublicHandoffFixtureArchivePhase) => void;
    pluginId: string;
    pluginRoot: string;
}>): Promise<PackedPublicHandoffFixture & Readonly<{
    immutableGenerationId: string;
}>> {
    const packed = await packPublicHandoffFixture(input);
    return commitPackedPublicHandoffFixture({
        changeService: input.changeService,
        onPhase: input.onPhase,
        packed,
    });
}
