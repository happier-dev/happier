import { z } from 'zod';
import type { VoiceProviderContribution } from '../../plugins/contributions/voiceProviders.js';
import { VoiceProviderSettingsJsonValueV1Schema } from '../realtime/providerSettings.js';
import type { VoiceReadinessRequirement, VoiceReadinessRole, VoiceRuntimePlatform } from '../realtime/capabilities.js';
import { projectExternalVoiceProviderSettings, type ExternalVoiceProviderSettingsDescriptor } from './externalProviderSettings.js';
import type { SessionVoiceDeclarationV1 } from '../../sessions/instructions/sessionVoicePreferenceV1.js';

const VoiceProviderSettingsProjectionSchema = z.object({
    status: z.enum(['ready', 'missing_required_setting', 'needs_migration', 'invalid', 'unsupported_version']),
    modeId: z.string().min(1).max(64).regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u).nullable(),
    requirements: z.array(z.enum(['server_feature', 'execution_machine', 'credential', 'endpoint', 'runtime', 'model']))
        .max(6).superRefine((values, context) => {
            if (new Set(values).size !== values.length) context.addIssue({ code: 'custom', message: 'Expected unique requirements' });
        }).optional(),
}).strict();
const VoiceProviderSettingsJsonObjectV1Schema = z.record(z.string(), VoiceProviderSettingsJsonValueV1Schema);

export type VoiceProviderSettingsProjection = z.infer<typeof VoiceProviderSettingsProjectionSchema>;
export type VoiceProviderSelectionOption = Readonly<{
    id: string; modeId: string | null; order: number; titleKey: string; subtitleKey: string;
    configPatch?: Readonly<Record<string, unknown>>;
}>;
/** The declaration-owned settings slice of a host's activated Voice registry. */
export type VoiceSettingsRegistryEntry = Readonly<{
    providerId: string;
    kind: 'voice.conversation-provider.v1' | 'voice.speech-engine.v1' | 'voice.turn-support.v1';
    roles: readonly VoiceReadinessRole[];
    requirements?: readonly VoiceReadinessRequirement[];
    supportedPlatforms?: readonly VoiceRuntimePlatform[];
    selectionOptions?: readonly VoiceProviderSelectionOption[];
    providerSettings?: ExternalVoiceProviderSettingsDescriptor;
    /** Trusted host engines expose their supported Session field without impersonating plugin HTTP declarations. */
    sessionVoice?: Readonly<{ providerContributionId: string; declaration: SessionVoiceDeclarationV1 }>;
    projectSettings?: (envelope: Readonly<{ schemaVersion: number; config: unknown }> | null) => VoiceProviderSettingsProjection;
}>;
export type VoiceSettingsRegistry = Readonly<{
    get(providerId: string): VoiceSettingsRegistryEntry | null;
    list(): readonly VoiceSettingsRegistryEntry[];
}>;

const INVALID_SETTINGS_PROJECTION = Object.freeze({ status: 'invalid' as const, modeId: null });
function deepFreeze<T>(value: T): T {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    return Object.freeze(value);
}
export function isVoiceProviderSettingsProjectionCurrent(projection: VoiceProviderSettingsProjection | null | undefined):
    projection is VoiceProviderSettingsProjection & Readonly<{ status: 'ready' | 'missing_required_setting' }> {
    return projection?.status === 'ready' || projection?.status === 'missing_required_setting';
}
/** The single executable projector admission boundary, shared by every settings consumer. */
export function projectVoiceProviderSettings(entry: Pick<VoiceSettingsRegistryEntry, 'projectSettings'>,
    envelope: Readonly<{ schemaVersion: number; config: unknown }> | null): VoiceProviderSettingsProjection | null {
    if (!entry.projectSettings) return null;
    try {
        const projection = VoiceProviderSettingsProjectionSchema.safeParse(entry.projectSettings(envelope));
        return projection.success ? deepFreeze(projection.data) : INVALID_SETTINGS_PROJECTION;
    } catch { return INVALID_SETTINGS_PROJECTION; }
}
function isConfigPatchMatch(config: unknown, patch: unknown): boolean {
    if (Object.is(config, patch)) return true;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)
        || !config || typeof config !== 'object' || Array.isArray(config)) return false;
    const configRecord = config as Readonly<Record<string, unknown>>;
    return Object.entries(patch as Readonly<Record<string, unknown>>)
        .every(([key, value]) => isConfigPatchMatch(configRecord[key], value));
}
function isNonEmptySetting(value: unknown): boolean {
    if (typeof value === 'string') return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === 'object') return Object.keys(value).length > 0;
    return value !== null && value !== undefined;
}
function projectDeclaredSettingsReadiness(declaration: VoiceProviderContribution, config: Readonly<Record<string, unknown>>): 'ready' | 'missing_required_setting' {
    for (const requirement of declaration.settings?.readiness ?? []) {
        if (requirement.when && config[requirement.when.settingId] !== requirement.when.equals) continue;
        if (!isNonEmptySetting(config[requirement.settingId])) return 'missing_required_setting';
    }
    return 'ready';
}
export function projectVoiceProviderDeclarationRequirements(declaration: VoiceProviderContribution): readonly VoiceReadinessRequirement[] {
    const requirements: VoiceReadinessRequirement[] = [];
    if (declaration.kind === 'speech') requirements.push('execution_machine');
    if (declaration.kind === 'conversation' && declaration.execution?.kind === 'experimental_agent_session_realtime') {
        requirements.push('execution_machine', 'runtime');
    }
    if (declaration.kind === 'speech' && declaration.settings?.fields.some((field) => field.id === 'baseUrl')) requirements.push('endpoint');
    if (declaration.credentials && declaration.credentials.requirement.kind !== 'optional') requirements.push('credential');
    return Object.freeze(requirements);
}
function projectDeclaredSettingsRequirements(declaration: VoiceProviderContribution, config: Readonly<Record<string, unknown>>): readonly VoiceReadinessRequirement[] | null {
    const requirement = declaration.credentials?.requirement;
    if (requirement?.kind !== 'when_setting_equals') return null;
    const requirements = projectVoiceProviderDeclarationRequirements(declaration);
    return config[requirement.settingId] === requirement.value ? requirements
        : Object.freeze(requirements.filter((entry) => entry !== 'credential'));
}
function deriveRequirementsByMode(declaration: Extract<VoiceProviderContribution, Readonly<{ kind: 'conversation' }>>,
    options: readonly VoiceProviderSelectionOption[]): Readonly<Record<string, readonly VoiceReadinessRequirement[]>> | undefined {
    const requirement = declaration.credentials?.requirement;
    if (requirement?.kind !== 'when_setting_equals') return undefined;
    return Object.freeze(Object.fromEntries(options.flatMap((option) => option.modeId
        ? [[option.modeId, Object.freeze([...(option.configPatch?.[requirement.settingId] === requirement.value ? ['credential' as const] : [])])] as const] : [])));
}
export function createDeclaredSettingsProjector(declaration: VoiceProviderContribution,
    providerSettings: ExternalVoiceProviderSettingsDescriptor, options: readonly VoiceProviderSelectionOption[]) {
    return (envelope: Readonly<{ schemaVersion: number; config: unknown }> | null): VoiceProviderSettingsProjection => {
        const projection = projectExternalVoiceProviderSettings(envelope, providerSettings);
        if (!isVoiceProviderSettingsProjectionCurrent(projection)) return projection;
        const config = VoiceProviderSettingsJsonObjectV1Schema.safeParse(providerSettings.parseConfig(envelope?.config));
        if (!config.success) return INVALID_SETTINGS_PROJECTION;
        const modeId = options.find((option) => option.configPatch && isConfigPatchMatch(config.data, option.configPatch))?.modeId
            ?? options[0]?.modeId ?? projection.modeId;
        const requirements = projectDeclaredSettingsRequirements(declaration, config.data);
        return Object.freeze({ ...projection,
            status: projection.status === 'ready' ? projectDeclaredSettingsReadiness(declaration, config.data) : projection.status,
            modeId, ...(requirements ? { requirements: [...requirements] } : {}),
        });
    };
}
export function projectVoiceProviderDeclarationRegistryBase(input: Readonly<{
    declaration: VoiceProviderContribution; providerSettings: ExternalVoiceProviderSettingsDescriptor | null;
    selectionOptions?: readonly VoiceProviderSelectionOption[];
}>) {
    const selectionOptions = deepFreeze([...(input.selectionOptions ?? [])]);
    const requirementsByMode = input.declaration.kind === 'conversation' ? deriveRequirementsByMode(input.declaration, selectionOptions) : undefined;
    return deepFreeze({
        roles: [...input.declaration.roles], ...(input.declaration.mark ? { mark: input.declaration.mark } : {}),
        requirements: projectVoiceProviderDeclarationRequirements(input.declaration), supportedPlatforms: [...input.declaration.platforms],
        ...(selectionOptions.length > 0 ? { selectionOptions } : {}), ...(requirementsByMode ? { requirementsByMode } : {}),
        ...(input.providerSettings ? { providerSettings: input.providerSettings,
            projectSettings: createDeclaredSettingsProjector(input.declaration, input.providerSettings, selectionOptions) } : {}),
    });
}
