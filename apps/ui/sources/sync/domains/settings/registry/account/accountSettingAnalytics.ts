import {
    ACCOUNT_SETTING_DEFINITIONS,
    type AccountSettingKey,
    type SettingDefinition,
    type SettingDefinitionMap,
} from '@happier-dev/protocol';

import type { AnalyticsSettingArtifacts } from '@/track/settingsAnalytics/analyticsSettingArtifacts';

import { ACCOUNT_ACTIONS_SETTING_ANALYTICS } from './accountActionsSettingDefinitions';
import { ACCOUNT_BACKEND_SETTING_ANALYTICS } from './accountBackendSettingDefinitions';
import { ACCOUNT_CODING_PROMPT_BEHAVIOR_SETTING_ANALYTICS } from './accountCodingPromptBehaviorSettingDefinitions';
import { ACCOUNT_COLLECTION_SETTING_ANALYTICS } from './accountCollectionSettingDefinitions';
import { ACCOUNT_CONNECTED_SERVICES_SETTING_ANALYTICS } from './accountConnectedServicesSettingDefinitions';
import { ACCOUNT_CORE_SETTING_ANALYTICS } from './accountCoreSettingDefinitions';
import { ACCOUNT_DISPLAY_SETTING_ANALYTICS } from './accountDisplaySettingDefinitions';
import { ACCOUNT_KEYBOARD_SHORTCUT_SETTING_ANALYTICS } from './accountKeyboardShortcutSettingDefinitions';
import { ACCOUNT_MACHINE_ADMINISTRATION_SETTING_ANALYTICS } from './accountMachineAdministrationSettingDefinitions';
import { ACCOUNT_MCP_SETTING_ANALYTICS } from './accountMcpSettingDefinitions';
import { ACCOUNT_PERMISSION_SETTING_ANALYTICS } from './accountPermissionSettingDefinitions';
import { ACCOUNT_PET_SETTING_ANALYTICS } from './accountPetSettingDefinitions';
import { ACCOUNT_PROFILES_SETTING_ANALYTICS } from './accountProfilesSettingDefinitions';
import { ACCOUNT_PROMPT_LIBRARY_SETTING_ANALYTICS } from './accountPromptLibrarySettingDefinitions';
import { ACCOUNT_PROVIDER_SETTING_ANALYTICS } from './accountProviderSettingDefinitions';
import { ACCOUNT_REMOTE_HOSTS_SETTING_ANALYTICS } from './accountRemoteHostsSettingDefinitions';
import { ACCOUNT_RUNTIME_SETTING_ANALYTICS } from './accountRuntimeSettingDefinitions';
import { ACCOUNT_SCM_FILES_SETTING_ANALYTICS } from './accountScmFilesSettingDefinitions';
import { mergeAccountSettingAnalytics } from './accountSettingAnalyticsPresentation';
import { ACCOUNT_TRANSCRIPT_TOOL_SETTING_ANALYTICS } from './accountTranscriptToolSettingDefinitions';
import { ACCOUNT_VOICE_SETTING_ANALYTICS } from './accountVoiceSettingAnalytics';
import { ACCOUNT_WORKFLOW_SETTING_ANALYTICS } from './accountWorkflowSettingDefinitions';
import { ACCOUNT_WORKSPACE_FILE_VIEWER_SETTING_ANALYTICS } from './accountWorkspaceFileViewerSettingDefinitions';

/**
 * Presentation-only metadata keyed by Protocol-owned Account setting definitions. Voice contributes
 * a serializer-only overlay while its persistence artifacts remain Protocol-owned.
 */
export const ACCOUNT_SETTING_ANALYTICS = mergeAccountSettingAnalytics(
    ACCOUNT_ACTIONS_SETTING_ANALYTICS,
    ACCOUNT_BACKEND_SETTING_ANALYTICS,
    ACCOUNT_CODING_PROMPT_BEHAVIOR_SETTING_ANALYTICS,
    ACCOUNT_COLLECTION_SETTING_ANALYTICS,
    ACCOUNT_CONNECTED_SERVICES_SETTING_ANALYTICS,
    ACCOUNT_CORE_SETTING_ANALYTICS,
    ACCOUNT_DISPLAY_SETTING_ANALYTICS,
    ACCOUNT_KEYBOARD_SHORTCUT_SETTING_ANALYTICS,
    ACCOUNT_MACHINE_ADMINISTRATION_SETTING_ANALYTICS,
    ACCOUNT_MCP_SETTING_ANALYTICS,
    ACCOUNT_PERMISSION_SETTING_ANALYTICS,
    ACCOUNT_PET_SETTING_ANALYTICS,
    ACCOUNT_PROFILES_SETTING_ANALYTICS,
    ACCOUNT_PROMPT_LIBRARY_SETTING_ANALYTICS,
    ACCOUNT_PROVIDER_SETTING_ANALYTICS,
    ACCOUNT_REMOTE_HOSTS_SETTING_ANALYTICS,
    ACCOUNT_RUNTIME_SETTING_ANALYTICS,
    ACCOUNT_SCM_FILES_SETTING_ANALYTICS,
    ACCOUNT_TRANSCRIPT_TOOL_SETTING_ANALYTICS,
    ACCOUNT_VOICE_SETTING_ANALYTICS,
    ACCOUNT_WORKFLOW_SETTING_ANALYTICS,
    ACCOUNT_WORKSPACE_FILE_VIEWER_SETTING_ANALYTICS,
);

function buildAccountSettingAnalyticsArtifacts(): AnalyticsSettingArtifacts<SettingDefinitionMap> {
    const definitions: Record<string, SettingDefinition> = {};
    const trackedCurrentStateDefinitions: Record<string, SettingDefinition> = {};
    const trackedChangeDefinitions: Record<string, SettingDefinition> = {};
    const trackedDerivedDefinitions: Record<string, SettingDefinition> = {};

    for (const key of Object.keys(ACCOUNT_SETTING_ANALYTICS) as AccountSettingKey[]) {
        const analytics = ACCOUNT_SETTING_ANALYTICS[key];
        if (!analytics) continue;

        const definition: SettingDefinition = {
            ...ACCOUNT_SETTING_DEFINITIONS[key],
            analytics,
        };
        definitions[key] = definition;
        if (analytics.trackCurrentState) {
            trackedCurrentStateDefinitions[key] = definition;
        }
        if (analytics.trackChanges) {
            trackedChangeDefinitions[key] = definition;
        }
        if (analytics.serializeDerivedProperties || analytics.serializeDerivedPropertiesWithContext) {
            trackedDerivedDefinitions[key] = definition;
        }
    }

    return {
        definitions,
        trackedCurrentStateDefinitions,
        trackedChangeDefinitions,
        trackedDerivedDefinitions,
    };
}

/**
 * Derived projection for analytics consumers only. It attaches UI metadata to Protocol
 * definitions, but deliberately has no schema shape or defaults and cannot back persistence.
 */
export const ACCOUNT_SETTING_ANALYTICS_ARTIFACTS = buildAccountSettingAnalyticsArtifacts();
