import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

type LocalExtensionContribution = Readonly<Record<string, unknown>>;

export type LocalExtensionPackageManifest = Readonly<{
    schemaVersion: 1 | 2;
    id: string;
    version: string;
    displayName: string;
    description: string;
    engines: Readonly<{
        happier: string;
    }>;
    targets: Readonly<{
        daemon: Readonly<{
            entry: string;
        }>;
    }>;
    contributions:
        | (Readonly<{
            providers?: readonly LocalExtensionContribution[];
            backends?: readonly LocalExtensionContribution[];
            actions?: readonly LocalExtensionContribution[];
            hooks?: readonly LocalExtensionContribution[];
            resources?: readonly LocalExtensionContribution[];
            uiDescriptors?: readonly LocalExtensionContribution[];
        }> & Readonly<Record<string, unknown>>)
        | readonly LocalExtensionContribution[];
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
    contributions?: LocalExtensionPackageManifest['contributions'];
    extraManifestFields?: Readonly<Record<string, unknown>>;
}>): LocalExtensionPackageManifest {
    const contributions = params.contributions ?? [];
    const inferredCapabilities = inferRuntimeCapabilitiesFromContributions(
        normalizeContributionsToV2Array(contributions),
    );

    return {
        schemaVersion: 2,
        id: params.pluginId,
        version: params.version ?? '1.0.0',
        displayName: params.displayName ?? params.pluginId,
        description: params.description ?? `Local extension fixture for ${params.pluginId}`,
        engines: {
            happier: '^0.2.0',
        },
        runtime: {
            apiVersion: 1,
            capabilities: inferredCapabilities,
        },
        permissions: [],
        targets: {
            daemon: {
                entry: params.daemonEntry ?? './daemon.mjs',
            },
        },
        contributions,
        ...(params.extraManifestFields ?? {}),
    };
}

type ExtensionRuntimeCapability =
    | 'providers'
    | 'backends'
    | 'actions'
    | 'tools'
    | 'commands'
    | 'hooks'
    | 'resources'
    | 'uiDescriptors'
    | 'lifecycle'
    | 'reload';

function inferRuntimeCapabilitiesFromContributions(
    contributions: readonly LocalExtensionContribution[],
): readonly ExtensionRuntimeCapability[] {
    const capabilities = new Set<ExtensionRuntimeCapability>();

    for (const contribution of contributions) {
        const kind = contribution.kind;
        if (kind === 'provider') {
            capabilities.add('providers');
        } else if (kind === 'backend') {
            capabilities.add('backends');
        } else if (kind === 'action') {
            capabilities.add('actions');
        } else if (kind === 'tool') {
            capabilities.add('tools');
        } else if (kind === 'command') {
            capabilities.add('commands');
        } else if (kind === 'hook') {
            capabilities.add('hooks');
        } else if (kind === 'resource') {
            capabilities.add('resources');
        } else if (kind === 'uiDescriptor') {
            capabilities.add('uiDescriptors');
        } else if (kind === 'lifecycleHandler') {
            capabilities.add('lifecycle');
        }
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

function normalizeUiDescriptorFieldType(typeOrKind: unknown): string {
    if (typeOrKind === 'enum') return 'select';
    if (typeOrKind === 'markdown') return 'markdown';
    if (typeOrKind === 'select') return 'select';
    if (typeOrKind === 'text') return 'text';
    if (typeOrKind === 'boolean') return 'boolean';
    if (typeOrKind === 'secret') return 'secret';
    if (typeOrKind === 'number') return 'number';
    if (typeOrKind === 'action') return 'action';
    return 'text';
}

function normalizeUiDescriptorContributionV1ish(value: LocalExtensionContribution): LocalExtensionContribution {
    const id = typeof value.id === 'string' ? value.id : null;
    const surface = typeof value.surface === 'string' ? value.surface : null;
    const title = typeof value.title === 'string' ? value.title : null;
    if (!id || !surface || !title) {
        throw new Error('Invalid legacy uiDescriptor contribution; expected id, surface, and title');
    }

    const fieldsRaw = Array.isArray(value.fields) ? value.fields : [];
    const fields = fieldsRaw.map((field) => {
        const fieldObj = field as Record<string, unknown>;
        return {
            id: typeof fieldObj.id === 'string' ? fieldObj.id : 'unknown',
            type: normalizeUiDescriptorFieldType(fieldObj.type ?? fieldObj.kind),
            title: typeof fieldObj.title === 'string' ? fieldObj.title : 'Field',
            description: typeof fieldObj.description === 'string' ? fieldObj.description : undefined,
            options: Array.isArray(fieldObj.options) ? fieldObj.options : [],
        };
    });

    // Legacy fixtures sometimes used more specific surfaces; clamp to the canonical V2 surface set.
    const normalizedSurface =
        surface === 'settings' ||
        surface === 'setup' ||
        surface === 'status' ||
        surface === 'providerSettings' ||
        surface === 'backendSettings'
            ? surface
            : 'settings';

    return {
        kind: 'uiDescriptor',
        id,
        surface: normalizedSurface,
        title,
        description: typeof value.description === 'string' ? value.description : undefined,
        fields,
    };
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
    if (surfacesRaw.session_agent === true) surfaces.push('agentTool');
    if (surfaces.length === 0) surfaces.push('cli');

    return {
        kind: 'action',
        id: actionId,
        title,
        description,
        scopes: ['global'],
        surfaces,
        placement,
        inputSchema,
        handler: {
            target: 'daemon',
            exportName,
        },
        dangerLevel: 'safe',
    };
}

function normalizeContributionsToV2Array(
    contributions: LocalExtensionPackageManifest['contributions'],
): readonly LocalExtensionContribution[] {
    if (Array.isArray(contributions)) {
        return contributions.map((contribution) => {
            const obj = contribution as LocalExtensionContribution;
            if (typeof obj.kind === 'string' && obj.kind.length > 0) return obj;

            // Best-effort inference for older array-based shapes.
            if (typeof obj.providerId === 'string' && typeof obj.runtimeKind === 'string') {
                return { kind: 'backend', ...obj };
            }
            if (Array.isArray(obj.ownedBackendIds) || typeof obj.providerAgentId === 'string') {
                return { kind: 'provider', ...obj };
            }
            if (typeof obj.hookApiVersion === 'number' || typeof obj.executionKind === 'string') {
                return { kind: 'hook', ...obj };
            }
            if (typeof obj.surface === 'string' && Array.isArray(obj.fields)) {
                return normalizeUiDescriptorContributionV1ish(obj);
            }
            if (typeof obj.path === 'string' && (typeof obj.type === 'string' || typeof obj.resourceKind === 'string')) {
                return normalizeResourceContributionV1ish(obj);
            }

            throw new Error('Unsupported legacy contribution array item; expected a V2 contribution with kind');
        });
    }

    const normalized: LocalExtensionContribution[] = [];
    const legacy = contributions as Record<string, unknown>;
    const providers = Array.isArray(legacy.providers) ? (legacy.providers as LocalExtensionContribution[]) : [];
    const backends = Array.isArray(legacy.backends) ? (legacy.backends as LocalExtensionContribution[]) : [];
    const actions = Array.isArray(legacy.actions) ? (legacy.actions as LocalExtensionContribution[]) : [];
    const hooks = Array.isArray(legacy.hooks) ? (legacy.hooks as LocalExtensionContribution[]) : [];
    const resources = Array.isArray(legacy.resources) ? (legacy.resources as LocalExtensionContribution[]) : [];
    const uiDescriptors = Array.isArray(legacy.uiDescriptors) ? (legacy.uiDescriptors as LocalExtensionContribution[]) : [];

    normalized.push(...providers.map((provider) => ({ kind: 'provider', ...provider })));
    normalized.push(...backends.map((backend) => ({ kind: 'backend', ...backend })));
    normalized.push(...actions.map((action) => normalizeLegacyActionContributionV1ish(action)));
    normalized.push(...hooks.map((hook) => ({ kind: 'hook', ...hook })));
    normalized.push(...resources.map((resource) => normalizeResourceContributionV1ish(resource)));
    normalized.push(...uiDescriptors.map((descriptor) => normalizeUiDescriptorContributionV1ish(descriptor)));

    return normalized;
}

function normalizeManifestForWrite(manifest: LocalExtensionPackageManifest): Record<string, unknown> {
    const contributions = normalizeContributionsToV2Array(manifest.contributions);
    const runtime = typeof manifest.runtime === 'object' && manifest.runtime !== null
        ? (manifest.runtime as Record<string, unknown>)
        : null;
    const runtimeCapabilities =
        runtime && Array.isArray(runtime.capabilities) && runtime.capabilities.length > 0
            ? runtime.capabilities
            : null;
    const capabilities = runtimeCapabilities ?? inferRuntimeCapabilitiesFromContributions(contributions);

    const normalized: Record<string, unknown> = {
        schemaVersion: 2,
        id: manifest.id,
        version: manifest.version,
        displayName: manifest.displayName,
        description: manifest.description,
        engines: manifest.engines,
        runtime: {
            apiVersion: 1,
            capabilities,
        },
        targets: manifest.targets,
        permissions: Array.isArray(manifest.permissions) ? manifest.permissions : [],
        contributions,
    };

    // Preserve known V2 fields when provided, but avoid writing unknown top-level keys since the V2 schema is strict.
    if (typeof manifest.source === 'object' && manifest.source !== null) normalized.source = manifest.source;
    if (typeof manifest.marketplace === 'object' && manifest.marketplace !== null) normalized.marketplace = manifest.marketplace;

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
    const stateDir = join(params.happyHomeDir, 'extensions', 'plugins', 'state');
    const installedDir = join(params.happyHomeDir, 'extensions', 'plugins', 'installed');
    const cacheDir = join(params.happyHomeDir, 'extensions', 'plugins', 'cache');
    const logsDir = join(params.happyHomeDir, 'extensions', 'plugins', 'logs');
    const locksDir = join(params.happyHomeDir, 'extensions', 'plugins', 'locks');

    await Promise.all([
        mkdir(stateDir, { recursive: true }),
        mkdir(installedDir, { recursive: true }),
        mkdir(cacheDir, { recursive: true }),
        mkdir(logsDir, { recursive: true }),
        mkdir(locksDir, { recursive: true }),
    ]);

    await writeFile(
        join(stateDir, 'plugin-state.v1.json'),
        JSON.stringify(
            {
                t: 'happier_plugin_state_v1',
                schemaVersion: 1,
                plugins: {
                    [params.pluginId]: {
                        source: {
                            kind: 'path',
                            locator: params.pluginRoot,
                            trustPolicy: 'local_trusted',
                            installPolicy: 'link',
                            resolvedPath: params.pluginRoot,
                            manifestPath: join(params.pluginRoot, '.happier-plugin', 'plugin.json'),
                        },
                        compatibility: {
                            status: 'unknown',
                            diagnostics: [],
                        },
                        install: {
                            mode: 'link',
                            manifestVersion: params.manifestVersion ?? '1.0.0',
                            manifestDigest: null,
                            installedPath: null,
                        },
                        state: {
                            enabled: true,
                        },
                    },
                },
            },
            null,
            2,
        ),
        'utf8',
    );
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
        surfaces: ['cli', 'agentTool'],
        placement: 'commandPalette',
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
        contributions: {
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
        runtime: {
            apiVersion: 1,
            capabilities: ['actions'],
        },
        permissions: [
            {
                capability: 'actions.register',
                reason: 'Register activation-time action for daemon execution validation.',
            },
        ],
        targets: {
            daemon: {
                entry: './daemon.mjs',
            },
        },
        contributions: [],
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
            '    title: "Fixture Activated Action",',
            '    description: "Executes through the runtime activation registry",',
            '    surface: "cli",',
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

export async function writeDescriptorProjectionPluginFixture(params: Readonly<{
    pluginRoot: string;
    pluginId: string;
    descriptorId: string;
    resourceId: string;
}>): Promise<LocalExtensionPackageFixture> {
    const manifest = createLocalExtensionPackageManifest({
        pluginId: params.pluginId,
        displayName: 'Descriptor Projection Fixture',
        description: 'Contributes host-rendered descriptors and resources for projection validation',
        contributions: {
            resources: [
                {
                    kindVersion: 1,
                    id: params.resourceId,
                    type: 'prompt',
                    title: 'Fixture Prompt',
                    path: './resources/fixture-prompt.md',
                },
            ],
            uiDescriptors: [
                {
                    kindVersion: 1,
                    id: params.descriptorId,
                    surface: 'settings.plugin.details',
                    title: 'Fixture Settings',
                    fields: [
                        {
                            kind: 'text',
                            id: 'fixture.message',
                            title: 'Fixture Message',
                        },
                    ],
                },
            ],
        },
    });
    await writeLocalExtensionPackageFixture({
        pluginRoot: params.pluginRoot,
        manifest,
        daemonModuleContents: 'export async function activate() {}\n',
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
    settingsDescriptorId?: string;
    setupDescriptorId?: string;
    statusDescriptorId?: string;
    providerSettingsDescriptorId?: string;
    backendSettingsDescriptorId?: string;
}>): Promise<LocalExtensionPackageFixture> {
    const actionId = params.actionId ?? `${params.pluginId}-refresh`;
    const resourceId = params.resourceId ?? `${params.pluginId}-prompt`;
    const settingsDescriptorId = params.settingsDescriptorId ?? `${params.pluginId}-settings-panel`;
    const setupDescriptorId = params.setupDescriptorId ?? `${params.pluginId}-setup-panel`;
    const statusDescriptorId = params.statusDescriptorId ?? `${params.pluginId}-status-panel`;
    const providerSettingsDescriptorId = params.providerSettingsDescriptorId ?? `${params.pluginId}-provider-settings-panel`;
    const backendSettingsDescriptorId = params.backendSettingsDescriptorId ?? `${params.pluginId}-backend-settings-panel`;
    const manifest: LocalExtensionPackageManifest = {
        schemaVersion: 2,
        id: params.pluginId,
        version: '1.0.0',
        displayName: 'Runtime Projection Fixture',
        description: 'Registers runtime actions, resources, and UI descriptors for projection validation',
        engines: {
            happier: '^0.2.0',
        },
        runtime: {
            apiVersion: 1,
            capabilities: ['actions', 'resources', 'uiDescriptors'],
        },
        permissions: [
            {
                capability: 'actions.register',
                reason: 'Expose a fixture action in runtime projection tests.',
            },
        ],
        targets: {
            daemon: {
                entry: './daemon.mjs',
            },
        },
        contributions: {
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
            uiDescriptors: [
                {
                    id: settingsDescriptorId,
                    surface: 'settings',
                    title: 'Plugin Settings',
                    description: 'Host-rendered settings descriptor',
                    fields: [
                        {
                            id: 'enabled',
                            type: 'boolean',
                            title: 'Enabled',
                        },
                        {
                            id: 'mode',
                            type: 'select',
                            title: 'Mode',
                            options: [
                                { value: 'safe', label: 'Safe' },
                            ],
                        },
                        {
                            id: 'providerSecret',
                            type: 'secret',
                            title: 'Provider secret',
                        },
                        {
                            id: 'connect',
                            type: 'action',
                            title: 'Connect account',
                        },
                    ],
                },
                {
                    id: setupDescriptorId,
                    surface: 'setup',
                    title: 'Plugin Setup',
                    description: 'Host-rendered setup descriptor',
                    fields: [
                        {
                            id: 'connect',
                            type: 'action',
                            title: 'Connect account',
                        },
                    ],
                },
                {
                    id: statusDescriptorId,
                    surface: 'status',
                    title: 'Runtime Status',
                    description: 'Host-rendered status descriptor',
                    fields: [
                        {
                            id: 'generation',
                            type: 'text',
                            title: 'Registry generation',
                        },
                    ],
                },
                {
                    id: providerSettingsDescriptorId,
                    surface: 'agentSettings',
                    title: 'Provider Settings',
                    description: 'Host-rendered provider settings descriptor',
                    fields: [
                        {
                            id: 'providerSecret',
                            type: 'secret',
                            title: 'Provider secret',
                        },
                    ],
                },
                {
                    id: backendSettingsDescriptorId,
                    surface: 'backendSettings',
                    title: 'Backend Settings',
                    description: 'Host-rendered backend settings descriptor',
                    fields: [
                        {
                            id: 'maxParallel',
                            type: 'number',
                            title: 'Max parallel',
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
            '        title: "Fixture Refresh",',
            '        description: "Runtime action visible in plugin details",',
            '        surface: "cli",',
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
        runtime: {
            apiVersion: 1,
            capabilities: ['actions'],
        },
        permissions: [
            {
                capability: 'actions.register',
                reason: 'Register an activation-time action for reload validation.',
            },
        ],
        targets: {
            daemon: {
                entry: './daemon.mjs',
            },
        },
        contributions: [],
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
            `    title: ${JSON.stringify(`Reload Fixture ${params.generation}`)},`,
            '    surface: "cli",',
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
        runtime: {
            apiVersion: 1,
            capabilities: ['actions'],
        },
        permissions: [
            {
                capability: 'actions.register',
                reason: 'Keep the fixture on the same activation contract after a broken edit.',
            },
        ],
        targets: {
            daemon: {
                entry: './daemon.mjs',
            },
        },
        contributions: [],
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
