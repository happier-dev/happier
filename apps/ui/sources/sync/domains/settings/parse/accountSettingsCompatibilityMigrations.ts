import {
    SecretStringV1Schema,
    SessionTmuxMachineOverrideSchema,
    TRANSCRIPT_MESSAGE_TIMESTAMP_DISPLAY_MODE_VALUES,
} from '@happier-dev/protocol';
import { parsePermissionIntentAlias } from '@happier-dev/agents';
import { z } from 'zod';

import { getAgentCore } from '@/agents/registry/registryCore';
import {
    buildAgentUniverseBackendTargetKey,
    listAgentUniverseIds,
} from '@/agents/catalog/agentUniverse';
import { CLAUDE_PERMISSION_MODES, CODEX_LIKE_PERMISSION_MODES, isPermissionMode, type PermissionMode } from '@/sync/domains/permissions/permissionTypes';

import { PredecessorVoiceCredentialBindingV1Schema } from '../voiceCredentialBindingCompatibility';
import { VOICE_LEGACY_CREDENTIAL_RECOVERY_MARKER } from '../voiceSettings';
import { migrateAccountFeatureToggles } from './accountSettingsFeatureToggleMigration';
import { normalizeAccountSettingsServerSelection } from './accountSettingsServerSelectionNormalization';

function ownRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function readPath(root: unknown, path: readonly string[]): unknown {
    let current: unknown = root;
    for (const segment of path) {
        const record = ownRecord(current);
        if (!record || !Object.prototype.hasOwnProperty.call(record, segment)) return undefined;
        current = record[segment];
    }
    return current;
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

    const selectedSpeechAdapter = rawVoice.providerId === 'local_direct'
        || rawVoice.providerId === 'local_conversation'
        ? rawVoice.providerId
        : null;
    const speechAdapterIds = selectedSpeechAdapter === null
        ? ['local_direct', 'local_conversation'] as const
        : [
            selectedSpeechAdapter,
            selectedSpeechAdapter === 'local_direct' ? 'local_conversation' : 'local_direct',
        ] as const;
    const candidates = [
        { providerId: 'realtime_elevenlabs', slotId: 'api_key', path: ['realtime_elevenlabs', 'byo', 'apiKey'], canonicalPath: ['providers', 'happier.voice.elevenlabs/realtime-elevenlabs', 'config', 'byo', 'apiKey'] },
        { providerId: 'google_gemini', slotId: 'api_key', path: ['local_direct', 'stt', 'googleGemini', 'apiKey'] },
        { providerId: 'google_cloud', slotId: 'api_key', path: ['local_direct', 'tts', 'googleCloud', 'apiKey'] },
        ...speechAdapterIds.flatMap((adapterId) => [
            { providerId: 'happier.voice.openai-compat/stt', slotId: 'api_key', path: [adapterId, 'stt', 'openaiCompat', 'apiKey'] },
            { providerId: 'happier.voice.openai-compat/tts', slotId: 'api_key', path: [adapterId, 'tts', 'openaiCompat', 'apiKey'] },
        ]),
        { providerId: 'openai_compat', slotId: 'chat_api_key', path: ['local_conversation', 'agent', 'openaiCompat', 'chatApiKey'], canonicalPath: ['providers', 'local_conversation', 'config', 'agent', 'openaiCompat', 'chatApiKey'] },
    ] as const;
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
        const rawSecret = readPath(adapters, candidate.path);
        if (rawSecret == null) continue;
        const existingBindingIndex = bindings.findIndex((entry) => {
            const parsed = PredecessorVoiceCredentialBindingV1Schema.safeParse(entry);
            return parsed.success && parsed.data.providerId === candidate.providerId;
        });
        const existingBinding = existingBindingIndex < 0
            ? null
            : PredecessorVoiceCredentialBindingV1Schema.safeParse(bindings[existingBindingIndex]);
        const parsedSecret = SecretStringV1Schema.safeParse(rawSecret);
        if (!parsedSecret.success) {
            writePath(preservedAdapters, candidate.path, rawSecret);
            if ('canonicalPath' in candidate) deletePath(voice, candidate.canonicalPath);
            continue;
        }
        const boundSecretId = existingBinding?.success
            ? existingBinding.data.credentialBindings.account?.[candidate.slotId]
            : undefined;
        if (boundSecretId) {
            const boundSecret = secrets.find((entry) => ownRecord(entry)?.id === boundSecretId);
            if (JSON.stringify(ownRecord(boundSecret)?.encryptedValue) !== JSON.stringify(parsedSecret.data)) {
                writePath(preservedAdapters, candidate.path, rawSecret);
            }
            if ('canonicalPath' in candidate) deletePath(voice, candidate.canonicalPath);
            continue;
        }
        const secretId = `voice:${candidate.providerId}:${candidate.slotId}`;
        const colliding = secrets.find((entry) => ownRecord(entry)?.id === secretId);
        if (colliding && JSON.stringify(ownRecord(colliding)?.encryptedValue) !== JSON.stringify(parsedSecret.data)) {
            writePath(preservedAdapters, candidate.path, rawSecret);
            if ('canonicalPath' in candidate) deletePath(voice, candidate.canonicalPath);
            continue;
        }
        if (!colliding) {
            secrets.push({
                id: secretId,
                name: `Voice: ${candidate.providerId}`,
                kind: 'apiKey',
                encryptedValue: parsedSecret.data,
                createdAt: 0,
                updatedAt: 0,
            });
        }
        const current = existingBinding?.success ? existingBinding.data : null;
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
        if ('canonicalPath' in candidate) deletePath(voice, candidate.canonicalPath);
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
        const legacyCompact = z.boolean().safeParse(input.compactSessionView);
        const legacyMinimal = z.boolean().safeParse(input.compactSessionViewMinimal);
        if (legacyCompact.success) {
            next.sessionListDensity = legacyCompact.data
                ? (legacyMinimal.success && legacyMinimal.data ? 'narrow' : 'cozy')
                : 'detailed';
        }
    }

    if (!('sessionListIdentityDisplay' in input) && next.sessionListDensity !== 'narrow') {
        next.sessionListIdentityDisplay = 'avatar';
    }

    next.compactSessionView = next.sessionListDensity === 'cozy' || next.sessionListDensity === 'narrow';
    next.compactSessionViewMinimal = next.sessionListDensity === 'narrow';

    Object.assign(next, normalizeAccountSettingsServerSelection(next));

    const hasMachineSearch = 'useMachinePickerSearch' in input;
    const hasPathSearch = 'usePathPickerSearch' in input;
    if (!hasMachineSearch && !hasPathSearch) {
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
        const legacyTimestampsEnabled = z.boolean().safeParse(input.transcriptMessageTimestampsEnabled);
        if (legacyTimestampsEnabled.success && legacyTimestampsEnabled.data === true) {
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
                    const group = getAgentCore(agentId).permissions.modeGroup;
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
                    const group = getAgentCore(to).permissions.modeGroup;
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

    return next as TSettings;
}
