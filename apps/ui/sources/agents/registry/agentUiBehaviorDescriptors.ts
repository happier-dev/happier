import type { ReactNode } from 'react';

import type { DetailsTab } from '@/components/appShell/panes/model/appPaneReducer';
import type { Settings } from '@/sync/domains/settings/settings';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import { tLoose } from '@/text';

import type {
    AgentSessionComposerNonSteerablePayloadContext,
    AgentSessionComposerNonSteerableReason,
    AgentPermissionFooterBehavior,
    AgentTranscriptStorageMode,
    AgentUiBehavior,
} from './registryUiBehavior';
import { resolveFirstPartyUiComponent } from './componentAllowlist';
import {
    createUiProjectionDiagnostic,
    isRecord,
    readString,
    readStringArray,
    type UiProjectionDiagnostic,
} from './uiDescriptorDiagnostics';
import { createDescriptorAdapterBehavior } from './agentUiBehaviorDescriptorAdapters';
import { createAuggieUiBehavior } from './agentUiBehavior/auggie';
import { createCodexUiBehavior } from './agentUiBehavior/codex';

type SettingsKey = Extract<keyof Settings, string>;

type StaticPayloadDescriptor = Readonly<{
    kind: 'static';
    value: Record<string, unknown>;
}>;

type UnsupportedPayloadAdapterDescriptor = Readonly<{
    kind: 'adapter';
    adapterId: string;
}>;

type PayloadDescriptor = StaticPayloadDescriptor | UnsupportedPayloadAdapterDescriptor;

type ComponentSlotDescriptor = Readonly<{
    id: string;
    slot: string;
    componentId: string;
    props?: Readonly<{
        teamIds?: Readonly<{
            kind: 'subagentGroupKeys';
            subagentKinds?: readonly string[];
        }>;
    }>;
    resourceKind?: string;
    iconName?: string;
    tab?: Readonly<{
        keyPrefix: string;
        titleKey: string;
        subtitleKey?: string;
    }>;
}>;

type ComponentSlotsDescriptor = Readonly<{
    slots?: readonly ComponentSlotDescriptor[];
}>;

export type PluginUiBehaviorDescriptor = Readonly<{
    guidance?: Readonly<{
        includeInSessionGettingStartedCliExamples?: boolean;
    }>;
    mcpServers?: Readonly<{
        supportsDetectedConfigScan?: boolean;
    }>;
    permissions?: Readonly<{
        footer?: Partial<AgentPermissionFooterBehavior>;
    }>;
    resume?: Readonly<{
        experimentSwitches?: readonly Readonly<{
            id: string;
            settingKey?: SettingsKey;
        }>[];
    }>;
    sessionComposer?: Readonly<{
        nonSteerableWhileBusy?: Readonly<{
            reason?: AgentSessionComposerNonSteerableReason;
            metaKeys?: readonly string[];
            sessionConfigOptionIds?: readonly string[];
            freshModelOverride?: boolean;
        }>;
    }>;
    newSession?: Readonly<{
        relevantInstallableDepKeys?: readonly string[];
        transcriptStorageModes?: readonly AgentTranscriptStorageMode[];
        transcriptStorageModesByBackendMode?: Readonly<Record<string, readonly AgentTranscriptStorageMode[]>>;
        canSelectWithoutDetectedCli?: boolean;
    }>;
    payload?: Readonly<{
        spawnSessionExtras?: PayloadDescriptor;
        environmentVariables?: unknown;
    }>;
    externalSessions?: unknown;
    sessionHandoff?: unknown;
    components?: ComponentSlotsDescriptor;
}>;

export type PluginUiDescriptor = Readonly<{
    kind: 'plugin.ui.v1';
    pluginId: string;
    agentId: string;
    version: number;
    behavior?: PluginUiBehaviorDescriptor;
    components?: ComponentSlotsDescriptor;
}>;

export type GeneratedAgentUiBehaviorDescriptor = Readonly<{
    descriptorId?: string;
    newSessionOptions?: readonly Readonly<{
        id: string;
        stateKey: string;
    }>[];
}>;

export type AgentUiBehaviorDescriptorResult = Readonly<{
    behavior: AgentUiBehavior;
    diagnostics: readonly UiProjectionDiagnostic[];
}>;

type AgentExperimentSwitchDescriptor = Readonly<{
    id: string;
    settingKey?: SettingsKey;
}>;

function normalizePayloadDescriptor(value: unknown): PayloadDescriptor | null {
    if (!isRecord(value)) return null;
    if (value.kind === 'static' && isRecord(value.value)) {
        return { kind: 'static', value: value.value };
    }
    if (value.kind === 'adapter') {
        const adapterId = readString(value.adapterId);
        return adapterId ? { kind: 'adapter', adapterId } : null;
    }
    return null;
}

function createPayloadBehavior(
    descriptor: PluginUiBehaviorDescriptor,
    diagnostics: UiProjectionDiagnostic[],
): AgentUiBehavior['payload'] | undefined {
    const spawnSessionExtras = normalizePayloadDescriptor(descriptor.payload?.spawnSessionExtras);
    if (!spawnSessionExtras) return undefined;

    if (spawnSessionExtras.kind === 'adapter') {
        diagnostics.push(createUiProjectionDiagnostic(
            'A16X1_UNSUPPORTED_DESCRIPTOR_ADAPTER',
            'payload.spawnSessionExtras',
            `Unsupported UI behavior payload adapter '${spawnSessionExtras.adapterId}'.`,
        ));
        return undefined;
    }

    return {
        buildSpawnSessionExtras: () => ({ ...spawnSessionExtras.value }),
    };
}

function readFiniteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readObjectUpdatedAt(value: unknown): number | null {
    return isRecord(value) ? readFiniteNumber(value.updatedAt) : null;
}

function readMaxUpdatedAt(values: readonly unknown[]): number | null {
    let max: number | null = null;
    for (const value of values) {
        const updatedAt = readObjectUpdatedAt(value);
        if (updatedAt == null) continue;
        max = max == null ? updatedAt : Math.max(max, updatedAt);
    }
    return max;
}

function hasOwnField(value: unknown, key: string): boolean {
    return isRecord(value) && Object.prototype.hasOwnProperty.call(value, key);
}

function hasListedMetaOverride(
    metaOverrides: Record<string, unknown> | null | undefined,
    metaKeys: readonly string[],
): boolean {
    if (!metaOverrides) return false;
    return metaKeys.some((key) => Object.prototype.hasOwnProperty.call(metaOverrides, key));
}

function isOverrideNewerThanSource(
    override: unknown,
    overrideContainer: unknown,
    source: unknown,
): boolean {
    const overrideUpdatedAt = readObjectUpdatedAt(override) ?? readObjectUpdatedAt(overrideContainer);
    const sourceUpdatedAt = readObjectUpdatedAt(source);
    return overrideUpdatedAt == null || sourceUpdatedAt == null || overrideUpdatedAt > sourceUpdatedAt;
}

function hasFreshConfigOptionOverride(
    metadata: Record<string, unknown>,
    optionIds: readonly string[],
): boolean {
    const candidates = [
        {
            overrides: metadata.sessionConfigOptionOverridesV1,
            source: metadata.sessionConfigOptionsV1,
        },
        {
            overrides: metadata.acpConfigOptionOverridesV1,
            source: metadata.acpConfigOptionsV1,
        },
    ] as const;

    for (const candidate of candidates) {
        if (!isRecord(candidate.overrides) || !isRecord(candidate.overrides.overrides)) continue;
        for (const optionId of optionIds) {
            if (!hasOwnField(candidate.overrides.overrides, optionId)) continue;
            if (isOverrideNewerThanSource(candidate.overrides.overrides[optionId], candidate.overrides, candidate.source)) {
                return true;
            }
        }
    }

    return false;
}

function readSessionField(
    session: AgentSessionComposerNonSteerablePayloadContext['session'],
    key: string,
): unknown {
    return (session as unknown as Record<string, unknown>)[key];
}

function isNonDefaultValue(value: unknown): boolean {
    const normalized = readString(value);
    return Boolean(normalized && normalized !== 'default');
}

function hasFreshModelOverride(ctx: AgentSessionComposerNonSteerablePayloadContext): boolean {
    const metadata: Record<string, unknown> = isRecord(ctx.session.metadata) ? ctx.session.metadata : {};
    const modelSourceUpdatedAt = readMaxUpdatedAt([
        metadata.sessionModelsV1,
        metadata.acpSessionModelsV1,
    ]);
    const metadataModelOverride = isRecord(metadata.modelOverrideV1) ? metadata.modelOverrideV1 : null;
    if (
        metadataModelOverride
        && isNonDefaultValue(metadataModelOverride.modelId)
        && isOverrideNewerThanSource(metadataModelOverride, metadataModelOverride, { updatedAt: modelSourceUpdatedAt })
    ) {
        return true;
    }

    if (!isNonDefaultValue(readSessionField(ctx.session, 'modelMode'))) return false;
    const localUpdatedAt = readFiniteNumber(readSessionField(ctx.session, 'modelModeUpdatedAt'));
    return localUpdatedAt != null && (modelSourceUpdatedAt == null || localUpdatedAt > modelSourceUpdatedAt);
}

function createSessionComposerBehavior(
    descriptor: PluginUiBehaviorDescriptor,
): AgentUiBehavior['sessionComposer'] | undefined {
    const nonSteerable = descriptor.sessionComposer?.nonSteerableWhileBusy;
    if (!nonSteerable) return undefined;

    const reason = nonSteerable.reason ?? 'provider_config_change_refused';
    const metaKeys = readStringArray(nonSteerable.metaKeys);
    const sessionConfigOptionIds = readStringArray(nonSteerable.sessionConfigOptionIds);
    const freshModelOverride = nonSteerable.freshModelOverride === true;

    return {
        classifyNonSteerablePayload: (ctx) => {
            const metadata = isRecord(ctx.session.metadata) ? ctx.session.metadata : {};
            if (hasListedMetaOverride(ctx.metaOverrides, metaKeys)) {
                return reason;
            }
            if (hasFreshConfigOptionOverride(metadata, sessionConfigOptionIds)) {
                return reason;
            }
            if (freshModelOverride && hasFreshModelOverride(ctx)) {
                return reason;
            }
            return null;
        },
    };
}

export const HOST_AGENT_UI_BEHAVIOR_DESCRIPTOR_BY_AGENT_ID: Readonly<Record<string, GeneratedAgentUiBehaviorDescriptor>> = Object.freeze({
    codex: { descriptorId: 'codex.uiBehavior.v1' },
});

function createAgentUiBehaviorFromGeneratedDescriptor(
    descriptor: GeneratedAgentUiBehaviorDescriptor,
    diagnostics: UiProjectionDiagnostic[],
): AgentUiBehavior {
    const descriptorId = readString(descriptor.descriptorId);
    if (descriptorId === 'auggie.uiBehavior.v1') return createAuggieUiBehavior(descriptor);
    if (descriptorId === 'codex.uiBehavior.v1') return createCodexUiBehavior();
    if (descriptorId === 'pi.uiBehavior.v1') return {};
    if (descriptorId) {
        diagnostics.push(createUiProjectionDiagnostic(
            'A16X1_UNSUPPORTED_DESCRIPTOR_ADAPTER',
            'descriptorId',
            `Unsupported agent UI behavior descriptor id '${descriptorId}'.`,
        ));
    }
    return {};
}

function hasNoExecuteBehaviorFields(value: Readonly<Record<string, unknown>>): boolean {
    return value.guidance != null
        || value.mcpServers != null
        || value.permissions != null
        || value.resume != null
        || value.sessionComposer != null
        || value.newSession != null
        || value.payload != null
        || value.externalSessions != null
        || value.sessionHandoff != null
        || value.components != null;
}

function mergeDescriptorBehavior(a: AgentUiBehavior, b: AgentUiBehavior): AgentUiBehavior {
    return {
        ...(a.guidance || b.guidance ? { guidance: { ...(a.guidance ?? {}), ...(b.guidance ?? {}) } } : {}),
        ...(a.mcpServers || b.mcpServers ? { mcpServers: { ...(a.mcpServers ?? {}), ...(b.mcpServers ?? {}) } } : {}),
        ...(a.permissions || b.permissions
            ? {
                permissions: {
                    ...(a.permissions ?? {}),
                    ...(b.permissions ?? {}),
                    ...(a.permissions?.footer || b.permissions?.footer
                        ? { footer: { ...(a.permissions?.footer ?? {}), ...(b.permissions?.footer ?? {}) } }
                        : {}),
                },
            }
            : {}),
        ...(a.resume || b.resume ? { resume: { ...(a.resume ?? {}), ...(b.resume ?? {}) } } : {}),
        ...(a.sessionComposer || b.sessionComposer
            ? { sessionComposer: { ...(a.sessionComposer ?? {}), ...(b.sessionComposer ?? {}) } }
            : {}),
        ...(a.newSession || b.newSession ? { newSession: { ...(a.newSession ?? {}), ...(b.newSession ?? {}) } } : {}),
        ...(a.externalSessions || b.externalSessions
            ? {
                externalSessions: {
                    ...(a.externalSessions ?? {}),
                    ...(b.externalSessions ?? {}),
                    ...(a.externalSessions?.browse || b.externalSessions?.browse
                        ? { browse: { ...(a.externalSessions?.browse ?? {}), ...(b.externalSessions?.browse ?? {}) } }
                        : {}),
                },
            }
            : {}),
        ...(a.sessionHandoff || b.sessionHandoff ? { sessionHandoff: { ...(a.sessionHandoff ?? {}), ...(b.sessionHandoff ?? {}) } } : {}),
        ...(a.payload || b.payload ? { payload: { ...(a.payload ?? {}), ...(b.payload ?? {}) } } : {}),
        ...(a.sessionSubagents || b.sessionSubagents
            ? { sessionSubagents: { ...(a.sessionSubagents ?? {}), ...(b.sessionSubagents ?? {}) } }
            : {}),
    };
}

function readComponentSlots(components: ComponentSlotsDescriptor | undefined): readonly ComponentSlotDescriptor[] {
    return Array.isArray(components?.slots) ? components.slots : [];
}

function collectSubagentGroupKeys(
    subagents: readonly SessionSubagent[],
    descriptor: ComponentSlotDescriptor,
): readonly string[] {
    const kinds = new Set(readStringArray(descriptor.props?.teamIds?.subagentKinds));
    const ids = new Set<string>();
    for (const subagent of subagents) {
        if (kinds.size > 0 && !kinds.has(subagent.kind)) continue;
        const groupKey = readString(subagent.display.groupKey);
        if (groupKey) ids.add(groupKey);
    }
    return [...ids];
}

function createTeammateLauncherDetailsTab(
    descriptor: ComponentSlotDescriptor,
    teamId: string,
): DetailsTab | null {
    const resourceKind = readString(descriptor.resourceKind);
    const keyPrefix = readString(descriptor.tab?.keyPrefix);
    const titleKey = readString(descriptor.tab?.titleKey);
    if (!resourceKind || !keyPrefix || !titleKey) return null;

    const normalizedTeamId = readString(teamId);
    return {
        key: normalizedTeamId ? `${keyPrefix}:member:${normalizedTeamId}` : `${keyPrefix}:member`,
        kind: resourceKind,
        title: tLoose(titleKey),
        ...(descriptor.tab?.subtitleKey ? { subtitle: tLoose(descriptor.tab.subtitleKey) } : {}),
        resource: {
            kind: resourceKind,
            mode: 'member',
            ...(normalizedTeamId ? { initialTeamId: normalizedTeamId } : {}),
        },
    };
}

function isDetailsTabResourceForSlot(tab: DetailsTab, descriptor: ComponentSlotDescriptor): boolean {
    const resourceKind = readString(descriptor.resourceKind);
    return Boolean(
        resourceKind
        && isRecord(tab.resource)
        && tab.resource.kind === resourceKind,
    );
}

function createSessionSubagentsBehaviorFromComponents(
    components: ComponentSlotsDescriptor | undefined,
    diagnostics: UiProjectionDiagnostic[],
): AgentUiBehavior['sessionSubagents'] | undefined {
    const slots = readComponentSlots(components);
    const launchCardSlots = slots.filter((slot) => slot.slot === 'sessionSubagents.launchCards');
    const detailsTabSlots = slots.filter((slot) => slot.slot === 'sessionSubagents.teammateDetailsTab');
    if (launchCardSlots.length === 0 && detailsTabSlots.length === 0) return undefined;

    return {
        ...(launchCardSlots.length > 0
            ? {
                renderLaunchCards: ({ sessionId, scopeId, subagents }) => {
                    const rendered: ReactNode[] = [];
                    for (const slot of launchCardSlots) {
                        const resolution = resolveFirstPartyUiComponent(slot.componentId);
                        if (resolution.diagnostic) diagnostics.push(resolution.diagnostic);
                        if (!resolution.render) continue;
                        rendered.push(resolution.render({
                            sessionId,
                            scopeId,
                            teamIds: collectSubagentGroupKeys(subagents, slot),
                        }));
                    }
                    return rendered;
                },
            }
            : {}),
        ...(detailsTabSlots.length > 0
            ? {
                createTeammateLauncherDetailsTab: ({ teamId }) => {
                    for (const slot of detailsTabSlots) {
                        const tab = createTeammateLauncherDetailsTab(slot, teamId);
                        if (tab) return tab;
                    }
                    return null;
                },
                renderDetailsTab: ({ sessionId, scopeId, tab }) => {
                    for (const slot of detailsTabSlots) {
                        if (!isDetailsTabResourceForSlot(tab, slot)) continue;
                        const resolution = resolveFirstPartyUiComponent(slot.componentId);
                        if (resolution.diagnostic) diagnostics.push(resolution.diagnostic);
                        if (!resolution.render || !isRecord(tab.resource)) continue;
                        return resolution.render({
                            sessionId,
                            scopeId,
                            mode: readString(tab.resource.mode),
                            initialTeamId: readString(tab.resource.initialTeamId),
                        });
                    }
                    return null;
                },
                getDetailsTabIconName: ({ tab }) => {
                    for (const slot of detailsTabSlots) {
                        if (!isDetailsTabResourceForSlot(tab, slot)) continue;
                        return readString(slot.iconName);
                    }
                    return null;
                },
            }
            : {}),
    };
}

function createAgentUiBehaviorFromBehaviorDescriptor(
    descriptor: PluginUiBehaviorDescriptor,
    diagnostics: UiProjectionDiagnostic[],
): AgentUiBehavior {
    const relevantInstallableDepKeys = readStringArray(descriptor.newSession?.relevantInstallableDepKeys);
    const transcriptStorageModes = new Set(descriptor.newSession?.transcriptStorageModes ?? []);
    const payload = createPayloadBehavior(descriptor, diagnostics);
    const sessionSubagents = createSessionSubagentsBehaviorFromComponents(descriptor.components, diagnostics);
    const sessionComposer = createSessionComposerBehavior(descriptor);
    const experimentSwitches = (descriptor.resume?.experimentSwitches ?? [])
        .reduce<AgentExperimentSwitchDescriptor[]>((acc, entry, index) => {
            const id = readString(entry.id);
            if (!id) {
                diagnostics.push(createUiProjectionDiagnostic(
                    'A16X1_MALFORMED_DESCRIPTOR',
                    `resume.experimentSwitches.${index}.id`,
                    'Experiment switch descriptors require a non-empty id.',
                ));
                return acc;
            }
            acc.push({
                id,
                settingKey: entry.settingKey,
            });
            return acc;
        }, []);

    const baseBehavior: AgentUiBehavior = {
        ...(descriptor.guidance ? { guidance: { ...descriptor.guidance } } : {}),
        ...(descriptor.mcpServers ? { mcpServers: { ...descriptor.mcpServers } } : {}),
        ...(descriptor.permissions ? { permissions: { ...descriptor.permissions } } : {}),
        ...(experimentSwitches.length > 0
            ? {
                resume: {
                    experimentSwitches: experimentSwitches.map((entry) => ({
                        id: entry.id,
                        settingKey: entry.settingKey,
                        getValue: entry.settingKey
                            ? (settings) => settings[entry.settingKey as SettingsKey] === true
                            : undefined,
                    })),
                },
            }
            : {}),
        ...(descriptor.newSession
            ? {
                newSession: {
                    ...(relevantInstallableDepKeys.length > 0
                        ? { getRelevantInstallableDepKeys: () => relevantInstallableDepKeys }
                        : {}),
                    ...(transcriptStorageModes.size > 0
                        ? { supportsTranscriptStorageMode: ({ storageMode }) => transcriptStorageModes.has(storageMode) }
                        : {}),
                    ...(typeof descriptor.newSession.canSelectWithoutDetectedCli === 'boolean'
                        ? { canSelectWithoutDetectedCli: () => descriptor.newSession?.canSelectWithoutDetectedCli === true }
                        : {}),
                },
            }
            : {}),
        ...(payload ? { payload } : {}),
        ...(sessionComposer ? { sessionComposer } : {}),
        ...(sessionSubagents ? { sessionSubagents } : {}),
    };
    const adapterBehavior = createDescriptorAdapterBehavior({
        descriptor: descriptor as Readonly<Record<string, unknown>>,
        diagnostics,
    });

    return mergeDescriptorBehavior(baseBehavior, adapterBehavior);
}

export function createAgentUiBehaviorFromDescriptor(value: unknown): AgentUiBehaviorDescriptorResult {
    const diagnostics: UiProjectionDiagnostic[] = [];
    if (isRecord(value) && value.kind == null && (value.descriptorId != null || value.newSessionOptions != null)) {
        if (hasNoExecuteBehaviorFields(value)) {
            return {
                behavior: createAgentUiBehaviorFromBehaviorDescriptor(value as PluginUiBehaviorDescriptor, diagnostics),
                diagnostics,
            };
        }
        return {
            behavior: createAgentUiBehaviorFromGeneratedDescriptor(value as GeneratedAgentUiBehaviorDescriptor, diagnostics),
            diagnostics,
        };
    }

    if (!isRecord(value) || value.kind !== 'plugin.ui.v1') {
        return {
            behavior: {},
            diagnostics: [
                createUiProjectionDiagnostic(
                    'A16X1_UNSUPPORTED_DESCRIPTOR_KIND',
                    'kind',
                    'Unsupported agent UI behavior descriptor kind.',
                ),
            ],
        };
    }

    const pluginDescriptor = value as PluginUiDescriptor;
    const descriptor: PluginUiBehaviorDescriptor = {
        ...(pluginDescriptor.behavior ?? {}),
        ...(pluginDescriptor.components ? { components: pluginDescriptor.components } : {}),
    };

    return {
        behavior: createAgentUiBehaviorFromBehaviorDescriptor(descriptor, diagnostics),
        diagnostics,
    };
}
