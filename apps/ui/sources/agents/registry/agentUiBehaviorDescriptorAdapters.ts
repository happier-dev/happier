import type {
    AgentUiSettingReferenceV1,
    ExternalSessionsSource,
} from '@happier-dev/protocol';
import { mergeSpawnConfigOptionAliases } from '@happier-dev/protocol/actions/sessionSpawnConfigOptions';
import { RuntimeDescriptorV1Schema } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor';

import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { parseConnectedServicesBindingsByServiceIdFromAgentOptionState } from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';
import { t, tLoose } from '@/text';

import type { AgentTranscriptStorageMode, AgentUiBehavior } from './registryUiBehavior';
import {
    createUiProjectionDiagnostic,
    isRecord,
    readString,
    readStringArray,
    type UiProjectionDiagnostic,
} from './uiDescriptorDiagnostics';
import type { Settings } from '@/sync/domains/settings/settings';
import { readAgentUiSetting } from './agentUiSettingLookup';

type EnvironmentDescriptor = Readonly<{
    providerId: string;
    backendMode: Readonly<{
        envKey: string;
        settingKey: AgentUiSettingReferenceV1;
        defaultValue: string;
        values: readonly string[];
    }>;
    serverBaseUrl?: Readonly<{
        envKey: string;
        explicitEnvKey: string;
        settingKey: AgentUiSettingReferenceV1;
        byServerIdSettingKey: AgentUiSettingReferenceV1;
        allowedProtocols?: readonly string[];
        rejectCredentials?: boolean;
        originOnly?: boolean;
    }>;
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
    detailSettingsKey?: AgentUiSettingReferenceV1;
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

type BehaviorDescriptorContext = Readonly<{
    agentId: string;
    descriptor: Readonly<Record<string, unknown>>;
    diagnostics: UiProjectionDiagnostic[];
}>;

const TRANSCRIPT_STORAGE_MODES = ['persisted', 'direct'] as const satisfies readonly AgentTranscriptStorageMode[];

function normalizeEnumValue(value: unknown, config: EnvironmentDescriptor['backendMode']): string {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return config.values.includes(normalized) ? normalized : config.defaultValue;
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

function readSettingReference(value: unknown): AgentUiSettingReferenceV1 | null {
    if (!isRecord(value)) return null;
    if (value.scope !== 'host' && value.scope !== 'account' && value.scope !== 'daemon') return null;
    if (typeof value.localId !== 'string') return null;
    const localId = value.localId.trim();
    return localId.length > 0 ? { scope: value.scope, localId } : null;
}

function readSetting(settings: unknown, key: AgentUiSettingReferenceV1): unknown {
    return isRecord(settings) ? readAgentUiSetting(settings as Settings, key) : undefined;
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

function readRuntimeSettings(opts: Readonly<{
    descriptor: EnvironmentDescriptor;
    settings?: unknown;
    session?: Readonly<{
        metadata?: Record<string, unknown> | null;
        metadataLayoutVersion?: number;
        ownerMetadataView?: unknown;
    }> | null;
    newSessionOptions?: Record<string, unknown> | null;
    allowLegacySettingsServerBaseUrl?: boolean;
    allowActiveServerFallback?: boolean;
}>) {
    const backendMode = normalizeEnumValue(
        readSetting(opts.settings, opts.descriptor.backendMode.settingKey),
        opts.descriptor.backendMode,
    );

    const serverBaseUrlConfig = opts.descriptor.serverBaseUrl;
    if (!serverBaseUrlConfig) return { backendMode, serverBaseUrl: null };

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
    return { backendMode, serverBaseUrl: activeServerOverride ?? legacyServerBaseUrl };
}

function buildEnvironmentVariables(opts: Parameters<typeof readRuntimeSettings>[0] & Readonly<{
    environmentVariables?: Record<string, string>;
}>): Record<string, string> {
    const base = { ...(opts.environmentVariables ?? {}) };
    const { backendMode, serverBaseUrl } = readRuntimeSettings(opts);
    base[opts.descriptor.backendMode.envKey] = backendMode;
    const serverBaseUrlConfig = opts.descriptor.serverBaseUrl;
    if (serverBaseUrl && serverBaseUrlConfig) {
        base[serverBaseUrlConfig.envKey] = serverBaseUrl;
        base[serverBaseUrlConfig.explicitEnvKey] = '1';
    }
    return base;
}

function readEnvironmentDescriptor(
    value: unknown,
    agentId: string,
    diagnostics: UiProjectionDiagnostic[],
): EnvironmentDescriptor | null {
    if (!isRecord(value)) return null;
    const providerId = agentId;
    const backendMode = isRecord(value.backendMode) ? value.backendMode : null;
    const backendModeValues = readStringArray(backendMode?.values);
    const backendModeConfig = providerId && backendMode
        ? {
            envKey: readString(backendMode.envKey),
            settingKey: readSettingReference(backendMode.settingKey),
            defaultValue: readString(backendMode.defaultValue),
            values: backendModeValues,
        }
        : null;

    if (
        !providerId
        || !backendModeConfig?.envKey
        || !backendModeConfig.settingKey
        || !backendModeConfig.defaultValue
        || backendModeConfig.values.length === 0
    ) {
        diagnostics.push(createUiProjectionDiagnostic(
            'A16X1_MALFORMED_DESCRIPTOR',
            'payload.environmentVariables',
            'Environment variable descriptors require backend mode field metadata.',
        ));
        return null;
    }

    const serverBaseUrl = isRecord(value.serverBaseUrl) ? value.serverBaseUrl : null;
    const serverBaseUrlConfig = serverBaseUrl
        ? {
            envKey: readString(serverBaseUrl.envKey) ?? '',
            explicitEnvKey: readString(serverBaseUrl.explicitEnvKey) ?? '',
            settingKey: readSettingReference(serverBaseUrl.settingKey),
            byServerIdSettingKey: readSettingReference(serverBaseUrl.byServerIdSettingKey),
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
            ? { serverBaseUrl: serverBaseUrlConfig as EnvironmentDescriptor['serverBaseUrl'] }
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
    const detailSettingsKey = readSettingReference(entry.detailSettingsKey);
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
        return {
            key: `${params.descriptor.keyPrefix}:${params.descriptor.serviceId}:group:${groupId}`,
            labelKey: groupId,
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

function readCandidateDetailsSource(candidate: Readonly<{ details?: Record<string, unknown> }>): Record<string, unknown> | null {
    const source = candidate.details?.source;
    return isRecord(source) ? source : null;
}

function readCandidateRuntimeDescriptor(
    candidate: Readonly<{ details?: Record<string, unknown> }>,
    agentId: string,
) {
    const parsed = RuntimeDescriptorV1Schema.safeParse(candidate.details?.runtimeDescriptorV1);
    return parsed.success && parsed.data.agentId === agentId ? parsed.data : null;
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

function readProfileLabelFromSettings(opts: Readonly<{
    settings: unknown;
    settingKey?: AgentUiSettingReferenceV1;
    serviceId: string;
    profileId: string;
}>): string | null {
    if (!opts.settingKey) return null;
    const labels = readSetting(opts.settings, opts.settingKey);
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

function createExternalSessionsBehavior(
    descriptor: Readonly<Record<string, unknown>>,
    agentId: string,
): AgentUiBehavior['externalSessions'] | undefined {
    const externalSessions = isRecord(descriptor.externalSessions) ? descriptor.externalSessions : null;
    const browse = isRecord(externalSessions?.browse) ? externalSessions.browse : null;
    const sourceOptions = readSourceOptionDescriptors(browse?.sourceOptions);
    const connectedServiceProfileSources = readConnectedServiceProfileSourceDescriptors(browse?.connectedServiceProfileSources);
    const lockedConnectedServiceSource = readLockedConnectedServiceSourceDescriptor(browse?.lockedConnectedServiceSource);
    const compatibleSource = readCompatibleSourceDescriptor(browse?.compatibleSource);
    const linkEnsureRequestExtras = isRecord(browse?.linkEnsureRequestExtras) ? browse.linkEnsureRequestExtras : null;
    const sourceFromCandidate = readSourceFromCandidateLinkExtrasDescriptor(linkEnsureRequestExtras?.sourceFromCandidate);
    if (
        !externalSessions
        && sourceOptions.length === 0
        && connectedServiceProfileSources.length === 0
        && !lockedConnectedServiceSource
        && !compatibleSource
        && !sourceFromCandidate
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
                    ...(browse
                        ? {
                            buildLinkEnsureRequestExtras: ({ source, candidate }) => {
                                const candidateSource = sourceFromCandidate
                                    ? resolveSourceFromCandidateDescriptor({ selectedSource: source, candidate, descriptor: sourceFromCandidate })
                                    : null;
                                const runtimeDescriptorV1 = readCandidateRuntimeDescriptor(candidate, agentId);
                                return {
                                    ...(candidateSource ? { source: candidateSource } : {}),
                                    ...(runtimeDescriptorV1 ? { runtimeDescriptorV1 } : {}),
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
        buildSpawnSessionExtras: ({ agentId, settings, newSessionOptions, sessionConfigOptionOverrides, updatedAt }) => {
            if (agentId !== descriptor.providerId) return {};
            const values = readRuntimeSettings({
                descriptor,
                settings,
                newSessionOptions,
                allowLegacySettingsServerBaseUrl: false,
                allowActiveServerFallback: true,
            });
            // The Agent's declared setting ids own its Session configuration
            // options. Raw environment remains a predecessor resume carrier.
            return {
                sessionConfigOptionOverrides: mergeSpawnConfigOptionAliases({
                    sessionConfigOptionOverrides: sessionConfigOptionOverrides ?? undefined,
                    configOptions: {
                        [descriptor.backendMode.settingKey.localId]: values.backendMode,
                        ...(values.serverBaseUrl && descriptor.serverBaseUrl
                            ? { [descriptor.serverBaseUrl.settingKey.localId]: values.serverBaseUrl }
                            : {}),
                    },
                    updatedAt,
                }),
            };
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

    if (!environmentDescriptor) return undefined;

    return {
        runtimeDescriptorV1: {
            backendMode: {
                settingKey: environmentDescriptor.backendMode.settingKey,
                values: environmentDescriptor.backendMode.values,
            },
        },
        ...(transcriptStorageModesByBackendMode.size === 0
            ? {}
            : {
                resolveConfiguredRuntimeKind: ({ agentId, settings }) => (
                    agentId === environmentDescriptor.providerId
                        ? normalizeEnumValue(
                            readSetting(settings, environmentDescriptor.backendMode.settingKey),
                            environmentDescriptor.backendMode,
                        )
                        : null
                ),
                supportsTranscriptStorageMode: ({ agentId, settings, storageMode }) => {
                    if (agentId !== environmentDescriptor.providerId) return true;
                    const backendMode = normalizeEnumValue(
                        readSetting(settings, environmentDescriptor.backendMode.settingKey),
                        environmentDescriptor.backendMode,
                    );
                    const allowedModes = transcriptStorageModesByBackendMode.get(backendMode);
                    return allowedModes ? allowedModes.includes(storageMode) : true;
                },
            }),
    };
}

function createSessionHandoffBehavior(
    descriptor: Readonly<Record<string, unknown>>,
): AgentUiBehavior['sessionHandoff'] | undefined {
    const externalSessions = isRecord(descriptor.externalSessions) ? descriptor.externalSessions : null;
    const sessionHandoff = isRecord(externalSessions?.sessionHandoff) ? externalSessions.sessionHandoff : null;
    const clearMetadataKeys = readStringArray(sessionHandoff?.clearMetadataKeys);

    if (clearMetadataKeys.length === 0) return undefined;

    return {
        buildProviderPatch: () => ({ clearMetadataKeys }),
    };
}

export function createDescriptorAdapterBehavior(ctx: BehaviorDescriptorContext): AgentUiBehavior {
    const payload = isRecord(ctx.descriptor.payload) ? ctx.descriptor.payload : null;
    const environmentDescriptor = readEnvironmentDescriptor(payload?.environmentVariables, ctx.agentId, ctx.diagnostics);
    const externalSessions = createExternalSessionsBehavior(ctx.descriptor, ctx.agentId);
    const newSession = createNewSessionBehavior(ctx.descriptor, environmentDescriptor);
    const sessionHandoff = createSessionHandoffBehavior(ctx.descriptor);
    const payloadBehavior: AgentUiBehavior['payload'] = {
        ...(environmentDescriptor ? createPayloadBehavior(environmentDescriptor) : {}),
    };
    return {
        ...(externalSessions ? { externalSessions } : {}),
        ...(newSession ? { newSession } : {}),
        ...(sessionHandoff ? { sessionHandoff } : {}),
        ...(Object.keys(payloadBehavior).length > 0 ? { payload: payloadBehavior } : {}),
    };
}
