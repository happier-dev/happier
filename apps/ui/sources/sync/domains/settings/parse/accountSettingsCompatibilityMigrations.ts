import { buildBackendTargetKey, normalizeCodexBackendMode } from '@happier-dev/protocol';
import { parsePermissionIntentAlias, resolveClaudeUnifiedTerminalResponseLocations } from '@happier-dev/agents';
import { z } from 'zod';

import { AGENT_IDS, getAgentCore } from '@/agents/registry/registryCore';
import { CLAUDE_PERMISSION_MODES, CODEX_LIKE_PERMISSION_MODES, isPermissionMode, type PermissionMode } from '@/sync/domains/permissions/permissionTypes';

import { SessionTmuxMachineOverrideSchema } from '../registry/account/accountRuntimeSettingDefinitions';
import { TRANSCRIPT_MESSAGE_TIMESTAMP_DISPLAY_MODE_VALUES } from '../registry/account/accountTranscriptToolSettingDefinitions';
import { migrateAccountFeatureToggles } from './accountSettingsFeatureToggleMigration';
import { normalizeAccountSettingsServerSelection } from './accountSettingsServerSelectionNormalization';

export function applyAccountSettingsCompatibilityMigrations<TSettings extends Record<string, unknown>>(params: {
    input: Record<string, unknown>;
    settings: TSettings;
    inputSchemaVersion: number;
    supportedSchemaVersion: number;
}): TSettings {
    const { input, inputSchemaVersion, supportedSchemaVersion } = params;
    const next = { ...params.settings } as Record<string, unknown>;

    // Resolve before defaults hide whether an older account explicitly disabled the bridge.
    const claudeResponseLocations = resolveClaudeUnifiedTerminalResponseLocations(input);
    next.claudeUnifiedTerminalQuestionResponseLocation = claudeResponseLocations.question;
    next.claudeUnifiedTerminalPermissionResponseLocation = claudeResponseLocations.permission;

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
    // Development Herdr settings previously nested the host in the released
    // tmux map. Normalize retained input once; current writers only use the
    // additive top-level map, which older UI edits preserve.
    if (!('sessionTerminalHostByMachineId' in input)) {
        const legacyMap = input.sessionTmuxByMachineId;
        if (legacyMap && typeof legacyMap === 'object' && !Array.isArray(legacyMap)) {
            const hosts: Record<string, 'zellij' | 'herdr'> = {};
            for (const [machineId, value] of Object.entries(legacyMap)) {
                if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
                const host = (value as Record<string, unknown>).terminalHost;
                if (host === 'zellij' || host === 'herdr') hosts[machineId] = host;
            }
            next.sessionTerminalHostByMachineId = hosts;
        }
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

    if (next.transcriptListImplementation === 'flatlist_legacy') {
        next.transcriptListImplementation = 'flash_v2';
    }

    if (!('backendEnabledByTargetKey' in input)) {
        const byTargetKey = next.backendEnabledByTargetKey && typeof next.backendEnabledByTargetKey === 'object'
            ? { ...(next.backendEnabledByTargetKey as Record<string, boolean>) }
            : {};
        const legacyByAgent = input.backendEnabledById;
        if (legacyByAgent && typeof legacyByAgent === 'object' && !Array.isArray(legacyByAgent)) {
            for (const agentId of AGENT_IDS) {
                const raw = (legacyByAgent as Record<string, unknown>)[agentId];
                if (typeof raw === 'boolean') {
                    byTargetKey[buildBackendTargetKey({ kind: 'builtInAgent', agentId })] = raw;
                }
            }
        }
        next.backendEnabledByTargetKey = byTargetKey;
    }

    if (!('backendCliSourcePreferenceByTargetKey' in input)) {
        const byTargetKey = next.backendCliSourcePreferenceByTargetKey && typeof next.backendCliSourcePreferenceByTargetKey === 'object'
            ? { ...(next.backendCliSourcePreferenceByTargetKey as Record<string, 'system-first' | 'managed-first'>) }
            : {};
        const legacyByAgent = input.backendCliSourcePreferenceById;
        if (legacyByAgent && typeof legacyByAgent === 'object' && !Array.isArray(legacyByAgent)) {
            for (const agentId of AGENT_IDS) {
                const raw = (legacyByAgent as Record<string, unknown>)[agentId];
                if (raw === 'system-first' || raw === 'managed-first') {
                    byTargetKey[buildBackendTargetKey({ kind: 'builtInAgent', agentId })] = raw;
                }
            }
        }
        next.backendCliSourcePreferenceByTargetKey = byTargetKey;
    }

    if (!('sessionDefaultPermissionModeByTargetKey' in input)) {
        const byTargetKey = next.sessionDefaultPermissionModeByTargetKey && typeof next.sessionDefaultPermissionModeByTargetKey === 'object'
            ? { ...(next.sessionDefaultPermissionModeByTargetKey as Record<string, PermissionMode>) }
            : {};
        const legacyByAgent = input.sessionDefaultPermissionModeByAgent;
        if (legacyByAgent && typeof legacyByAgent === 'object' && !Array.isArray(legacyByAgent)) {
            for (const agentId of AGENT_IDS) {
                const raw = (legacyByAgent as Record<string, unknown>)[agentId];
                if (isPermissionMode(raw)) {
                    const group = getAgentCore(agentId).permissions.modeGroup;
                    const allowed = group === 'codexLike' ? CODEX_LIKE_PERMISSION_MODES : CLAUDE_PERMISSION_MODES;
                    if (!(allowed as readonly string[]).includes(raw)) continue;
                    byTargetKey[buildBackendTargetKey({ kind: 'builtInAgent', agentId })] = raw;
                }
            }
        }
        if (typeof input.lastUsedPermissionMode === 'string') {
            const parsed = parsePermissionIntentAlias(input.lastUsedPermissionMode);
            if (parsed) {
                const seededMode: PermissionMode = parsed === 'plan' ? 'read-only' : parsed;
                for (const to of AGENT_IDS) {
                    const group = getAgentCore(to).permissions.modeGroup;
                    const allowed = group === 'codexLike' ? CODEX_LIKE_PERMISSION_MODES : CLAUDE_PERMISSION_MODES;
                    byTargetKey[buildBackendTargetKey({ kind: 'builtInAgent', agentId: to })] =
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
            for (const agentId of AGENT_IDS) {
                const raw = (legacyByAgent as Record<string, unknown>)[agentId];
                if (raw === 'direct' || raw === 'persisted') {
                    byTargetKey[buildBackendTargetKey({ kind: 'builtInAgent', agentId })] = raw;
                }
            }
        }
        next.newSessionDefaultPersistenceModeByTargetKeyV1 = byTargetKey;
    }

    if (inputSchemaVersion < 6) {
        const migrated = normalizeCodexBackendMode(input.codexBackendMode);
        if (migrated) {
            next.codexBackendMode = migrated;
        } else if (!normalizeCodexBackendMode(next.codexBackendMode)) {
            next.codexBackendMode = 'appServer';
        }
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

    if (inputSchemaVersion < 7 && next.alwaysShowContextSize === false) {
        next.alwaysShowContextSize = true;
    }

    if (inputSchemaVersion < 8 && next.avatarStyle === 'brutalist') {
        next.avatarStyle = 'meshGradientColumns';
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
