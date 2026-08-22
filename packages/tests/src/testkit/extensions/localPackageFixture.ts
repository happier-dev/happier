import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { PluginContributesV2 } from '@happier-dev/protocol';

type LocalExtensionContribution = Readonly<Record<string, unknown>>;
type LocalExtensionContributionMap = Readonly<Record<string, readonly LocalExtensionContribution[] | undefined>>;
const SUPPORTED_CONTRIBUTION_FAMILIES = new Set<string>([
    'actions',
    'agents',
    'commands',
    'connectedAccountDescriptors',
    'events',
    'executionRunProfiles',
    'hooks',
    'managedDependencies',
    'mcp',
    'notificationChannels',
    'notifications',
    'promptAssets',
    'providers',
    'resources',
    'scmBackends',
    'scmHostingProviders',
    'sessionHeaderActions',
    'settings',
    'systemTools',
    'tools',
    'ui',
    'voiceModelPacks',
    'voiceProviders',
] satisfies readonly (keyof PluginContributesV2)[]);

export type LocalExtensionPackageManifest = Readonly<{
    schemaVersion: 2;
    id: string;
    version: string;
    displayName: string;
    description: string;
    engines: Readonly<{
        happier: string;
    }>;
    uses: readonly ExtensionRuntimeCapability[];
    entrypoints: Readonly<{
        main: string;
        dev?: string;
    }>;
    declares: Readonly<{
        capabilities: readonly unknown[];
    }>;
    permissions: Readonly<{
        required: readonly Readonly<{
            capability: string;
            reason?: string;
        }>[];
        optional: readonly Readonly<{
            capability: string;
            reason?: string;
        }>[];
    }>;
    activationEvents: readonly string[];
    contributes: LocalExtensionContributionMap;
}> & Readonly<Record<string, unknown>>;

export type LocalExtensionPackageFixture = Readonly<{
    pluginId: string;
    pluginRoot: string;
    manifest: LocalExtensionPackageManifest;
}>;

export function createLocalExtensionPackageManifest(params: Readonly<{
    pluginId: string;
    version?: string;
    displayName?: string;
    description?: string;
    daemonEntry?: string;
    contributes?: LocalExtensionContributionMap;
    extraManifestFields?: Readonly<Record<string, unknown>>;
}>): LocalExtensionPackageManifest {
    const contributes = params.contributes ?? {};
    const inferredCapabilities = inferRuntimeCapabilitiesFromContributes(contributes);

    return {
        schemaVersion: 2,
        id: params.pluginId,
        version: params.version ?? '1.0.0',
        displayName: params.displayName ?? params.pluginId,
        description: params.description ?? `Local extension fixture for ${params.pluginId}`,
        engines: {
            happier: '^0.2.0',
        },
        uses: inferredCapabilities,
        entrypoints: {
            main: params.daemonEntry ?? './daemon.mjs',
        },
        declares: {
            capabilities: [],
        },
        permissions: {
            required: [],
            optional: [],
        },
        activationEvents: ['startup'],
        contributes,
        ...(params.extraManifestFields ?? {}),
    };
}

type ExtensionRuntimeCapability =
    | 'agents'
    | 'actions'
    | 'tools'
    | 'commands'
    | 'hooks'
    | 'resources'
    | 'settings'
    | 'managedDependencies'
    | 'mcp'
    | 'notifications'
    | 'executionRunProfiles'
    | 'reload';

function assertSupportedContributionFamilies(contributes: LocalExtensionContributionMap): void {
    const unsupported = Object.keys(contributes)
        .filter((family) => !SUPPORTED_CONTRIBUTION_FAMILIES.has(family))
        .sort();
    if (unsupported.length > 0) {
        throw new Error(`Unsupported plugin contribution families: ${unsupported.join(', ')}`);
    }
}

function inferRuntimeCapabilitiesFromContributes(
    contributes: LocalExtensionContributionMap,
): readonly ExtensionRuntimeCapability[] {
    assertSupportedContributionFamilies(contributes);
    const capabilities = new Set<ExtensionRuntimeCapability>();

    if ((contributes.agents?.length ?? 0) > 0) capabilities.add('agents');
    if ((contributes.actions?.length ?? 0) > 0) capabilities.add('actions');
    if ((contributes.tools?.length ?? 0) > 0) capabilities.add('tools');
    if ((contributes.commands?.length ?? 0) > 0) capabilities.add('commands');
    if ((contributes.hooks?.length ?? 0) > 0) capabilities.add('hooks');
    if ((contributes.resources?.length ?? 0) > 0) capabilities.add('resources');
    if ((contributes.settings?.length ?? 0) > 0) capabilities.add('settings');
    if ((contributes.managedDependencies?.length ?? 0) > 0) capabilities.add('managedDependencies');
    if (contributes.mcp) capabilities.add('mcp');
    if ((contributes.notifications?.length ?? 0) > 0) capabilities.add('notifications');
    if ((contributes.notificationChannels?.length ?? 0) > 0) capabilities.add('notifications');
    if ((contributes.executionRunProfiles?.length ?? 0) > 0) {
        capabilities.add('executionRunProfiles');
    }

    return [...capabilities];
}

function normalizeResourceContributionV1ish(value: LocalExtensionContribution): LocalExtensionContribution {
    const id = typeof value.id === 'string' ? value.id : null;
    const path = typeof value.path === 'string' ? value.path : null;
    const resourceKindCandidate = value.resourceKind ?? value.type;
    const resourceKind = typeof resourceKindCandidate === 'string' ? resourceKindCandidate : null;
    if (!id || !path || !resourceKind) {
        throw new Error('Invalid legacy resource contribution; expected id, path, and type/resourceKind');
    }

    const normalized: Record<string, unknown> = {
        kind: 'resource',
        id,
        resourceKind,
        path,
    };

    if (typeof value.digest === 'string') normalized.digest = value.digest;
    if (typeof value.contentType === 'string') normalized.contentType = value.contentType;

    return normalized;
}

function normalizeLegacyActionContributionV1ish(value: LocalExtensionContribution): LocalExtensionContribution {
    // If this already looks like a V2 action contribution, keep it.
    if (value.kind === 'action') return value;

    const actionId = typeof value.id === 'string' ? value.id : null;
    if (!actionId) {
        throw new Error('Invalid legacy action contribution; expected id');
    }

    const title = typeof value.title === 'string' ? value.title : 'Extension Action';
    const description = typeof value.description === 'string' ? value.description : undefined;
    const inputSchema = typeof value.inputSchema === 'object' && value.inputSchema !== null ? value.inputSchema : undefined;

    const execution = typeof value.execution === 'object' && value.execution !== null ? (value.execution as Record<string, unknown>) : null;
    const handlerRef = execution && typeof execution.handler === 'object' && execution.handler !== null
        ? (execution.handler as Record<string, unknown>)
        : null;
    const exportName = handlerRef && typeof handlerRef.exportName === 'string' ? handlerRef.exportName : 'executeAction';

    const placements = Array.isArray(value.placements) ? value.placements : [];
    const placement = placements.includes('command_palette') ? 'commandPalette' : 'commandPalette';

    const surfacesRaw = typeof value.surfaces === 'object' && value.surfaces !== null ? (value.surfaces as Record<string, unknown>) : {};
    const surfaces: string[] = [];
    if (surfacesRaw.cli === true) surfaces.push('cli');
    if (surfacesRaw.agent === true) surfaces.push('agent');
    if (surfacesRaw.mcp === true) surfaces.push('mcp');
    for (const surfaceName of Object.keys(surfacesRaw)) {
        if (surfaceName !== 'cli' && surfaceName !== 'agent' && surfaceName !== 'mcp') {
            throw new Error(`Unsupported action surface '${surfaceName}'`);
        }
    }
    if (surfaces.length === 0) surfaces.push('cli');

    return {
        kind: 'action',
        id: actionId,
        title,
        description,
        scopes: ['global'],
        surfaces,
        execution: { target: 'daemon' },
        placement,
        inputSchema,
        handler: {
            target: 'daemon',
            exportName,
        },
        dangerLevel: 'safe',
    };
}

function normalizeManifestForWrite(manifest: LocalExtensionPackageManifest): Record<string, unknown> {
    const contributes = normalizeContributesForWrite(manifest.contributes);

    const normalized: Record<string, unknown> = {
        schemaVersion: 2,
        id: manifest.id,
        version: manifest.version,
        displayName: manifest.displayName,
        description: manifest.description,
        engines: manifest.engines,
        uses: manifest.uses.length > 0 ? manifest.uses : inferRuntimeCapabilitiesFromContributes(contributes),
        entrypoints: manifest.entrypoints,
        declares: manifest.declares,
        permissions: manifest.permissions,
        activationEvents: manifest.activationEvents,
        contributes,
    };

    if (typeof manifest.source === 'object' && manifest.source !== null) normalized.source = manifest.source;
    if (typeof manifest.marketplace === 'object' && manifest.marketplace !== null) normalized.marketplace = manifest.marketplace;

    return normalized;
}

function normalizeContributesForWrite(contributes: LocalExtensionContributionMap): LocalExtensionContributionMap {
    assertSupportedContributionFamilies(contributes);
    const normalized: Record<string, readonly LocalExtensionContribution[]> = {};

    for (const [family, entries] of Object.entries(contributes)) {
        if (!Array.isArray(entries)) continue;
        if (family === 'actions') {
            normalized.actions = entries.map((entry) => normalizeLegacyActionContributionV1ish(entry));
        } else if (family === 'resources') {
            normalized.resources = entries.map((entry) => normalizeResourceContributionV1ish(entry));
        } else {
            normalized[family] = entries;
        }
    }

    return normalized;
}

export async function writeLocalExtensionPackageFixture(params: Readonly<{
    pluginRoot: string;
    daemonModuleContents: string;
    manifest: LocalExtensionPackageManifest;
}>): Promise<void> {
    const manifestDir = join(params.pluginRoot, '.happier-plugin');
    await mkdir(manifestDir, { recursive: true });

    await writeFile(join(params.pluginRoot, 'daemon.mjs'), params.daemonModuleContents, 'utf8');
    await writeFile(
        join(manifestDir, 'plugin.json'),
        JSON.stringify(normalizeManifestForWrite(params.manifest), null, 2),
        'utf8',
    );
}

export async function writeEnabledLocalExtensionPackageState(params: Readonly<{
    happyHomeDir: string;
    pluginRoot: string;
    pluginId: string;
    manifestVersion?: string;
}>): Promise<void> {
    const { writeEnabledPluginSdkV1State } = await import('../plugins/pluginSdkV1Fixture');
    await writeEnabledPluginSdkV1State({
        happyHomeDir: params.happyHomeDir,
        pluginRoot: params.pluginRoot,
        pluginId: params.pluginId,
        manifestVersion: params.manifestVersion,
        devWatch: true,
    });
}

export function createActivationRuntimeDaemonModule(params: Readonly<{
    activationBody: string;
}>): string {
    return [
        'export async function activate(api) {',
        params.activationBody,
        '}',
        '',
    ].join('\n');
}

export function createPluginActionContribution(params: Readonly<{
    actionId: string;
    title?: string;
    description?: string;
    exportName?: string;
}>): LocalExtensionContribution {
    return {
        kind: 'action',
        id: params.actionId,
        title: params.title ?? 'Plugin Fixture Action',
        description: params.description,
        scopes: ['global'],
        surfaces: ['cli', 'agent'],
        execution: { target: 'daemon' },
        placementBindings: ['commandPalette'],
        inputSchema: {
            type: 'object',
            additionalProperties: true,
        },
        handler: {
            target: 'daemon',
            exportName: params.exportName ?? 'executeAction',
        },
        dangerLevel: 'safe',
    };
}

export async function writeActionExecutionPluginFixture(params: Readonly<{
    pluginRoot: string;
    pluginId: string;
    actionId: string;
    markerPath: string;
    resultValue?: string;
}>): Promise<LocalExtensionPackageFixture> {
    const manifest = createLocalExtensionPackageManifest({
        pluginId: params.pluginId,
        displayName: 'Action Execution Fixture',
        description: 'Contributes a daemon-executed action for core e2e validation',
        contributes: {
            actions: [
                createPluginActionContribution({
                    actionId: params.actionId,
                    title: 'Fixture Action',
                    exportName: 'executeAction',
                }),
            ],
        },
    });
    const resultValue = params.resultValue ?? 'plugin-action-fired';
    await writeLocalExtensionPackageFixture({
        pluginRoot: params.pluginRoot,
        manifest,
        daemonModuleContents: [
            'import { writeFile } from "node:fs/promises";',
            '',
            'export async function executeAction(input = {}) {',
            `  await writeFile(${JSON.stringify(params.markerPath)}, ${JSON.stringify(`${resultValue}\n`)}, "utf8");`,
            `  return { ok: true, data: { value: ${JSON.stringify(resultValue)}, input } };`,
            '}',
            '',
        ].join('\n'),
    });
    return {
        pluginId: params.pluginId,
        pluginRoot: params.pluginRoot,
        manifest,
    };
}

export async function writeActivatedActionExecutionPluginFixture(params: Readonly<{
    pluginRoot: string;
    pluginId: string;
    actionId: string;
    markerPath: string;
    resultValue?: string;
}>): Promise<LocalExtensionPackageFixture> {
    const manifest: LocalExtensionPackageManifest = {
        schemaVersion: 2,
        id: params.pluginId,
        version: '1.0.0',
        displayName: 'Activated Action Execution Fixture',
        description: 'Registers a daemon-executed action during activation for core e2e validation',
        engines: {
            happier: '^0.2.0',
        },
        uses: ['actions'],
        entrypoints: {
            main: './daemon.mjs',
        },
        declares: {
            capabilities: [],
        },
        permissions: {
            required: [],
            optional: [],
        },
        activationEvents: ['startup'],
        contributes: {
            actions: [
                createPluginActionContribution({
                    actionId: params.actionId,
                    title: 'Fixture Activated Action',
                    description: 'Executes through the runtime activation registry',
                }),
            ],
        },
    };
    const resultValue = params.resultValue ?? 'plugin-action-fired';
    await writeLocalExtensionPackageFixture({
        pluginRoot: params.pluginRoot,
        manifest,
        daemonModuleContents: [
            'import { writeFile } from "node:fs/promises";',
            '',
            'export async function activate(api) {',
            '  api.registerAction({',
            `    id: ${JSON.stringify(params.actionId)},`,
            '    handler: async (request = {}) => {',
            `      await writeFile(${JSON.stringify(params.markerPath)}, ${JSON.stringify(`${resultValue}\n`)}, "utf8");`,
            `      return { ok: true, data: { value: ${JSON.stringify(resultValue)}, input: request.input ?? null } };`,
            '    },',
            '  });',
            '}',
            '',
        ].join('\n'),
    });
    return {
        pluginId: params.pluginId,
        pluginRoot: params.pluginRoot,
        manifest,
    };
}

export async function writeRuntimeProjectionPluginFixture(params: Readonly<{
    pluginRoot: string;
    pluginId: string;
    actionId?: string;
    resourceId?: string;
    settingsId?: string;
}>): Promise<LocalExtensionPackageFixture> {
    const actionId = params.actionId ?? `${params.pluginId}-refresh`;
    const resourceId = params.resourceId ?? `${params.pluginId}-prompt`;
    const settingsId = params.settingsId ?? 'preferences';
    const manifest: LocalExtensionPackageManifest = {
        schemaVersion: 2,
        id: params.pluginId,
        version: '1.0.0',
        displayName: 'Runtime Projection Fixture',
        description: 'Registers runtime actions, resources, and typed settings for projection validation',
        engines: {
            happier: '^0.2.0',
        },
        uses: ['actions', 'resources', 'settings'],
        entrypoints: {
            main: './daemon.mjs',
        },
        declares: {
            capabilities: [],
        },
        permissions: {
            required: [],
            optional: [],
        },
        activationEvents: ['startup'],
        contributes: {
            actions: [
                createPluginActionContribution({
                    actionId,
                    title: 'Fixture Refresh',
                    description: 'Runtime action visible in plugin details',
                }),
            ],
            resources: [
                {
                    id: resourceId,
                    resourceKind: 'prompt',
                    title: 'Fixture Prompt',
                    path: './resources/prompt.md',
                    digest: 'sha256:fixture-prompt',
                    contentType: 'text/markdown',
                },
            ],
            settings: [
                {
                    id: settingsId,
                    title: 'Plugin preferences',
                    target: { kind: 'plugin' },
                    scope: 'local',
                    fields: [
                        {
                            id: 'enabled',
                            title: 'Enabled',
                            description: 'Example host-rendered plugin preference.',
                            schema: { type: 'boolean' },
                            default: true,
                        },
                    ],
                },
            ],
        },
    };

    await mkdir(join(params.pluginRoot, 'resources'), { recursive: true });
    await writeFile(join(params.pluginRoot, 'resources', 'prompt.md'), '# Fixture Prompt\n', 'utf8');
    await writeLocalExtensionPackageFixture({
        pluginRoot: params.pluginRoot,
        manifest,
        daemonModuleContents: [
            'export async function activate(api) {',
            '    api.registerAction({',
            `        id: ${JSON.stringify(actionId)},`,
            '        handler: async () => ({ ok: true, source: "fixture" }),',
            '    });',
            '}',
            '',
        ].join('\n'),
    });
    return {
        pluginId: params.pluginId,
        pluginRoot: params.pluginRoot,
        manifest,
    };
}

export async function writeReloadableActivationPluginFixture(params: Readonly<{
    pluginRoot: string;
    pluginId: string;
    actionId: string;
    generation: string;
    activationMarkerPath: string;
    disposeMarkerPath: string;
}>): Promise<LocalExtensionPackageFixture> {
    const manifest: LocalExtensionPackageManifest = {
        schemaVersion: 2,
        id: params.pluginId,
        version: '1.0.0',
        displayName: 'Reloadable Activation Fixture',
        description: 'Exercises activation, disposal, and reload for core e2e validation',
        engines: {
            happier: '^0.2.0',
        },
        uses: ['actions'],
        entrypoints: {
            main: './daemon.mjs',
        },
        declares: {
            capabilities: [],
        },
        permissions: {
            required: [],
            optional: [],
        },
        activationEvents: ['startup'],
        contributes: {
            actions: [
                createPluginActionContribution({
                    actionId: params.actionId,
                    title: `Reload Fixture ${params.generation}`,
                }),
            ],
        },
    };
    await writeLocalExtensionPackageFixture({
        pluginRoot: params.pluginRoot,
        manifest,
        daemonModuleContents: [
            'import { appendFile } from "node:fs/promises";',
            '',
            'export async function activate(api) {',
            `  await appendFile(${JSON.stringify(params.activationMarkerPath)}, ${JSON.stringify(`activate:${params.generation}\n`)}, "utf8");`,
            '  api.registerAction({',
            `    id: ${JSON.stringify(params.actionId)},`,
            '    handler: async () => ({ ok: true, data: { generation: ' + JSON.stringify(params.generation) + ' } }),',
            '  });',
            '  api.onDispose(async () => {',
            `    await appendFile(${JSON.stringify(params.disposeMarkerPath)}, ${JSON.stringify(`dispose:${params.generation}\n`)}, "utf8");`,
            '  });',
            '}',
            '',
        ].join('\n'),
    });
    return {
        pluginId: params.pluginId,
        pluginRoot: params.pluginRoot,
        manifest,
    };
}

export async function writeBrokenActivationPluginFixture(params: Readonly<{
    pluginRoot: string;
    pluginId: string;
    failureMessage?: string;
}>): Promise<LocalExtensionPackageFixture> {
    const manifest: LocalExtensionPackageManifest = {
        schemaVersion: 2,
        id: params.pluginId,
        version: '1.0.0',
        displayName: 'Broken Activation Fixture',
        description: 'Exercises last-known-good reload failure behavior',
        engines: {
            happier: '^0.2.0',
        },
        uses: ['actions'],
        entrypoints: {
            main: './daemon.mjs',
        },
        declares: {
            capabilities: [],
        },
        permissions: {
            required: [],
            optional: [],
        },
        activationEvents: ['startup'],
        contributes: {},
    };
    await writeLocalExtensionPackageFixture({
        pluginRoot: params.pluginRoot,
        manifest,
        daemonModuleContents: [
            'export async function activate() {',
            `  throw new Error(${JSON.stringify(params.failureMessage ?? 'activation failed after edit')});`,
            '}',
            '',
        ].join('\n'),
    });
    return {
        pluginId: params.pluginId,
        pluginRoot: params.pluginRoot,
        manifest,
    };
}
