import { applyVoiceAgentSelectionV1 } from '@happier-dev/protocol/voice/settings/voiceAgentSelection';
import { areAccountSettingsJsonValuesEqual } from '@/sync/domains/settings/accountSettingsStructuralEquality';
import { readLocalConversationVoiceSettings, readVoiceProviderSettingsConfig, writeLocalConversationVoiceSettings, type VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { projectVoiceProviderSelectionRows, selectVoiceProviderOption } from '@/voice/registry/providerSelection';
import { updateVoiceRoleModelChoice } from './roleModelChoice';
import { updateConversationLanguagePreference } from './language/conversationLanguage';

export const voiceSettingsEditRegistry = createDefaultVoiceProviderRegistry();

/** Applies the UI editor's semantic change to the Account writer's current Voice value. */
export function rebaseVoiceSettingsEdit(current: VoiceSettings, before: VoiceSettings, next: VoiceSettings): VoiceSettings {
    const previousChat = readLocalConversationVoiceSettings(before).agent.providerChat;
    const selectedChat = readLocalConversationVoiceSettings(next).agent.providerChat;
    if (previousChat?.status === 'needs_selection' && selectedChat?.status === 'configured'
        && (current.providerId !== before.providerId || !areAccountSettingsJsonValuesEqual(
            readLocalConversationVoiceSettings(current).agent.providerChat, previousChat,
        ))) {
        throw new Error('voice_settings_provider_changed');
    }
    if (before.assistantLanguage !== next.assistantLanguage && current.providerId !== before.providerId) {
        throw new Error('voice_settings_provider_changed');
    }
    for (const providerId of new Set([...Object.keys(before.providers), ...Object.keys(next.providers)])) {
        if (areAccountSettingsJsonValuesEqual(before.providers[providerId], next.providers[providerId])) continue;
        const envelope = current.providers[providerId];
        if (envelope && (envelope.schemaVersion !== before.providers[providerId]?.schemaVersion
            || readVoiceProviderSettingsConfig(current, providerId) === null)) {
            throw new Error('voice_settings_provider_changed');
        }
    }
    const oldAgent = readLocalConversationVoiceSettings(before).agent;
    const nextAgent = readLocalConversationVoiceSettings(next).agent;
    const selectionKeys = ['agentId', 'agentTargetKey', 'agentIdentity'] as const;
    if (selectionKeys.some((key) => !areAccountSettingsJsonValuesEqual(oldAgent[key], nextAgent[key]))) {
        const selected = applyVoiceAgentSelectionV1(current, { kind: 'catalog', entry: {
            agentId: nextAgent.agentId, backendTargetKey: nextAgent.agentTargetKey,
            identity: nextAgent.agentIdentity, isBuiltIn: nextAgent.agentIdentity === null, projectionGeneration: null,
        } }, { readLocalConversationVoiceSettings, writeLocalConversationVoiceSettings });
        current = selected;
    }
    for (const role of ['chat', 'commit'] as const) {
        if (areAccountSettingsJsonValuesEqual(
            [oldAgent[`${role}ModelSource`], oldAgent[`${role}ModelId`], oldAgent[`${role}ModelSelection`]],
            [nextAgent[`${role}ModelSource`], nextAgent[`${role}ModelId`], nextAgent[`${role}ModelSelection`]],
        )) continue;
        const selected = updateVoiceRoleModelChoice(current, role, {
            source: nextAgent[`${role}ModelSource`],
            model: nextAgent[`${role}ModelSelection`] ?? nextAgent[`${role}ModelId`],
        });
        if (!selected) throw new Error('voice_settings_provider_changed');
        current = selected;
    }
    let rebased = rebase(current, before, next) as VoiceSettings;
    if (before.assistantLanguage !== next.assistantLanguage) {
        const language = updateConversationLanguagePreference(current, next.assistantLanguage, voiceSettingsEditRegistry);
        if (!language) throw new Error('voice_settings_provider_changed');
        rebased = { ...rebased, assistantLanguage: language.assistantLanguage };
    }
    if (before.providerId !== next.providerId && next.providerId !== null) {
        const choice = projectVoiceProviderSelectionRows(next, voiceSettingsEditRegistry).find((row) => row.selected);
        const selected = choice && selectVoiceProviderOption(rebased, voiceSettingsEditRegistry, choice.providerId, choice.optionId);
        if (!selected) throw new Error('voice_settings_provider_changed');
        rebased = selected;
    }
    // These are semantic choices, not independent scalar edits. Unchanged cleared facts still
    // belong to the choice and must not retain a concurrent selection's routing identity.
    if (!areAccountSettingsJsonValuesEqual(before.executionMachine, next.executionMachine)) {
        rebased = { ...rebased, executionMachine: next.executionMachine };
    }
    if (!areAccountSettingsJsonValuesEqual(before.welcome, next.welcome)) {
        rebased = { ...rebased, welcome: next.welcome };
    }
    return rebased;
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Trusted editor snapshots only; external inputs are admitted by SettingStorageBinding instead. */
function rebase(current: unknown, before: unknown, next: unknown): unknown {
    if (areAccountSettingsJsonValuesEqual(before, next)) return current;
    if (!record(before) || !record(next)) return next;
    const result: Record<string, unknown> = record(current) ? { ...current } : {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(next)])) {
        if (areAccountSettingsJsonValuesEqual(before[key], next[key])) continue;
        if (!Object.hasOwn(next, key)) delete result[key];
        else result[key] = rebase(result[key], before[key], next[key]);
    }
    return result;
}
