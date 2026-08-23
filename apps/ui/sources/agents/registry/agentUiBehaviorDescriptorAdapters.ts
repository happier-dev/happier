import type { ExternalSessionsSource, RuntimeDescriptorV1 } from '@happier-dev/protocol';
import {
    isSupportedRuntimeDescriptorProviderId,
    readSessionMetadataRuntimeDescriptor,
} from '@happier-dev/agents';

import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { parseConnectedServicesBindingsByServiceIdFromAgentOptionState } from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';
import { t, tLoose } from '@/text';

import type {
    AgentSessionHandoffProviderPatch,
    AgentTranscriptStorageMode,
    AgentUiBehavior,
} from './registryUiBehavior';
import {
    createUiProjectionDiagnostic,
    isRecord,
    readString,
    readStringArray,
    type UiProjectionDiagnostic,
} from './uiDescriptorDiagnostics';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

type RuntimeDescriptorAgentExtraDescriptor = Readonly<{
    owner: string;
    schemaId: string;
    v: number;
    runtimeHandleFields: readonly string[];
}>;

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
        originOnly?: boolean;
    }>;
    agentExtra?: RuntimeDescriptorAgentExtraDescriptor;
}>;

type BackendTransportDescriptor = Readonly<{
    providerId: string;
    runtimeDescriptorOutputKey: string;
    legacyModeOutputKey?: string;
    backendMode: Readonly<{
        values: readonly string[];
        aliases?: Readonly<Record<string, string>>;
        legacyExperimentalValue?: string;
    }>;
    runtimeHandleFields: readonly string[];
    agentExtra?: RuntimeDescriptorAgentExtraDescriptor;
}>;

type SourceOptionDescriptor = Readonly<{
    key: string;
    labelKey: string;
    labelParams?: Readonly<Record<string, string>>;
    detail?: string;
    source: ExternalSessionsSource;
}>;

type ConnectedServiceProfileSourceDescriptor = Readonly<{
    serviceId: string;
    keyPrefix: string;
    labelKey: string;
    labelParams?: Readonly<Record<string, string>>;
    detailSettingsKey?: string;
    source: Readonly<Record<string, unknown>>;
    serviceIdField: string;
    profileIdField: string;
}>;

type CompatibleSourceDescriptor = Readonly<{
    sourceKind: string;
    optionalFields: readonly string[];
}>;

type LockedConnectedServiceSourceDescriptor = Readonly<{
    serviceId: string;
    keyPrefix: string;
    source: Readonly<Record<string, unknown>>;
    serviceIdField: string;
    profileIdField: string;
    groupIdField: string;
}>;

type SourceFromCandidateLinkExtrasDescriptor = Readonly<{
    sourceKind: string;
    optionalFields: readonly string[];
}>;

type RuntimeDescriptorLinkExtrasDescriptor = Readonly<{
    providerId: string;
    runtimeDescriptorOutputKey: string;
    legacyModeOutputKey?: string;
    backendMode: Readonly<{
        values: readonly string[];
    }>;
    sourceFields: readonly string[];
    agentExtra?: RuntimeDescriptorAgentExtraDescriptor;
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
        const normalized = config.originOnly === false ? parsed.toString() : parsed.origin;
        return normalized.endsWith('/') ? normalized : `${normalized}/`;
    } catch {
        return null;
    }
}

function readRuntimeDescriptorProvider(metadata: unknown, providerId: string): Record<string, unknown> | null {
    const record = isRecord(metadata) ? metadata : null;
    const runtimeDescriptor = isRecord(record?.runtimeDescriptorV1)
        ? record.runtimeDescriptorV1
        : isRecord(record?.agentRuntimeDescriptorV1)
            ? record.agentRuntimeDescriptorV1
            : null;
    if (!runtimeDescriptor || runtimeDescriptor.v !== 1 || runtimeDescriptor.agentId !== providerId) return null;
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

function readStringRecord(value: unknown): Readonly<Record<string, string>> | undefined {
    if (!isRecord(value)) return undefined;
    const entries = Object.entries(value).flatMap(([key, entry]) => {
        const normalizedKey = readString(key);
        const normalizedValue = readString(entry);
        return normalizedKey && normalizedValue ? [[normalizedKey, normalizedValue] as const] : [];
    });
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function translateDescriptorLabel(labelKey: string, labelParams?: Readonly<Record<string, string>>): string {
    if (!labelParams) return tLoose(labelKey);
    const translated = (t as unknown as (key: string, params: Readonly<Record<string, string>>) => unknown)(
        labelKey,
        labelParams,
    );
    if (typeof translated === 'string') return translated;
    return tLoose(labelKey);
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
    session?: Readonly<{
        metadata?: Record<string, unknown> | null;
        metadataLayoutVersion?: number;
        ownerMetadataView?: unknown;
    }> | null;
    environmentVariables?: Record<string, string> | undefined;
    newSessionOptions?: Record<string, unknown> | null;
    allowLegacySettingsServerBaseUrl?: boolean;
    allowActiveServerFallback?: boolean;
}>): Record<string, string> {
    const base = { ...(opts.environmentVariables ?? {}) };
    const ownerMetadata = opts.session
        ? readSessionOwnerMetadataView({
            metadataLayoutVersion: opts.session.metadataLayoutVersion,
            metadata: opts.session.metadata,
            ownerMetadataView: opts.session.ownerMetadataView,
        })
        : null;
    const affinity = readEnvironmentAffinity(ownerMetadata, opts.descriptor);
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

    const agentExtraConfig = isRecord(value.agentExtra) ? value.agentExtra : null;
    const agentExtraOwner = readString(agentExtraConfig?.owner);
    const agentExtraSchemaId = readString(agentExtraConfig?.schemaId);
    const agentExtraVersion = typeof agentExtraConfig?.v === 'number' && Number.isInteger(agentExtraConfig.v) && agentExtraConfig.v > 0
        ? agentExtraConfig.v
        : null;
    const runtimeHandleFields = readStringArray(agentExtraConfig?.runtimeHandleFields);

    return {
        providerId,
        backendMode: backendModeConfig as EnvironmentDescriptor['backendMode'],
        ...(serverBaseUrlConfig && hasValidServerBaseUrlConfig
            ? { serverBaseUrl: serverBaseUrlConfig }
            : {}),
        ...(agentExtraOwner && agentExtraSchemaId && agentExtraVersion && runtimeHandleFields.length > 0
            ? {
                agentExtra: {
                    owner: agentExtraOwner,
                    schemaId: agentExtraSchemaId,
                    v: agentExtraVersion,
                    runtimeHandleFields,
                },
            }
            : {}),
    };
}

function readSourceOptionDescriptors(value: unknown): readonly SourceOptionDescriptor[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry): SourceOptionDescriptor[] => {
        if (!isRecord(entry) || !isRecord(entry.source)) return [];
        const key = readString(entry.key);
        const labelKey = readString(entry.labelKey);
        const labelParams = readStringRecord(entry.labelParams);
        const detail = readString(entry.detail);
        const sourceKind = readString(entry.source.kind);
        if (!key || !labelKey || !sourceKind) return [];
        return [{
            key,
            labelKey,
            ...(labelParams ? { labelParams } : {}),
            ...(detail ? { detail } : {}),
            source: entry.source as ExternalSessionsSource,
        }];
    });
}

function readConnectedServiceProfileSourceDescriptors(value: unknown): readonly ConnectedServiceProfileSourceDescriptor[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry): ConnectedServiceProfileSourceDescriptor[] => {
        if (!isRecord(entry) || !isRecord(entry.source)) return [];
        const serviceId = readString(entry.serviceId);
        const keyPrefix = readString(entry.keyPrefix);
        const labelKey = readString(entry.labelKey);
        const labelParams = readStringRecord(entry.labelParams);
        const detailSettingsKey = readString(entry.detailSettingsKey);
        const serviceIdField = readString(entry.serviceIdField);
        const profileIdField = readString(entry.profileIdField);
        const sourceKind = readString(entry.source.kind);
        if (!serviceId || !keyPrefix || !labelKey || !serviceIdField || !profileIdField || !sourceKind) return [];
        return [{
            serviceId,
            keyPrefix,
            labelKey,
            ...(labelParams ? { labelParams } : {}),
            ...(detailSettingsKey ? { detailSettingsKey } : {}),
            source: entry.source,
            serviceIdField,
            profileIdField,
        }];
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

function readLockedConnectedServiceSourceDescriptor(value: unknown): LockedConnectedServiceSourceDescriptor | null {
    if (!isRecord(value) || !isRecord(value.source)) return null;
    const serviceId = readString(value.serviceId);
    const keyPrefix = readString(value.keyPrefix);
    const serviceIdField = readString(value.serviceIdField);
    const profileIdField = readString(value.profileIdField);
    const groupIdField = readString(value.groupIdField);
    const sourceKind = readString(value.source.kind);
    if (!serviceId || !keyPrefix || !serviceIdField || !profileIdField || !groupIdField || !sourceKind) return null;
    return {
        serviceId,
        keyPrefix,
        source: value.source,
        serviceIdField,
        profileIdField,
        groupIdField,
    };
}

function resolveLockedConnectedServiceSourceOption(params: Readonly<{
    descriptor: LockedConnectedServiceSourceDescriptor;
    sourceOptions: readonly SourceOptionDescriptor[];
    agentOptionState: Record<string, unknown> | null | undefined;
}>): SourceOptionDescriptor | null {
    const binding = parseConnectedServicesBindingsByServiceIdFromAgentOptionState({
        agentOptionState: params.agentOptionState,
    })[params.descriptor.serviceId];
    const matchesConnectedSource = (option: SourceOptionDescriptor): boolean => (
        option.source.kind === params.descriptor.source.kind
        && (option.source as Record<string, unknown>)[params.descriptor.serviceIdField] === params.descriptor.serviceId
    );

    const groupId = binding?.source === 'connected' && binding.selection === 'group'
        ? binding.groupId
        : null;
    if (groupId) {
        const exact = params.sourceOptions.find((option) => (
            matchesConnectedSource(option)
            && (option.source as Record<string, unknown>)[params.descriptor.groupIdField] === groupId
        ));
        if (exact) return exact;
        const presentation = params.sourceOptions.find((option) => (
            matchesConnectedSource(option)
            && (option.source as Record<string, unknown>)[params.descriptor.profileIdField] === binding?.profileId
        ));
        return {
            key: `${params.descriptor.keyPrefix}:${params.descriptor.serviceId}:group:${groupId}`,
            labelKey: presentation?.labelKey ?? groupId,
            ...(presentation?.labelParams ? { labelParams: presentation.labelParams } : {}),
            ...(presentation?.detail ? { detail: presentation.detail } : {}),
            source: {
                ...params.descriptor.source,
                [params.descriptor.serviceIdField]: params.descriptor.serviceId,
                [params.descriptor.groupIdField]: groupId,
            } as ExternalSessionsSource,
        };
    }

    if (binding?.source === 'connected') {
        const profile = params.sourceOptions.find((option) => (
            matchesConnectedSource(option)
            && (option.source as Record<string, unknown>)[params.descriptor.profileIdField] === binding.profileId
        ));
        if (profile) return profile;
    }

    return params.sourceOptions[0] ?? null;
}

function readSourceFromCandidateLinkExtrasDescriptor(value: unknown): SourceFromCandidateLinkExtrasDescriptor | null {
    if (!isRecord(value)) return null;
    const sourceKind = readString(value.sourceKind);
    if (!sourceKind) return null;
    return {
        sourceKind,
        optionalFields: readStringArray(value.optionalFields),
    };
}

function readRuntimeDescriptorLinkExtrasDescriptor(value: unknown): RuntimeDescriptorLinkExtrasDescriptor | null {
    if (!isRecord(value)) return null;
    const providerId = readString(value.providerId);
    const runtimeDescriptorOutputKey = readString(value.runtimeDescriptorOutputKey) ?? 'runtimeDescriptorV1';
    const legacyModeOutputKey = readString(value.legacyModeOutputKey);
    const backendMode = isRecord(value.backendMode) ? value.backendMode : null;
    const backendModeValues = readStringArray(backendMode?.values);
    const sourceFields = readStringArray(value.sourceFields);
    if (!providerId || !runtimeDescriptorOutputKey || backendModeValues.length === 0) {
        return null;
    }

    const agentExtraConfig = isRecord(value.agentExtra) ? value.agentExtra : null;
    const agentExtraOwner = readString(agentExtraConfig?.owner);
    const agentExtraSchemaId = readString(agentExtraConfig?.schemaId);
    const agentExtraVersion = typeof agentExtraConfig?.v === 'number' && Number.isInteger(agentExtraConfig.v) && agentExtraConfig.v > 0
        ? agentExtraConfig.v
        : null;
    const runtimeHandleFields = readStringArray(agentExtraConfig?.runtimeHandleFields);
    return {
        providerId,
        runtimeDescriptorOutputKey,
        ...(legacyModeOutputKey ? { legacyModeOutputKey } : {}),
        backendMode: {
            values: backendModeValues,
        },
        sourceFields,
        ...(agentExtraOwner && agentExtraSchemaId && agentExtraVersion && runtimeHandleFields.length > 0
            ? {
                agentExtra: {
                    owner: agentExtraOwner,
                    schemaId: agentExtraSchemaId,
                    v: agentExtraVersion,
                    runtimeHandleFields,
                },
            }
            : {}),
    };
}

function normalizeOptionalString(value: unknown): string | null {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return normalized.length > 0 ? normalized : null;
}

function readValueAtPath(root: unknown, path: readonly string[]): unknown {
    let current = root;
    for (const key of path) {
        if (!isRecord(current)) return undefined;
        current = current[key];
    }
    return current;
}

function normalizeDescriptorEnumValue(
    value: unknown,
    descriptor: RuntimeDescriptorLinkExtrasDescriptor['backendMode'],
): string | null {
    const raw = normalizeOptionalString(value);
    if (!raw) return null;
    return descriptor.values.includes(raw) ? raw : null;
}

function normalizeRuntimeDescriptorBackendMode(
    value: unknown,
    descriptor: RuntimeDescriptorLinkExtrasDescriptor['backendMode'],
): string | null {
    return normalizeDescriptorEnumValue(value, descriptor);
}

function buildRuntimeDescriptorAgentExtra(
    agentPayload: Readonly<Record<string, unknown>>,
    descriptor: RuntimeDescriptorAgentExtraDescriptor | undefined,
): Record<string, unknown> | null {
    if (!descriptor) return null;
    const runtimeHandle = Object.fromEntries(
        descriptor.runtimeHandleFields.flatMap((field) => (
            agentPayload[field] !== undefined ? [[field, agentPayload[field]] as const] : []
        )),
    );
    return {
        owner: descriptor.owner,
        schemaId: descriptor.schemaId,
        v: descriptor.v,
        ...(Object.keys(runtimeHandle).length > 0 ? { runtimeHandle } : {}),
    };
}

function attachRuntimeDescriptorAgentExtra(
    agentPayload: Record<string, unknown>,
    descriptor: RuntimeDescriptorAgentExtraDescriptor | undefined,
): Record<string, unknown> {
    const agentExtra = buildRuntimeDescriptorAgentExtra(agentPayload, descriptor);
    return agentExtra ? { ...agentPayload, agentExtra } : agentPayload;
}

function readCandidateDetailsSource(candidate: Readonly<{ details?: Record<string, unknown> }>): Record<string, unknown> | null {
    const source = candidate.details?.source;
    return isRecord(source) ? source : null;
}

function sanitizeSourceFromDescriptor(
    source: Record<string, unknown>,
    descriptor: SourceFromCandidateLinkExtrasDescriptor,
): ExternalSessionsSource | null {
    if (source.kind !== descriptor.sourceKind) return null;
    const out: Record<string, unknown> = { kind: descriptor.sourceKind };
    for (const field of descriptor.optionalFields) {
        const value = normalizeOptionalString(source[field]);
        if (value != null) {
            out[field] = value;
        }
    }
    return out as ExternalSessionsSource;
}

function sourceToRecord(source: ExternalSessionsSource): Record<string, unknown> {
    return source as unknown as Record<string, unknown>;
}

function selectedSourceMatchesCandidateDescriptor(opts: Readonly<{
    selectedSource: ExternalSessionsSource;
    candidateSource: Record<string, unknown>;
    descriptor: SourceFromCandidateLinkExtrasDescriptor;
}>): boolean {
    if (opts.selectedSource.kind !== opts.descriptor.sourceKind) return false;
    if (opts.candidateSource.kind !== opts.descriptor.sourceKind) return false;
    const selected = opts.selectedSource as Record<string, unknown>;
    for (const field of opts.descriptor.optionalFields) {
        const selectedValue = normalizeOptionalString(selected[field]);
        if (selectedValue != null && selectedValue !== normalizeOptionalString(opts.candidateSource[field])) {
            return false;
        }
    }
    return true;
}

function resolveSourceFromCandidateDescriptor(opts: Readonly<{
    selectedSource: ExternalSessionsSource;
    candidate: Readonly<{ details?: Record<string, unknown> }>;
    descriptor: SourceFromCandidateLinkExtrasDescriptor;
}>): ExternalSessionsSource | null {
    const candidateSource = readCandidateDetailsSource(opts.candidate);
    if (!candidateSource || !selectedSourceMatchesCandidateDescriptor({
        selectedSource: opts.selectedSource,
        candidateSource,
        descriptor: opts.descriptor,
    })) {
        return null;
    }
    return sanitizeSourceFromDescriptor(candidateSource, opts.descriptor);
}

function sanitizeSelectedSourceForDescriptor(
    source: ExternalSessionsSource,
    descriptor: SourceFromCandidateLinkExtrasDescriptor,
): ExternalSessionsSource | null {
    if (source.kind !== descriptor.sourceKind) return null;
    return sanitizeSourceFromDescriptor(sourceToRecord(source), descriptor);
}

function buildRuntimeDescriptorLinkExtras(opts: Readonly<{
    candidate: Readonly<{ details?: Record<string, unknown> }>;
    descriptor: RuntimeDescriptorLinkExtrasDescriptor;
    source: ExternalSessionsSource | null;
}>): Record<string, unknown> {
    const details = opts.candidate.details ?? {};
    if (!isSupportedRuntimeDescriptorProviderId(opts.descriptor.providerId)) return {};
    const projectedDescriptor = readSessionMetadataRuntimeDescriptor(details, opts.descriptor.providerId);
    const backendMode = normalizeDescriptorEnumValue(
        projectedDescriptor?.runtimeKind,
        opts.descriptor.backendMode,
    );
    if (!backendMode) return {};

    const providerSessionId = projectedDescriptor?.providerSessionId ?? null;
    const provider: Record<string, unknown> = {
        backendMode,
        ...(providerSessionId ? { providerSessionId } : {}),
    };
    const sourceRecord = opts.source ? sourceToRecord(opts.source) : null;
    if (sourceRecord) {
        for (const field of opts.descriptor.sourceFields) {
            const value = normalizeOptionalString(sourceRecord[field]);
            if (value) provider[field] = value;
        }
    }

    const runtimeDescriptor = {
        v: 1,
        agentId: opts.descriptor.providerId,
        agent: attachRuntimeDescriptorAgentExtra(provider, opts.descriptor.agentExtra),
    } satisfies RuntimeDescriptorV1;

    return {
        ...(opts.descriptor.legacyModeOutputKey ? { [opts.descriptor.legacyModeOutputKey]: backendMode } : {}),
        [opts.descriptor.runtimeDescriptorOutputKey]: runtimeDescriptor,
    };
}

function readRuntimeDescriptorLinkDescriptorFromUiDescriptor(
    descriptor: Readonly<Record<string, unknown>>,
): RuntimeDescriptorLinkExtrasDescriptor | null {
    const externalSessions = isRecord(descriptor.externalSessions) ? descriptor.externalSessions : null;
    const browse = isRecord(externalSessions?.browse) ? externalSessions.browse : null;
    const linkEnsureRequestExtras = isRecord(browse?.linkEnsureRequestExtras) ? browse.linkEnsureRequestExtras : null;
    return readRuntimeDescriptorLinkExtrasDescriptor(linkEnsureRequestExtras?.runtimeDescriptorFromCandidate);
}

function readProjectedRuntimeDescriptorInput(
    runtimeDescriptor: unknown,
    providerId: string,
): Record<string, unknown> | null {
    if (!isSupportedRuntimeDescriptorProviderId(providerId)) return null;
    return readSessionMetadataRuntimeDescriptor({ runtimeDescriptorV1: runtimeDescriptor }, providerId);
}

function normalizeHandoffUrl(value: unknown): string | null {
    const raw = normalizeOptionalString(value);
    if (!raw) return null;
    try {
        const parsed = new URL(raw);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
        if (parsed.username || parsed.password) return null;
        return parsed.origin;
    } catch {
        return null;
    }
}

function buildHandoffRuntimeDescriptorFromLinkDescriptor(opts: Readonly<{
    ctx: Parameters<NonNullable<NonNullable<AgentUiBehavior['sessionHandoff']>['buildProviderPatch']>>[0];
    descriptor: RuntimeDescriptorLinkExtrasDescriptor;
}>): AgentSessionHandoffProviderPatch | null {
    if (opts.ctx.agentId !== opts.descriptor.providerId) return null;

    const importedProvider = readProjectedRuntimeDescriptorInput(
        opts.ctx.targetRuntimeDescriptor,
        opts.descriptor.providerId,
    );
    const backendMode = importedProvider
        ? normalizeRuntimeDescriptorBackendMode(importedProvider.runtimeKind, opts.descriptor.backendMode)
        : isSupportedRuntimeDescriptorProviderId(opts.descriptor.providerId)
            ? normalizeRuntimeDescriptorBackendMode(
                readSessionMetadataRuntimeDescriptor(opts.ctx.metadata, opts.descriptor.providerId)?.runtimeKind,
                opts.descriptor.backendMode,
            )
            : null;
    if (!backendMode) return null;

    const provider: Record<string, unknown> = {
        backendMode,
        providerSessionId: opts.ctx.targetRemoteSessionId,
    };
    const sourceRecord = isRecord(opts.ctx.targetDirectSource) ? opts.ctx.targetDirectSource : null;
    if (sourceRecord) {
        for (const field of opts.descriptor.sourceFields) {
            const value = normalizeOptionalString(sourceRecord[field]);
            if (value) provider[field] = value;
        }
    }
    if (importedProvider) {
        for (const key of opts.descriptor.sourceFields) {
            const value = importedProvider[key];
            if (value !== undefined && value !== null) provider[key] = value;
        }
    }

    const runtimeDescriptor: RuntimeDescriptorV1 = {
        v: 1,
        agentId: opts.descriptor.providerId,
        agent: attachRuntimeDescriptorAgentExtra(provider, opts.descriptor.agentExtra),
    };

    return {
        metadataPatch: {
            ...(opts.descriptor.legacyModeOutputKey ? { [opts.descriptor.legacyModeOutputKey]: backendMode } : {}),
        },
        runtimeDescriptor,
        externalSessionRuntimeDescriptor: runtimeDescriptor,
    };
}

function buildHandoffRuntimeDescriptorFromEnvironment(opts: Readonly<{
    ctx: Parameters<NonNullable<NonNullable<AgentUiBehavior['sessionHandoff']>['buildProviderPatch']>>[0];
    descriptor: EnvironmentDescriptor;
}>): AgentSessionHandoffProviderPatch | null {
    if (opts.ctx.agentId !== opts.descriptor.providerId) return null;

    const importedProvider = readProjectedRuntimeDescriptorInput(
        opts.ctx.targetRuntimeDescriptor,
        opts.descriptor.providerId,
    );
    const sourceRecord = isRecord(opts.ctx.targetDirectSource) ? opts.ctx.targetDirectSource : null;
    const backendMode = normalizeOptionalEnumValue(
        importedProvider?.[opts.descriptor.backendMode.runtimeDescriptorField],
        opts.descriptor.backendMode,
    )
        ?? (opts.descriptor.serverBaseUrl && normalizeHandoffUrl(sourceRecord?.baseUrl) && opts.descriptor.backendMode.values.includes('server')
            ? 'server'
            : null)
        ?? readEnvironmentAffinity(opts.ctx.metadata, opts.descriptor).backendMode
        ?? opts.descriptor.backendMode.defaultValue;
    const metadataPatch: Record<string, unknown> = {
        [opts.descriptor.backendMode.legacyMetadataKey]: backendMode,
    };
    const provider: Record<string, unknown> = {
        backendMode,
        providerSessionId: opts.ctx.targetRemoteSessionId,
    };

    const serverBaseUrlConfig = opts.descriptor.serverBaseUrl;
    if (serverBaseUrlConfig) {
        const importedUrl = importedProvider?.[serverBaseUrlConfig.runtimeDescriptorExplicitField] === true
            ? normalizeHandoffUrl(importedProvider[serverBaseUrlConfig.runtimeDescriptorField])
            : null;
        const sourceUrl = normalizeHandoffUrl(sourceRecord?.baseUrl);
        const serverBaseUrl = importedUrl ?? sourceUrl;
        if (serverBaseUrl) {
            metadataPatch[serverBaseUrlConfig.legacyMetadataKey] = serverBaseUrl;
            metadataPatch[serverBaseUrlConfig.legacyExplicitMetadataKey] = true;
            provider[serverBaseUrlConfig.runtimeDescriptorField] = serverBaseUrl;
            provider[serverBaseUrlConfig.runtimeDescriptorExplicitField] = true;
        }
    }

    const runtimeDescriptor: RuntimeDescriptorV1 = {
        v: 1,
        agentId: opts.descriptor.providerId,
        agent: attachRuntimeDescriptorAgentExtra(provider, opts.descriptor.agentExtra),
    };

    return {
        metadataPatch,
        runtimeDescriptor,
        externalSessionRuntimeDescriptor: runtimeDescriptor,
    };
}

function mergeHandoffProviderPatches(
    patches: readonly (AgentSessionHandoffProviderPatch | null | undefined)[],
): AgentSessionHandoffProviderPatch | null {
    const clearMetadataKeys = new Set<string>();
    let metadataPatch: Record<string, unknown> | undefined;
    let runtimeDescriptor: RuntimeDescriptorV1 | null | undefined;
    let externalSessionRuntimeDescriptor: RuntimeDescriptorV1 | null | undefined;

    for (const patch of patches) {
        if (!patch) continue;
        for (const key of patch.clearMetadataKeys ?? []) clearMetadataKeys.add(key);
        if (patch.metadataPatch) {
            metadataPatch = { ...(metadataPatch ?? {}), ...patch.metadataPatch };
        }
        if ('runtimeDescriptor' in patch) runtimeDescriptor = patch.runtimeDescriptor ?? null;
        if ('externalSessionRuntimeDescriptor' in patch) {
            externalSessionRuntimeDescriptor = patch.externalSessionRuntimeDescriptor ?? null;
        }
    }

    if (
        clearMetadataKeys.size === 0
        && !metadataPatch
        && runtimeDescriptor === undefined
        && externalSessionRuntimeDescriptor === undefined
    ) {
        return null;
    }

    return {
        ...(clearMetadataKeys.size > 0 ? { clearMetadataKeys: [...clearMetadataKeys] } : {}),
        ...(metadataPatch ? { metadataPatch } : {}),
        ...(runtimeDescriptor !== undefined ? { runtimeDescriptor } : {}),
        ...(externalSessionRuntimeDescriptor !== undefined ? { externalSessionRuntimeDescriptor } : {}),
    };
}

function readProfileLabelFromSettings(opts: Readonly<{
    settings: unknown;
    settingKey?: string;
    serviceId: string;
    profileId: string;
}>): string | null {
    if (!opts.settingKey || !isRecord(opts.settings)) return null;
    const labels = opts.settings[opts.settingKey];
    if (!isRecord(labels)) return null;
    return normalizeOptionalString(labels[`${opts.serviceId}/${opts.profileId}`]);
}

function buildConnectedServiceProfileSourceOptions(opts: Readonly<{
    profile: Readonly<{ connectedServicesV2?: readonly unknown[] }> | null | undefined;
    settings: unknown;
    descriptors: readonly ConnectedServiceProfileSourceDescriptor[];
}>): readonly SourceOptionDescriptor[] {
    const services = Array.isArray(opts.profile?.connectedServicesV2) ? opts.profile.connectedServicesV2 : [];
    return opts.descriptors.flatMap((descriptor) => {
        const service = services.find((candidate) => isRecord(candidate) && candidate.serviceId === descriptor.serviceId);
        const profiles = isRecord(service) && Array.isArray(service.profiles) ? service.profiles : [];
        return profiles.flatMap((profile): SourceOptionDescriptor[] => {
            if (!isRecord(profile)) return [];
            const profileId = normalizeOptionalString(profile.profileId);
            if (!profileId) return [];
            return [{
                key: `${descriptor.keyPrefix}:${descriptor.serviceId}:${profileId}`,
                labelKey: descriptor.labelKey,
                ...(descriptor.labelParams ? { labelParams: descriptor.labelParams } : {}),
                detail: readProfileLabelFromSettings({
                    settings: opts.settings,
                    settingKey: descriptor.detailSettingsKey,
                    serviceId: descriptor.serviceId,
                    profileId,
                }) ?? profileId,
                source: {
                    ...descriptor.source,
                    [descriptor.serviceIdField]: descriptor.serviceId,
                    [descriptor.profileIdField]: profileId,
                } as ExternalSessionsSource,
            }];
        });
    });
}

function createExternalSessionsBehavior(descriptor: Readonly<Record<string, unknown>>): AgentUiBehavior['externalSessions'] | undefined {
    const externalSessions = isRecord(descriptor.externalSessions) ? descriptor.externalSessions : null;
    const browse = isRecord(externalSessions?.browse) ? externalSessions.browse : null;
    const sourceOptions = readSourceOptionDescriptors(browse?.sourceOptions);
    const connectedServiceProfileSources = readConnectedServiceProfileSourceDescriptors(browse?.connectedServiceProfileSources);
    const lockedConnectedServiceSource = readLockedConnectedServiceSourceDescriptor(browse?.lockedConnectedServiceSource);
    const compatibleSource = readCompatibleSourceDescriptor(browse?.compatibleSource);
    const linkEnsureRequestExtras = isRecord(browse?.linkEnsureRequestExtras) ? browse.linkEnsureRequestExtras : null;
    const sourceFromCandidate = readSourceFromCandidateLinkExtrasDescriptor(linkEnsureRequestExtras?.sourceFromCandidate);
    const runtimeDescriptorFromCandidate = readRuntimeDescriptorLinkExtrasDescriptor(linkEnsureRequestExtras?.runtimeDescriptorFromCandidate);
    if (
        !externalSessions
        && sourceOptions.length === 0
        && connectedServiceProfileSources.length === 0
        && !lockedConnectedServiceSource
        && !compatibleSource
        && !sourceFromCandidate
        && !runtimeDescriptorFromCandidate
    ) {
        return undefined;
    }

    return {
        ...(browse
            || sourceOptions.length > 0
            || connectedServiceProfileSources.length > 0
            || lockedConnectedServiceSource
            || compatibleSource
            || sourceFromCandidate
            || runtimeDescriptorFromCandidate
            ? {
                browse: {
                    ...(typeof browse?.order === 'number' ? { order: browse.order } : {}),
                    ...(sourceOptions.length > 0 || connectedServiceProfileSources.length > 0
                        ? {
                            getSourceOptions: ({ profile, settings }) => [
                                ...sourceOptions,
                                ...buildConnectedServiceProfileSourceOptions({
                                    profile,
                                    settings,
                                    descriptors: connectedServiceProfileSources,
                                }),
                            ].map((entry) => ({
                                key: entry.key,
                                label: translateDescriptorLabel(entry.labelKey, entry.labelParams),
                                ...(entry.detail ? { detail: entry.detail } : {}),
                                source: entry.source,
                            })),
                        }
                        : {}),
                    ...(lockedConnectedServiceSource
                        ? {
                            resolveLockedSourceOption: ({ sourceOptions: runtimeSourceOptions, agentOptionState }) => {
                                const resolved = resolveLockedConnectedServiceSourceOption({
                                    descriptor: lockedConnectedServiceSource,
                                    sourceOptions: runtimeSourceOptions.map((option) => ({
                                        key: option.key,
                                        labelKey: option.label,
                                        ...(option.detail ? { detail: option.detail } : {}),
                                        source: option.source,
                                    })),
                                    agentOptionState,
                                });
                                return resolved
                                    ? {
                                        key: resolved.key,
                                        label: resolved.labelKey,
                                        ...(resolved.detail ? { detail: resolved.detail } : {}),
                                        source: resolved.source,
                                    }
                                    : null;
                            },
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
                                const selectedGroupId = lockedConnectedServiceSource
                                    ? normalizeOptionalString((selectedSource as Record<string, unknown>)[lockedConnectedServiceSource.groupIdField])
                                    : null;
                                const candidateGroupId = lockedConnectedServiceSource
                                    ? normalizeOptionalString((candidateSource as Record<string, unknown>)[lockedConnectedServiceSource.groupIdField])
                                    : null;
                                const compareByGroup = selectedGroupId !== null || candidateGroupId !== null;
                                if (compareByGroup && (selectedGroupId === null || selectedGroupId !== candidateGroupId)) {
                                    return null;
                                }
                                for (const field of compatibleSource.optionalFields) {
                                    if (
                                        compareByGroup
                                        && lockedConnectedServiceSource
                                        && (field === lockedConnectedServiceSource.profileIdField || field === lockedConnectedServiceSource.groupIdField)
                                    ) {
                                        continue;
                                    }
                                    const selected = normalizeOptionalString((selectedSource as Record<string, unknown>)[field]);
                                    if (selected != null && selected !== normalizeOptionalString((candidateSource as Record<string, unknown>)[field])) {
                                        return null;
                                    }
                                }
                                return candidateSource;
                            },
                        }
                        : {}),
                    ...(sourceFromCandidate || runtimeDescriptorFromCandidate
                        ? {
                            buildLinkEnsureRequestExtras: ({ source, candidate }) => {
                                const candidateSource = sourceFromCandidate
                                    ? resolveSourceFromCandidateDescriptor({ selectedSource: source, candidate, descriptor: sourceFromCandidate })
                                    : null;
                                const descriptorSource = candidateSource
                                    ?? (sourceFromCandidate ? sanitizeSelectedSourceForDescriptor(source, sourceFromCandidate) : null);
                                const runtimeDescriptorExtras = runtimeDescriptorFromCandidate
                                    ? buildRuntimeDescriptorLinkExtras({
                                        candidate,
                                        descriptor: runtimeDescriptorFromCandidate,
                                        source: descriptorSource,
                                    })
                                    : {};
                                return {
                                    ...(candidateSource ? { source: candidateSource } : {}),
                                    ...runtimeDescriptorExtras,
                                };
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

function createSessionHandoffBehavior(
    descriptor: Readonly<Record<string, unknown>>,
    environmentDescriptor: EnvironmentDescriptor | null,
): AgentUiBehavior['sessionHandoff'] | undefined {
    const externalSessions = isRecord(descriptor.externalSessions) ? descriptor.externalSessions : null;
    const sessionHandoff = isRecord(externalSessions?.sessionHandoff) ? externalSessions.sessionHandoff : null;
    const runtimeDescriptorLinkDescriptor = readRuntimeDescriptorLinkDescriptorFromUiDescriptor(descriptor);
    const clearMetadataKeys = readStringArray(sessionHandoff?.clearMetadataKeys);

    if (clearMetadataKeys.length === 0 && !runtimeDescriptorLinkDescriptor && !environmentDescriptor) {
        return undefined;
    }

    return {
        buildProviderPatch: (ctx) => mergeHandoffProviderPatches([
            clearMetadataKeys.length > 0 ? { clearMetadataKeys } : null,
            runtimeDescriptorLinkDescriptor
                ? buildHandoffRuntimeDescriptorFromLinkDescriptor({
                    ctx,
                    descriptor: runtimeDescriptorLinkDescriptor,
                })
                : null,
            environmentDescriptor
                ? buildHandoffRuntimeDescriptorFromEnvironment({
                    ctx,
                    descriptor: environmentDescriptor,
                })
                : null,
        ]) ?? {},
        ...(environmentDescriptor
            ? {
                buildSourceRecoveryResumePatch: (ctx) => {
                    if (ctx.agentId !== environmentDescriptor.providerId) return {};
                    const affinity = readEnvironmentAffinity(ctx.metadata, environmentDescriptor);
                    if (!affinity.backendMode && !affinity.serverBaseUrlExplicit) return {};
                    return {
                        environmentVariables: buildEnvironmentVariables({
                            descriptor: environmentDescriptor,
                            session: { metadata: ctx.metadata },
                            allowLegacySettingsServerBaseUrl: false,
                            allowActiveServerFallback: false,
                        }),
                    };
                },
            }
            : {}),
    };
}

function readBackendTransportDescriptor(
    value: unknown,
    diagnostics: UiProjectionDiagnostic[],
): BackendTransportDescriptor | null {
    if (!isRecord(value)) return null;
    const providerId = readString(value.providerId);
    const runtimeDescriptorOutputKey = readString(value.runtimeDescriptorOutputKey) ?? 'runtimeDescriptorV1';
    const legacyModeOutputKey = readString(value.legacyModeOutputKey);
    const backendMode = isRecord(value.backendMode) ? value.backendMode : null;
    const backendModeValues = readStringArray(backendMode?.values);
    const runtimeHandleFields = readStringArray(value.runtimeHandleFields);
    if (!providerId || backendModeValues.length === 0 || runtimeHandleFields.length === 0) {
        diagnostics.push(createUiProjectionDiagnostic(
            'A16X1_MALFORMED_DESCRIPTOR',
            'payload.backendTransport',
            'Backend transport descriptors require a provider id, backend-mode values, and runtime-handle fields.',
        ));
        return null;
    }

    const aliases = readStringRecord(backendMode?.aliases);
    const legacyExperimentalValue = readString(backendMode?.legacyExperimentalValue);
    const agentExtraConfig = isRecord(value.agentExtra) ? value.agentExtra : null;
    const agentExtraOwner = readString(agentExtraConfig?.owner);
    const agentExtraSchemaId = readString(agentExtraConfig?.schemaId);
    const agentExtraVersion = typeof agentExtraConfig?.v === 'number'
        && Number.isInteger(agentExtraConfig.v)
        && agentExtraConfig.v > 0
        ? agentExtraConfig.v
        : null;
    return {
        providerId,
        runtimeDescriptorOutputKey,
        ...(legacyModeOutputKey ? { legacyModeOutputKey } : {}),
        backendMode: {
            values: backendModeValues,
            ...(aliases ? { aliases } : {}),
            ...(legacyExperimentalValue ? { legacyExperimentalValue } : {}),
        },
        runtimeHandleFields,
        ...(agentExtraOwner && agentExtraSchemaId && agentExtraVersion
            ? {
                agentExtra: {
                    owner: agentExtraOwner,
                    schemaId: agentExtraSchemaId,
                    v: agentExtraVersion,
                    runtimeHandleFields,
                },
            }
            : {}),
    };
}

function normalizeBackendTransportMode(
    value: unknown,
    descriptor: BackendTransportDescriptor,
): string | null {
    const raw = normalizeOptionalString(value);
    if (!raw) return null;
    const resolved = descriptor.backendMode.aliases?.[raw] ?? raw;
    return descriptor.backendMode.values.includes(resolved) ? resolved : null;
}

/**
 * The declared half of an Agent's spawn/resume transport. The host owns the
 * canonical `runtimeDescriptorV1` shape and reads the incoming descriptor
 * through the protocol-generated canonical reader, so an Agent only declares
 * its backend-mode vocabulary and which runtime-handle fields travel with it.
 */
function createBackendTransportPayloadBehavior(
    descriptor: BackendTransportDescriptor,
): NonNullable<AgentUiBehavior['payload']> {
    return {
        buildBackendTransportFields: ({ agentId, providerMode, legacyExperimentalMode, runtimeDescriptorV1, providerSessionId }) => {
            if (agentId !== descriptor.providerId) return {};
            if (!isSupportedRuntimeDescriptorProviderId(descriptor.providerId)) return {};

            const projected = readSessionMetadataRuntimeDescriptor(
                { runtimeDescriptorV1 },
                descriptor.providerId,
            );
            const projectedMode = normalizeBackendTransportMode(projected?.runtimeKind, descriptor);
            const resolvedMode = projectedMode
                ?? normalizeBackendTransportMode(providerMode, descriptor)
                ?? (legacyExperimentalMode === true ? descriptor.backendMode.legacyExperimentalValue ?? null : null);
            if (!resolvedMode) return {};

            const projectedRecord = projected as Readonly<Record<string, unknown>> | null;
            const agentPayload: Record<string, unknown> = projectedRecord
                ? { backendMode: projectedMode ?? resolvedMode }
                : {
                    backendMode: resolvedMode,
                    ...(normalizeOptionalString(providerSessionId)
                        ? { providerSessionId: normalizeOptionalString(providerSessionId) }
                        : {}),
                };
            if (projectedRecord) {
                for (const field of descriptor.runtimeHandleFields) {
                    if (field === 'backendMode') continue;
                    const value = normalizeOptionalString(projectedRecord[field]);
                    if (value) agentPayload[field] = value;
                }
            }

            const runtimeDescriptor = {
                v: 1,
                agentId: descriptor.providerId,
                agent: attachRuntimeDescriptorAgentExtra(agentPayload, descriptor.agentExtra),
            } satisfies RuntimeDescriptorV1;

            const fields: {
                runtimeDescriptorV1?: RuntimeDescriptorV1;
                [key: string]: unknown;
            } = {};
            const legacyMode = projectedRecord ? projectedMode : resolvedMode;
            if (descriptor.legacyModeOutputKey && legacyMode) {
                fields[descriptor.legacyModeOutputKey] = legacyMode;
            }
            fields[descriptor.runtimeDescriptorOutputKey] = runtimeDescriptor;
            return fields;
        },
    };
}

export function createDescriptorAdapterBehavior(ctx: BehaviorDescriptorContext): AgentUiBehavior {
    const payload = isRecord(ctx.descriptor.payload) ? ctx.descriptor.payload : null;
    const environmentDescriptor = readEnvironmentDescriptor(payload?.environmentVariables, ctx.diagnostics);
    const backendTransportDescriptor = payload?.backendTransport === undefined
        ? null
        : readBackendTransportDescriptor(payload.backendTransport, ctx.diagnostics);
    const externalSessions = createExternalSessionsBehavior(ctx.descriptor);
    const newSession = createNewSessionBehavior(ctx.descriptor, environmentDescriptor);
    const sessionHandoff = createSessionHandoffBehavior(ctx.descriptor, environmentDescriptor);
    const payloadBehavior: AgentUiBehavior['payload'] = {
        ...(environmentDescriptor ? createPayloadBehavior(environmentDescriptor) : {}),
        ...(backendTransportDescriptor ? createBackendTransportPayloadBehavior(backendTransportDescriptor) : {}),
    };
    return {
        ...(externalSessions ? { externalSessions } : {}),
        ...(newSession ? { newSession } : {}),
        ...(sessionHandoff ? { sessionHandoff } : {}),
        ...(Object.keys(payloadBehavior).length > 0 ? { payload: payloadBehavior } : {}),
    };
}
