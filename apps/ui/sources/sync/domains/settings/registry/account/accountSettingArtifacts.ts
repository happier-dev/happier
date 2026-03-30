import { buildSettingArtifacts, defineSettingDefinitions } from '@happier-dev/protocol';

import { ACCOUNT_ACTIONS_SETTING_DEFINITIONS } from './accountActionsSettingDefinitions';
import { ACCOUNT_BACKEND_SETTING_DEFINITIONS } from './accountBackendSettingDefinitions';
import { ACCOUNT_CONNECTED_SERVICES_SETTING_DEFINITIONS } from './accountConnectedServicesSettingDefinitions';
import { ACCOUNT_COLLECTION_SETTING_DEFINITIONS } from './accountCollectionSettingDefinitions';
import { ACCOUNT_CORE_SETTING_DEFINITIONS } from './accountCoreSettingDefinitions';
import { ACCOUNT_DISPLAY_SETTING_DEFINITIONS } from './accountDisplaySettingDefinitions';
import { ACCOUNT_FEATURE_TOGGLE_SETTING_DEFINITIONS } from './accountFeatureToggleSettingDefinitions';
import { ACCOUNT_LEGACY_SETTING_DEFINITIONS } from './accountLegacySettingDefinitions';
import { ACCOUNT_MCP_SETTING_DEFINITIONS } from './accountMcpSettingDefinitions';
import { ACCOUNT_PERMISSION_SETTING_DEFINITIONS } from './accountPermissionSettingDefinitions';
import { ACCOUNT_PROFILES_SETTING_DEFINITIONS } from './accountProfilesSettingDefinitions';
import { ACCOUNT_PROMPT_LIBRARY_SETTING_DEFINITIONS } from './accountPromptLibrarySettingDefinitions';
import { ACCOUNT_RUNTIME_SETTING_DEFINITIONS } from './accountRuntimeSettingDefinitions';
import { ACCOUNT_SCM_FILES_SETTING_DEFINITIONS } from './accountScmFilesSettingDefinitions';
import { ACCOUNT_SESSION_CREATION_SETTING_DEFINITIONS } from './accountSessionCreationSettingDefinitions';
import { ACCOUNT_SERVER_SELECTION_SETTING_DEFINITIONS } from './accountServerSelectionSettingDefinitions';
import { ACCOUNT_TRANSCRIPT_TOOL_SETTING_DEFINITIONS } from './accountTranscriptToolSettingDefinitions';
import { ACCOUNT_VOICE_SETTING_DEFINITIONS } from './accountVoiceSettingDefinitions';
import { ACCOUNT_WORKFLOW_SETTING_DEFINITIONS } from './accountWorkflowSettingDefinitions';

export const ACCOUNT_SETTING_DEFINITIONS = defineSettingDefinitions({
    ...ACCOUNT_ACTIONS_SETTING_DEFINITIONS,
    ...ACCOUNT_BACKEND_SETTING_DEFINITIONS,
    ...ACCOUNT_CONNECTED_SERVICES_SETTING_DEFINITIONS,
    ...ACCOUNT_COLLECTION_SETTING_DEFINITIONS,
    ...ACCOUNT_CORE_SETTING_DEFINITIONS,
    ...ACCOUNT_DISPLAY_SETTING_DEFINITIONS,
    ...ACCOUNT_FEATURE_TOGGLE_SETTING_DEFINITIONS,
    ...ACCOUNT_LEGACY_SETTING_DEFINITIONS,
    ...ACCOUNT_MCP_SETTING_DEFINITIONS,
    ...ACCOUNT_PERMISSION_SETTING_DEFINITIONS,
    ...ACCOUNT_PROFILES_SETTING_DEFINITIONS,
    ...ACCOUNT_PROMPT_LIBRARY_SETTING_DEFINITIONS,
    ...ACCOUNT_RUNTIME_SETTING_DEFINITIONS,
    ...ACCOUNT_SCM_FILES_SETTING_DEFINITIONS,
    ...ACCOUNT_SESSION_CREATION_SETTING_DEFINITIONS,
    ...ACCOUNT_SERVER_SELECTION_SETTING_DEFINITIONS,
    ...ACCOUNT_TRANSCRIPT_TOOL_SETTING_DEFINITIONS,
    ...ACCOUNT_VOICE_SETTING_DEFINITIONS,
    ...ACCOUNT_WORKFLOW_SETTING_DEFINITIONS,
});

export const ACCOUNT_SETTING_ARTIFACTS = buildSettingArtifacts(ACCOUNT_SETTING_DEFINITIONS);
