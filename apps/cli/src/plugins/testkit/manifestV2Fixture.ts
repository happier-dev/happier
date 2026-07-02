type LegacyContribution = Readonly<Record<string, unknown>>;

function normalizeRuntimeCapabilities(value: unknown): readonly string[] {
    return Array.isArray(value)
        ? value.map((entry) => entry === 'providers' ? 'agents' : entry).filter((entry): entry is string => typeof entry === 'string')
        : [];
}

function readLegacyContributionFamily(entry: LegacyContribution): string | null {
    switch (entry.kind) {
        case 'provider':
            return 'agents';
        case 'backend':
            return 'backends';
        case 'action':
            return 'actions';
        case 'tool':
            return 'tools';
        case 'command':
            return 'commands';
        case 'resource':
            return 'resources';
        case 'uiDescriptor':
            return 'uiDescriptors';
        case 'hook':
            return 'hooks';
        case 'lifecycleHandler':
            return 'lifecycleHandlers';
        default:
            return null;
    }
}

function normalizeLegacyContribution(entry: LegacyContribution): LegacyContribution {
    const output: Record<string, unknown> = { ...entry };
    delete output.kind;
    if (entry.kind === 'provider') {
        if (typeof output.providerAgentId === 'string') {
            output.catalogAgentId = output.providerAgentId;
            delete output.providerAgentId;
        }
        if (output.providerCliRuntime) {
            output.agentCliRuntime = output.providerCliRuntime;
            delete output.providerCliRuntime;
        }
    }
    if (entry.kind === 'backend') {
        if (typeof output.providerId === 'string') {
            output.agentId = output.providerId;
            delete output.providerId;
        }
        if (typeof output.providerAgentId === 'string') {
            output.catalogAgentId = output.providerAgentId;
            delete output.providerAgentId;
        }
        if (!output.engine) {
            output.engine = { kind: output.runtimeKind === 'acp' ? 'acp' : 'custom' };
        }
        delete output.runtimeKind;
        const surfaceHandlers = output.surfaceHandlers;
        if (Array.isArray(surfaceHandlers)) {
            output.surfaceHandlers = surfaceHandlers.map((hook) => {
                if (typeof hook !== 'object' || hook === null) {
                    return hook;
                }
                const normalizedHook = { ...hook } as Record<string, unknown>;
                return normalizedHook;
            });
        }
    }
    if (entry.kind === 'hook' && output.scope === 'provider') {
        output.scope = 'agent';
    }
    return output;
}

function normalizeContributes(value: unknown): Record<string, readonly unknown[]> {
    if (!Array.isArray(value)) {
        return typeof value === 'object' && value !== null
            ? { ...(value as Record<string, readonly unknown[]>) }
            : {};
    }

    const contributes: Record<string, unknown[]> = {};
    for (const entry of value) {
        if (typeof entry !== 'object' || entry === null) {
            continue;
        }
        const family = readLegacyContributionFamily(entry as LegacyContribution);
        if (!family) {
            continue;
        }
        contributes[family] ??= [];
        contributes[family].push(normalizeLegacyContribution(entry as LegacyContribution));
    }
    return contributes;
}

export function createPluginManifestV2Fixture(
    overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
    const base: Record<string, unknown> = {
        schemaVersion: 2,
        id: 'acme.test',
        version: '1.0.0',
        displayName: 'Acme Test Manifest',
        description: 'Test manifest',
        engines: {
            happier: '^0.2.0',
        },
        runtime: {
            apiVersion: 1,
            capabilities: [],
        },
        targets: {},
        capabilities: {
            permissions: [],
        },
        contributes: {},
    };
    const manifest: Record<string, unknown> = { ...base, ...overrides };
    const runtime: Record<string, unknown> = typeof manifest.runtime === 'object' && manifest.runtime !== null
        ? { ...(manifest.runtime as Record<string, unknown>) }
        : { apiVersion: 1 };
    runtime.capabilities = normalizeRuntimeCapabilities(runtime.capabilities);
    manifest.runtime = runtime;

    const legacyPermissions = manifest.permissions;
    const capabilities = typeof manifest.capabilities === 'object' && manifest.capabilities !== null
        ? { ...(manifest.capabilities as Record<string, unknown>) }
        : {};
    if (Array.isArray(legacyPermissions)) {
        capabilities.permissions = legacyPermissions;
    }
    capabilities.permissions ??= [];
    manifest.capabilities = capabilities;
    delete manifest.permissions;

    const legacyContributions = manifest[`${'contribu'}tions`];
    manifest.contributes = normalizeContributes(legacyContributions ?? manifest.contributes);
    delete manifest[`${'contribu'}tions`];

    return manifest;
}
