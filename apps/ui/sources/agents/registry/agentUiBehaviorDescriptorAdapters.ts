import type { ExternalSessionsSource } from '@happier-dev/protocol';

import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { tLoose } from '@/text';

import type { AgentTranscriptStorageMode, AgentUiBehavior } from './registryUiBehavior';
import {
    createUiProjectionDiagnostic,
    isRecord,
    readString,
    readStringArray,
    type UiProjectionDiagnostic,
} from './uiDescriptorDiagnostics';

type EnvironmentDescriptor = Readonly<{
    providerId: string;
    backendMode: Readonly<{
        envKey: string;
        settingKey: string;
        legacyMetadataKey: string;
        runtimeDescriptorField: string;
        defaultValue: string;
        values: readonly string[];
    }>;
    serverBaseUrl?: Readonly<{
        envKey: string;
        explicitEnvKey: string;
        settingKey: string;
        byServerIdSettingKey: string;
        legacyMetadataKey: string;
        legacyExplicitMetadataKey: string;
        runtimeDescriptorField: string;
        runtimeDescriptorExplicitField: string;
        allowedProtocols?: readonly string[];
        rejectCredentials?: boolean;
        httpLoopbackOnly?: boolean;
        originOnly?: boolean;
    }>;
}>;

type SourceOptionDescriptor = Readonly<{
    key: string;
    labelKey: string;
    source: ExternalSessionsSource;
}>;

type CompatibleSourceDescriptor = Readonly<{
    sourceKind: string;
    optionalFields: readonly string[];
}>;

type BehaviorDescriptorContext = Readonly<{
    descriptor: Readonly<Record<string, unknown>>;
    diagnostics: UiProjectionDiagnostic[];
}>;

const TRANSCRIPT_STORAGE_MODES = ['persisted', 'direct'] as const satisfies readonly AgentTranscriptStorageMode[];

function normalizeEnumValue(value: unknown, config: EnvironmentDescriptor['backendMode']): string {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return config.values.includes(normalized) ? normalized : config.defaultValue;
}

function normalizeOptionalEnumValue(value: unknown, config: EnvironmentDescriptor['backendMode']): string | null {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return config.values.includes(normalized) ? normalized : null;
}

function normalizeBoolean(value: unknown): boolean {
    if (value === true) return true;
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function normalizeDescriptorUrl(value: unknown, config: NonNullable<EnvironmentDescriptor['serverBaseUrl']>): string | null {
    const raw = readString(value);
    if (!raw) return null;

    try {
        const parsed = new URL(raw);
        const allowedProtocols = config.allowedProtocols && config.allowedProtocols.length > 0
            ? config.allowedProtocols
            : ['http:', 'https:'];
        if (!allowedProtocols.includes(parsed.protocol)) return null;
        if (config.rejectCredentials === true && (parsed.username || parsed.password)) return null;
        if (config.httpLoopbackOnly === true && parsed.protocol === 'http:') {
            const hostname = parsed.hostname.trim().toLowerCase();
            const isLoopback = hostname === 'localhost'
                || hostname === '127.0.0.1'
                || hostname === '::1'
                || hostname === '[::1]';
            if (!isLoopback) return null;
        }
        const normalized = config.originOnly === false ? parsed.toString() : parsed.origin;
        return normalized.endsWith('/') ? normalized : `${normalized}/`;
    } catch {
        return null;
    }
}

function readRuntimeDescriptorProvider(metadata: unknown, providerId: string): Record<string, unknown> | null {
    const record = isRecord(metadata) ? metadata : null;
    const runtimeDescriptor = isRecord(record?.agentRuntimeDescriptorV1)
        ? record.agentRuntimeDescriptorV1
        : isRecord(record?.runtimeDescriptorV1)
            ? record.runtimeDescriptorV1
            : null;
    if (!runtimeDescriptor || runtimeDescriptor.v !== 1 || runtimeDescriptor.providerId !== providerId) return null;
    return isRecord(runtimeDescriptor.provider) ? runtimeDescriptor.provider : null;
}

function readEnvironmentAffinity(metadata: unknown, descriptor: EnvironmentDescriptor): Readonly<{
    backendMode: string | null;
    serverBaseUrl: string | null;
    serverBaseUrlExplicit: boolean;
}> {
    const provider = readRuntimeDescriptorProvider(metadata, descriptor.providerId);
    const serverBaseUrlConfig = descriptor.serverBaseUrl;
    if (provider) {
        const explicit = serverBaseUrlConfig
            ? provider[serverBaseUrlConfig.runtimeDescriptorExplicitField] === true
            : false;
        return {
            backendMode: normalizeOptionalEnumValue(provider[descriptor.backendMode.runtimeDescriptorField], descriptor.backendMode),
            serverBaseUrl: explicit && serverBaseUrlConfig
                ? normalizeDescriptorUrl(provider[serverBaseUrlConfig.runtimeDescriptorField], serverBaseUrlConfig)
                : null,
            serverBaseUrlExplicit: explicit,
        };
    }

    const record = isRecord(metadata) ? metadata : {};
    const explicit = serverBaseUrlConfig
        ? normalizeBoolean(record[serverBaseUrlConfig.legacyExplicitMetadataKey])
        : false;
    return {
        backendMode: normalizeOptionalEnumValue(record[descriptor.backendMode.legacyMetadataKey], descriptor.backendMode),
        serverBaseUrl: explicit && serverBaseUrlConfig
            ? normalizeDescriptorUrl(record[serverBaseUrlConfig.legacyMetadataKey], serverBaseUrlConfig)
            : null,
        serverBaseUrlExplicit: explicit,
    };
}

function readSetting(settings: unknown, key: string): unknown {
    return isRecord(settings) ? settings[key] : undefined;
}

function readTranscriptStorageModes(value: unknown): readonly AgentTranscriptStorageMode[] {
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is AgentTranscriptStorageMode =>
        typeof entry === 'string' && TRANSCRIPT_STORAGE_MODES.includes(entry as AgentTranscriptStorageMode));
}

function readTranscriptStorageModesByBackendMode(value: unknown): ReadonlyMap<string, readonly AgentTranscriptStorageMode[]> {
    const record = isRecord(value) ? value : null;
    if (!record) return new Map();

    const entries = Object.entries(record).flatMap(([backendMode, modes]) => {
        const normalizedBackendMode = backendMode.trim().toLowerCase();
        const normalizedModes = readTranscriptStorageModes(modes);
        return normalizedBackendMode && normalizedModes.length > 0
            ? [[normalizedBackendMode, normalizedModes] as const]
            : [];
    });
    return new Map(entries);
}

function readScopedServerBaseUrlFromSettings(opts: Readonly<{
    settings: unknown;
    targetServerId?: string | null;
    activeServerId?: string | null;
    allowActiveServerFallback?: boolean;
    config: NonNullable<EnvironmentDescriptor['serverBaseUrl']>;
}>): string | null {
    const explicitTargetServerId = readString(opts.targetServerId);
    const activeServerId = opts.allowActiveServerFallback === false ? null : readString(opts.activeServerId);
    const serverId = explicitTargetServerId ?? activeServerId;
    if (!serverId) return null;

    const byServerId = readSetting(opts.settings, opts.config.byServerIdSettingKey);
    if (!isRecord(byServerId)) return null;
    return normalizeDescriptorUrl(byServerId[serverId], opts.config);
}

function buildEnvironmentVariables(opts: Readonly<{
    descriptor: EnvironmentDescriptor;
    settings?: unknown;
    session?: Readonly<{ metadata?: Record<string, unknown> | null }> | null;
    environmentVariables?: Record<string, string> | undefined;
    newSessionOptions?: Record<string, unknown> | null;
    allowLegacySettingsServerBaseUrl?: boolean;
    allowActiveServerFallback?: boolean;
}>): Record<string, string> {
    const base = { ...(opts.environmentVariables ?? {}) };
    const affinity = readEnvironmentAffinity(opts.session?.metadata ?? null, opts.descriptor);
    const backendMode = affinity.backendMode
        ?? normalizeEnumValue(readSetting(opts.settings, opts.descriptor.backendMode.settingKey), opts.descriptor.backendMode);
    base[opts.descriptor.backendMode.envKey] = backendMode;

    const serverBaseUrlConfig = opts.descriptor.serverBaseUrl;
    if (!serverBaseUrlConfig) return base;

    const sessionServerBaseUrl = affinity.serverBaseUrlExplicit ? affinity.serverBaseUrl : null;
    const activeServerId = getActiveServerSnapshot()?.serverId ?? null;
    const targetServerId = readString(opts.newSessionOptions?.targetServerId);
    const activeServerOverride = readScopedServerBaseUrlFromSettings({
        settings: opts.settings,
        targetServerId,
        activeServerId,
        allowActiveServerFallback: opts.allowActiveServerFallback,
        config: serverBaseUrlConfig,
    });
    const legacyServerBaseUrl = opts.allowLegacySettingsServerBaseUrl === true
        ? normalizeDescriptorUrl(readSetting(opts.settings, serverBaseUrlConfig.settingKey), serverBaseUrlConfig)
        : null;
    const serverBaseUrl = sessionServerBaseUrl ?? activeServerOverride ?? legacyServerBaseUrl;
    if (serverBaseUrl) {
        base[serverBaseUrlConfig.envKey] = serverBaseUrl;
        base[serverBaseUrlConfig.explicitEnvKey] = '1';
    }
    return base;
}

function readEnvironmentDescriptor(value: unknown, diagnostics: UiProjectionDiagnostic[]): EnvironmentDescriptor | null {
    if (!isRecord(value)) return null;
    const providerId = readString(value.providerId);
    const backendMode = isRecord(value.backendMode) ? value.backendMode : null;
    const backendModeValues = readStringArray(backendMode?.values);
    const backendModeConfig = providerId && backendMode
        ? {
            envKey: readString(backendMode.envKey),
            settingKey: readString(backendMode.settingKey),
            legacyMetadataKey: readString(backendMode.legacyMetadataKey),
            runtimeDescriptorField: readString(backendMode.runtimeDescriptorField),
            defaultValue: readString(backendMode.defaultValue),
            values: backendModeValues,
        }
        : null;

    if (
        !providerId
        || !backendModeConfig?.envKey
        || !backendModeConfig.settingKey
        || !backendModeConfig.legacyMetadataKey
        || !backendModeConfig.runtimeDescriptorField
        || !backendModeConfig.defaultValue
        || backendModeConfig.values.length === 0
    ) {
        diagnostics.push(createUiProjectionDiagnostic(
            'A16X1_MALFORMED_DESCRIPTOR',
            'payload.environmentVariables',
            'Environment variable descriptors require provider id and backend mode field metadata.',
        ));
        return null;
    }

    const serverBaseUrl = isRecord(value.serverBaseUrl) ? value.serverBaseUrl : null;
    const serverBaseUrlConfig = serverBaseUrl
        ? {
            envKey: readString(serverBaseUrl.envKey) ?? '',
            explicitEnvKey: readString(serverBaseUrl.explicitEnvKey) ?? '',
            settingKey: readString(serverBaseUrl.settingKey) ?? '',
            byServerIdSettingKey: readString(serverBaseUrl.byServerIdSettingKey) ?? '',
            legacyMetadataKey: readString(serverBaseUrl.legacyMetadataKey) ?? '',
            legacyExplicitMetadataKey: readString(serverBaseUrl.legacyExplicitMetadataKey) ?? '',
            runtimeDescriptorField: readString(serverBaseUrl.runtimeDescriptorField) ?? '',
            runtimeDescriptorExplicitField: readString(serverBaseUrl.runtimeDescriptorExplicitField) ?? '',
            allowedProtocols: readStringArray(serverBaseUrl.allowedProtocols),
            rejectCredentials: serverBaseUrl.rejectCredentials === true,
            httpLoopbackOnly: serverBaseUrl.httpLoopbackOnly === true,
            originOnly: serverBaseUrl.originOnly !== false,
        }
        : null;
    const hasValidServerBaseUrlConfig = !serverBaseUrlConfig || (
        Boolean(serverBaseUrlConfig.envKey)
        && Boolean(serverBaseUrlConfig.explicitEnvKey)
        && Boolean(serverBaseUrlConfig.settingKey)
        && Boolean(serverBaseUrlConfig.byServerIdSettingKey)
        && Boolean(serverBaseUrlConfig.legacyMetadataKey)
        && Boolean(serverBaseUrlConfig.legacyExplicitMetadataKey)
        && Boolean(serverBaseUrlConfig.runtimeDescriptorField)
        && Boolean(serverBaseUrlConfig.runtimeDescriptorExplicitField)
    );
    if (!hasValidServerBaseUrlConfig) {
        diagnostics.push(createUiProjectionDiagnostic(
            'A16X1_MALFORMED_DESCRIPTOR',
            'payload.environmentVariables.serverBaseUrl',
            'Environment variable server URL descriptors require complete field metadata.',
        ));
    }

    return {
        providerId,
        backendMode: backendModeConfig as EnvironmentDescriptor['backendMode'],
        ...(serverBaseUrlConfig && hasValidServerBaseUrlConfig
            ? { serverBaseUrl: serverBaseUrlConfig }
            : {}),
    };
}

function readSourceOptionDescriptors(value: unknown): readonly SourceOptionDescriptor[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry): SourceOptionDescriptor[] => {
        if (!isRecord(entry) || !isRecord(entry.source)) return [];
        const key = readString(entry.key);
        const labelKey = readString(entry.labelKey);
        const sourceKind = readString(entry.source.kind);
        if (!key || !labelKey || !sourceKind) return [];
        return [{ key, labelKey, source: entry.source as ExternalSessionsSource }];
    });
}

function readCompatibleSourceDescriptor(value: unknown): CompatibleSourceDescriptor | null {
    if (!isRecord(value)) return null;
    const sourceKind = readString(value.sourceKind);
    if (!sourceKind) return null;
    return {
        sourceKind,
        optionalFields: readStringArray(value.optionalFields),
    };
}

function normalizeOptionalString(value: unknown): string | null {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return normalized.length > 0 ? normalized : null;
}

function createExternalSessionsBehavior(descriptor: Readonly<Record<string, unknown>>): AgentUiBehavior['externalSessions'] | undefined {
    const externalSessions = isRecord(descriptor.externalSessions) ? descriptor.externalSessions : null;
    const browse = isRecord(externalSessions?.browse) ? externalSessions.browse : null;
    const sourceOptions = readSourceOptionDescriptors(browse?.sourceOptions);
    const compatibleSource = readCompatibleSourceDescriptor(browse?.compatibleSource);
    if (!externalSessions && sourceOptions.length === 0 && !compatibleSource) return undefined;

    return {
        ...(typeof externalSessions?.supportsBackgroundFollow === 'boolean'
            ? { supportsBackgroundFollow: externalSessions.supportsBackgroundFollow }
            : {}),
        ...(browse || sourceOptions.length > 0 || compatibleSource
            ? {
                browse: {
                    ...(typeof browse?.order === 'number' ? { order: browse.order } : {}),
                    ...(sourceOptions.length > 0
                        ? {
                            getSourceOptions: () => sourceOptions.map((entry) => ({
                                key: entry.key,
                                label: tLoose(entry.labelKey),
                                source: entry.source,
                            })),
                        }
                        : {}),
                    ...(compatibleSource
                        ? {
                            resolveCompatibleLinkSource: ({ selectedSource, candidateSource }) => {
                                if (
                                    selectedSource.kind !== compatibleSource.sourceKind
                                    || candidateSource.kind !== compatibleSource.sourceKind
                                ) {
                                    return null;
                                }
                                for (const field of compatibleSource.optionalFields) {
                                    const selected = normalizeOptionalString((selectedSource as Record<string, unknown>)[field]);
                                    if (selected != null && selected !== normalizeOptionalString((candidateSource as Record<string, unknown>)[field])) {
                                        return null;
                                    }
                                }
                                return candidateSource;
                            },
                        }
                        : {}),
                },
            }
            : {}),
    };
}

function createPayloadBehavior(descriptor: EnvironmentDescriptor): NonNullable<AgentUiBehavior['payload']> {
    return {
        buildSpawnEnvironmentVariables: ({ agentId, settings, environmentVariables, newSessionOptions }) => {
            if (agentId !== descriptor.providerId) return environmentVariables;
            return buildEnvironmentVariables({
                descriptor,
                settings,
                environmentVariables,
                newSessionOptions,
                allowLegacySettingsServerBaseUrl: false,
                allowActiveServerFallback: true,
            });
        },
        buildResumeSessionExtras: ({ agentId, settings, session }) => {
            if (agentId !== descriptor.providerId) return {};
            return {
                environmentVariables: buildEnvironmentVariables({
                    descriptor,
                    settings,
                    session,
                    allowLegacySettingsServerBaseUrl: true,
                    allowActiveServerFallback: false,
                }),
            };
        },
        buildWakeResumeExtras: ({ agentId, resumeCapabilityOptions, session }) => {
            if (agentId !== descriptor.providerId) return {};
            return {
                environmentVariables: buildEnvironmentVariables({
                    descriptor,
                    settings: resumeCapabilityOptions.accountSettings ?? {},
                    session,
                    allowLegacySettingsServerBaseUrl: true,
                    allowActiveServerFallback: false,
                }),
            };
        },
    };
}

function createNewSessionBehavior(
    descriptor: Readonly<Record<string, unknown>>,
    environmentDescriptor: EnvironmentDescriptor | null,
): AgentUiBehavior['newSession'] | undefined {
    const newSession = isRecord(descriptor.newSession) ? descriptor.newSession : null;
    const transcriptStorageModesByBackendMode = readTranscriptStorageModesByBackendMode(
        newSession?.transcriptStorageModesByBackendMode,
    );

    if (!environmentDescriptor || transcriptStorageModesByBackendMode.size === 0) return undefined;

    return {
        supportsTranscriptStorageMode: ({ agentId, settings, storageMode }) => {
            if (agentId !== environmentDescriptor.providerId) return true;
            const backendMode = normalizeEnumValue(
                readSetting(settings, environmentDescriptor.backendMode.settingKey),
                environmentDescriptor.backendMode,
            );
            const allowedModes = transcriptStorageModesByBackendMode.get(backendMode);
            return allowedModes ? allowedModes.includes(storageMode) : true;
        },
    };
}

export function createDescriptorAdapterBehavior(ctx: BehaviorDescriptorContext): AgentUiBehavior {
    const payload = isRecord(ctx.descriptor.payload) ? ctx.descriptor.payload : null;
    const environmentDescriptor = readEnvironmentDescriptor(payload?.environmentVariables, ctx.diagnostics);
    const externalSessions = createExternalSessionsBehavior(ctx.descriptor);
    const newSession = createNewSessionBehavior(ctx.descriptor, environmentDescriptor);
    return {
        ...(externalSessions ? { externalSessions } : {}),
        ...(newSession ? { newSession } : {}),
        ...(environmentDescriptor ? { payload: createPayloadBehavior(environmentDescriptor) } : {}),
    };
}
