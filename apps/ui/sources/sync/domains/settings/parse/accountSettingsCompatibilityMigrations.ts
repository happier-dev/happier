import {
    classifyLegacyVoiceCredentialCandidateV1,
    listLegacyVoiceCredentialMigrationCandidatesV1,
} from '@happier-dev/protocol/voice/realtime/providerSettings';
import { SessionTmuxMachineOverrideSchema, TRANSCRIPT_MESSAGE_TIMESTAMP_DISPLAY_MODE_VALUES } from '@happier-dev/protocol/account/settings/accountSettings';
import { parsePermissionIntentAlias } from '@happier-dev/agents';
import { z } from 'zod';

import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import {
    buildAgentUniverseBackendTargetKey,
    listAgentUniverseIds,
} from '@/agents/catalog/agentUniverse';
import { getAgentCore } from '@/agents/registry/registryCore';
import { CLAUDE_PERMISSION_MODES, CODEX_LIKE_PERMISSION_MODES, isPermissionMode, type PermissionMode } from '@/sync/domains/permissions/permissionTypes';

import { PredecessorVoiceCredentialBindingV1Schema } from '../voiceCredentialBindingCompatibility';
import { VOICE_LEGACY_CREDENTIAL_RECOVERY_MARKER } from '../voiceSettings';
import { migrateAccountFeatureToggles } from './accountSettingsFeatureToggleMigration';
import { normalizeAccountSettingsServerSelection } from './accountSettingsServerSelectionNormalization';
import { areAccountSettingsJsonValuesEqual } from '../accountSettingsStructuralEquality';

function ownRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function canonicalizeBackendTargetKeyedSettings(value: unknown): Record<string, unknown> {
    const source = ownRecord(value);
    if (!source) return {};

    const aliases: Array<readonly [string, unknown]> = [];
    const canonical: Array<readonly [string, unknown]> = [];
    for (const [key, entry] of Object.entries(source)) {
        try {
            const targetKey = resolveBackendTargetKeyV2(key);
            (targetKey === key ? canonical : aliases).push([targetKey, entry]);
        } catch {
            // The Protocol parser owns validation; an unresolvable compatibility
            // spelling cannot acquire a catalog identity here.
        }
    }

    // Prefer an explicitly persisted canonical entry when both it and an older
    // spelling address the same Agent.
    return Object.fromEntries([...aliases, ...canonical]);
}

function writePath(root: Record<string, unknown>, path: readonly string[], value: unknown): void {
    let current = root;
    path.forEach((segment, index) => {
        if (index === path.length - 1) {
            current[segment] = value;
            return;
        }
        const child = ownRecord(current[segment]) ?? {};
        current[segment] = child;
        current = child;
    });
}

function deletePath(root: Record<string, unknown>, path: readonly string[]): void {
    let current: Record<string, unknown> | null = root;
    for (let index = 0; index < path.length - 1; index += 1) {
        current = ownRecord(current?.[path[index]!]);
        if (!current) return;
    }
    if (current) delete current[path[path.length - 1]!];
}

function migrateLegacyVoiceSavedSecrets(input: Record<string, unknown>, next: Record<string, unknown>): void {
    const rawVoice = ownRecord(input.voice);
    const voice = ownRecord(next.voice);
    if (!rawVoice || !voice) return;
    const adapters = ownRecord(rawVoice.adapters);
    if (!adapters) return;

    const candidates = listLegacyVoiceCredentialMigrationCandidatesV1(rawVoice.providerId);
    const secrets = Array.isArray(next.secrets) ? [...next.secrets] : [];
    const rawPredecessorBindings = Array.isArray(rawVoice.credentialBindings)
        ? rawVoice.credentialBindings.flatMap((candidate) => {
            const parsed = PredecessorVoiceCredentialBindingV1Schema.safeParse(candidate);
            return parsed.success ? [parsed.data] : [];
        })
        : [];
    const bindings = rawPredecessorBindings.length > 0
        ? [...rawPredecessorBindings]
        : Array.isArray(voice.credentialBindings)
            ? [...voice.credentialBindings]
            : [];
    const preservedAdapters: Record<string, unknown> = {};

    for (const candidate of candidates) {
        const classified = classifyLegacyVoiceCredentialCandidateV1({ candidate, rawAdapters: adapters,
            personalSources: secrets, credentialBindings: rawVoice.credentialBindings === undefined
                ? bindings : rawVoice.credentialBindings });
        if (classified.kind === 'absent') continue;
        if (classified.kind === 'unsupported' || classified.kind === 'existing-resource-reference') {
            // Structural Shared provenance cannot retire an inline credential.
            writePath(preservedAdapters, candidate.path, classified.rawSecret);
            if (candidate.canonicalPath) deletePath(voice, candidate.canonicalPath);
            continue;
        }
        if (classified.binding?.credentialBindings.account?.[candidate.slotId]) {
            if (candidate.canonicalPath) deletePath(voice, candidate.canonicalPath);
            continue;
        }
        const secretId = classified.secretId;
        if (classified.kind === 'inline-personal-alias') {
            secrets.push({
                id: secretId,
                name: `Voice: ${candidate.providerId}`,
                kind: 'apiKey',
                encryptedValue: classified.parsedSecret,
                createdAt: 0,
                updatedAt: 0,
            });
        }
        const existingBindingIndex = bindings.findIndex(entry => ownRecord(entry)?.providerId === candidate.providerId);
        const current = classified.binding;
        const replacement = {
            providerId: candidate.providerId,
            credentialBindings: {
                ...(current?.credentialBindings ?? {}),
                account: {
                    ...(current?.credentialBindings.account ?? {}),
                    [candidate.slotId]: secretId,
                },
            },
        };
        if (existingBindingIndex >= 0) bindings[existingBindingIndex] = replacement;
        else bindings.push(replacement);
        if (candidate.canonicalPath) deletePath(voice, candidate.canonicalPath);
    }

    next.secrets = secrets;
    voice.credentialBindings = bindings;
    if (Object.keys(preservedAdapters).length > 0) {
        voice.adapters = preservedAdapters;
        voice[VOICE_LEGACY_CREDENTIAL_RECOVERY_MARKER] = true;
    } else {
        delete voice.adapters;
        delete voice[VOICE_LEGACY_CREDENTIAL_RECOVERY_MARKER];
    }
    next.voice = voice;
}

export function applyAccountSettingsCompatibilityMigrations<TSettings extends Record<string, unknown>>(params: {
    input: Record<string, unknown>;
    settings: TSettings;
    inputSchemaVersion: number;
    supportedSchemaVersion: number;
}): TSettings {
    const { input, inputSchemaVersion, supportedSchemaVersion } = params;
    const next = { ...params.settings } as Record<string, unknown>;

    next.backendEnabledByTargetKey = canonicalizeBackendTargetKeyedSettings(
        next.backendEnabledByTargetKey,
    );
    next.backendCliSourcePreferenceByTargetKey = canonicalizeBackendTargetKeyedSettings(
        next.backendCliSourcePreferenceByTargetKey,
    );
    next.sessionDefaultPermissionModeByTargetKey = canonicalizeBackendTargetKeyedSettings(
        next.sessionDefaultPermissionModeByTargetKey,
    );
    next.newSessionDefaultPersistenceModeByTargetKeyV1 = canonicalizeBackendTargetKeyedSettings(
        next.newSessionDefaultPersistenceModeByTargetKeyV1,
    );

    migrateLegacyVoiceSavedSecrets(input, next);

    if (next.preferredLanguage === 'zh') {
        next.preferredLanguage = 'zh-Hans';
    }

    if (!('sessionListInactiveGroupingV1' in input) && ('groupInactiveSessionsByProject' in input) && next.groupInactiveSessionsByProject === true) {
        next.sessionListInactiveGroupingV1 = 'project';
    }

    if (next.sessionListDensity === 'compact') {
        next.sessionListDensity = 'cozy';
    }

    if (!('sessionListDensity' in input)) {
        const legacyCompact = 'compactSessionView' in input
            ? z.boolean().safeParse(input.compactSessionView)
            : null;
        const legacyMinimal = 'compactSessionViewMinimal' in input
            ? z.boolean().safeParse(input.compactSessionViewMinimal)
            : null;
        if (legacyCompact?.success) {
            next.sessionListDensity = legacyCompact.data
                ? (legacyMinimal?.success && legacyMinimal.data ? 'narrow' : 'cozy')
                : 'detailed';
        }
    }

    if (!('sessionListIdentityDisplay' in input) && next.sessionListDensity !== 'narrow') {
        next.sessionListIdentityDisplay = 'avatar';
    }

    Object.assign(next, normalizeAccountSettingsServerSelection(next));

    const hasMachineSearch = 'useMachinePickerSearch' in input;
    const hasPathSearch = 'usePathPickerSearch' in input;
    if (!hasMachineSearch && !hasPathSearch && 'usePickerSearch' in input) {
        const legacy = z.boolean().safeParse(input.usePickerSearch);
        if (legacy.success && legacy.data === true) {
            next.useMachinePickerSearch = true;
            next.usePathPickerSearch = true;
        }
    }

    if (!('sessionUseTmux' in input) && 'terminalUseTmux' in input) {
        const parsed = z.boolean().safeParse(input.terminalUseTmux);
        if (parsed.success) next.sessionUseTmux = parsed.data;
    }
    if (!('sessionTmuxSessionName' in input) && 'terminalTmuxSessionName' in input) {
        const parsed = z.string().safeParse(input.terminalTmuxSessionName);
        if (parsed.success) next.sessionTmuxSessionName = parsed.data;
    }
    if (!('sessionTmuxIsolated' in input) && 'terminalTmuxIsolated' in input) {
        const parsed = z.boolean().safeParse(input.terminalTmuxIsolated);
        if (parsed.success) next.sessionTmuxIsolated = parsed.data;
    }
    if (!('sessionTmuxTmpDir' in input) && 'terminalTmuxTmpDir' in input) {
        const parsed = z.string().nullable().safeParse(input.terminalTmuxTmpDir);
        if (parsed.success) next.sessionTmuxTmpDir = parsed.data;
    }
    if (!('sessionTmuxByMachineId' in input) && 'terminalTmuxByMachineId' in input) {
        const parsed = z.record(z.string(), SessionTmuxMachineOverrideSchema).safeParse(input.terminalTmuxByMachineId);
        if (parsed.success) next.sessionTmuxByMachineId = parsed.data;
    }
    if (!('sessionMessageSendMode' in input) && 'messageSendMode' in input) {
        const parsed = z.enum(['agent_queue', 'interrupt', 'server_pending'] as const).safeParse(input.messageSendMode);
        if (parsed.success) next.sessionMessageSendMode = parsed.data;
    }

    if (input.sessionBusySteerSendPolicy === 'queue_for_review') {
        next.sessionBusySteerSendPolicy = 'server_pending';
    }

    if (!Object.prototype.hasOwnProperty.call(input, 'transcriptMessageTimestampDisplayMode')) {
        const legacyTimestampsEnabled = 'transcriptMessageTimestampsEnabled' in input
            ? z.boolean().safeParse(input.transcriptMessageTimestampsEnabled)
            : null;
        if (legacyTimestampsEnabled?.success && legacyTimestampsEnabled.data === true) {
            next.transcriptMessageTimestampDisplayMode = 'always';
        }
    } else if (!(TRANSCRIPT_MESSAGE_TIMESTAMP_DISPLAY_MODE_VALUES as readonly unknown[]).includes(next.transcriptMessageTimestampDisplayMode)) {
        next.transcriptMessageTimestampDisplayMode = 'hover_web_hidden_mobile';
    }

    if (!('sessionDefaultPermissionModeByTargetKey' in input)) {
        const byTargetKey = next.sessionDefaultPermissionModeByTargetKey && typeof next.sessionDefaultPermissionModeByTargetKey === 'object'
            ? { ...(next.sessionDefaultPermissionModeByTargetKey as Record<string, PermissionMode>) }
            : {};
        const legacyByAgent = input.sessionDefaultPermissionModeByAgent;
        if (legacyByAgent && typeof legacyByAgent === 'object' && !Array.isArray(legacyByAgent)) {
            for (const agentId of listAgentUniverseIds()) {
                const raw = (legacyByAgent as Record<string, unknown>)[agentId];
                if (isPermissionMode(raw)) {
                    const group = getAgentCore(agentId)?.permissions.modeGroup;
                    const allowed = group === 'codexLike' ? CODEX_LIKE_PERMISSION_MODES : CLAUDE_PERMISSION_MODES;
                    if (!(allowed as readonly string[]).includes(raw)) continue;
                    byTargetKey[buildAgentUniverseBackendTargetKey(agentId)] = raw;
                }
            }
        }
        if (typeof input.lastUsedPermissionMode === 'string') {
            const parsed = parsePermissionIntentAlias(input.lastUsedPermissionMode);
            if (parsed) {
                const seededMode: PermissionMode = parsed === 'plan' ? 'read-only' : parsed;
                for (const to of listAgentUniverseIds()) {
                    const group = getAgentCore(to)?.permissions.modeGroup;
                    const allowed = group === 'codexLike' ? CODEX_LIKE_PERMISSION_MODES : CLAUDE_PERMISSION_MODES;
                    byTargetKey[buildAgentUniverseBackendTargetKey(to)] =
                        (allowed as readonly string[]).includes(seededMode) ? seededMode : 'default';
                }
            }
        }
        next.sessionDefaultPermissionModeByTargetKey = byTargetKey;
    }

    if (!('newSessionDefaultPersistenceModeByTargetKeyV1' in input)) {
        const byTargetKey = next.newSessionDefaultPersistenceModeByTargetKeyV1 && typeof next.newSessionDefaultPersistenceModeByTargetKeyV1 === 'object'
            ? { ...(next.newSessionDefaultPersistenceModeByTargetKeyV1 as Record<string, 'direct' | 'persisted'>) }
            : {};
        const legacyByAgent = input.newSessionDefaultPersistenceModeByAgentV1;
        if (legacyByAgent && typeof legacyByAgent === 'object' && !Array.isArray(legacyByAgent)) {
            for (const agentId of listAgentUniverseIds()) {
                const raw = (legacyByAgent as Record<string, unknown>)[agentId];
                if (raw === 'direct' || raw === 'persisted') {
                    byTargetKey[buildAgentUniverseBackendTargetKey(agentId)] = raw;
                }
            }
        }
        next.newSessionDefaultPersistenceModeByTargetKeyV1 = byTargetKey;
    }

    if (inputSchemaVersion < 4 && !Object.prototype.hasOwnProperty.call(input, 'sessionThinkingInlinePresentation') && next.sessionThinkingDisplayMode === 'inline') {
        next.sessionThinkingInlinePresentation = 'full';
    }

    if (inputSchemaVersion < 5 && !Object.prototype.hasOwnProperty.call(input, 'sessionThinkingInlineChrome')) {
        next.sessionThinkingInlineChrome = 'card';
    }

    if (
        inputSchemaVersion < supportedSchemaVersion
        && Object.prototype.hasOwnProperty.call(input, 'filesDiffPresentationStyle')
        && next.filesDiffPresentationStyle === 'split'
    ) {
        next.filesDiffPresentationStyle = 'unified';
    }

    // The tab-bar blur preference was generalized into a single "glass surfaces"
    // control governing every floating glass panel (tab bar, jump-to-bottom, …).
    if (!('glassBlurEnabled' in input) && 'tabBarBlurEnabled' in input) {
        const parsed = z.boolean().safeParse(input.tabBarBlurEnabled);
        if (parsed.success) next.glassBlurEnabled = parsed.data;
    }
    if (!('glassBlurIntensity' in input) && 'tabBarBlurIntensity' in input) {
        const parsed = z.enum(['light', 'regular', 'strong'] as const).safeParse(input.tabBarBlurIntensity);
        if (parsed.success) next.glassBlurIntensity = parsed.data;
    }

    next.featureToggles = migrateAccountFeatureToggles({
        featureToggles: next.featureToggles,
        inputSchemaVersion,
        supportedSchemaVersion,
    });

    if (inputSchemaVersion < supportedSchemaVersion) {
        next.schemaVersion = supportedSchemaVersion;
    }

    // Legacy Voice ingress mutates nested compatibility carriers. It must still
    // pass the canonical parser even when the original nested reference survives.
    const hasLegacyVoiceAdapters = ownRecord(ownRecord(input.voice)?.adapters) !== null;
    return !hasLegacyVoiceAdapters && areAccountSettingsJsonValuesEqual(next, params.settings)
        ? params.settings
        : next as TSettings;
}
