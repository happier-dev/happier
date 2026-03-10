import { buildBackendTargetKey } from '@happier-dev/protocol';
import { parsePermissionIntentAlias } from '@happier-dev/agents';
import { z } from 'zod';

import { AGENT_IDS, getAgentCore } from '@/agents/catalog/catalog';
import { CLAUDE_PERMISSION_MODES, CODEX_LIKE_PERMISSION_MODES, type PermissionMode } from '@/sync/domains/permissions/permissionTypes';

import { SessionTmuxMachineOverrideSchema } from '../registry/account/accountRuntimeSettingDefinitions';
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

    if (!('sessionDefaultPermissionModeByTargetKey' in input)) {
        const byTargetKey = next.sessionDefaultPermissionModeByTargetKey && typeof next.sessionDefaultPermissionModeByTargetKey === 'object'
            ? { ...(next.sessionDefaultPermissionModeByTargetKey as Record<string, PermissionMode>) }
            : {};
        const legacyByAgent = input.sessionDefaultPermissionModeByAgent;
        if (legacyByAgent && typeof legacyByAgent === 'object' && !Array.isArray(legacyByAgent)) {
            for (const agentId of AGENT_IDS) {
                const raw = (legacyByAgent as Record<string, unknown>)[agentId];
                if (typeof raw === 'string') {
                    byTargetKey[buildBackendTargetKey({ kind: 'builtInAgent', agentId })] = raw as PermissionMode;
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
        next.codexBackendMode = 'acp';
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
