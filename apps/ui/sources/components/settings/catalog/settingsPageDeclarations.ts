import { ACCOUNT_SETTINGS } from '@/components/settings/account/accountSettings';
import { ACCOUNT_SECURITY_SETTINGS } from '@/components/settings/account/accountSecuritySettings';
import { API_TOKEN_SETTINGS } from '@/components/settings/apiTokens/apiTokensSettings';
import { EMBED_SETTINGS } from '@/components/settings/embeds/embedsSettings';
import { APPEARANCE_SETTINGS } from '@/components/settings/appearance/appearanceSettings';
import { THEMES_SETTINGS } from '@/components/settings/appearance/themeProfiles/themesSettings';
import { SESSION_SETTINGS } from '@/components/settings/session/sessionSettings';
import { SESSION_RUNTIME_SETTINGS } from '@/components/settings/session/sessionRuntimeSettings';
import { SESSION_PROVIDER_LIMITS_SETTINGS } from '@/components/settings/session/sessionProviderLimitsSettings';
import { NEW_SESSION_WIZARD_SETTINGS } from '@/components/settings/session/newSessionWizardSettings';
import { SESSION_COMPOSER_SETTINGS } from '@/components/settings/session/sessionComposerSettings';
import { SESSION_RESUME_SETTINGS } from '@/components/settings/session/sessionResumeSettings';
import { TRANSCRIPT_ADVANCED_SETTINGS } from '@/components/settings/session/transcriptAdvancedSettings';
import { MACHINES_ADD_SETTINGS } from '@/components/settings/machines/machinesAddSettings';
import { MACHINES_DEFAULTS_SETTINGS } from '@/components/settings/machines/machinesDefaultsSettings';
import { MACHINES_THIS_COMPUTER_SETTINGS } from '@/components/settings/machines/machinesThisComputerSettings';
import { REMOTE_HOSTS_ACCESS_SETTINGS, REMOTE_HOSTS_SETTINGS } from '@/components/settings/remoteHosts/remoteHostsSettings';
import { KEYBOARD_SETTINGS } from '@/components/settings/keyboard/keyboardSettings';
import { PETS_SETTINGS } from '@/components/settings/pets/petsSettings';
import { FEATURES_SETTINGS } from '@/components/settings/features/featuresSettings';
import { LANGUAGE_SETTINGS } from '@/components/settings/language/languageSettings';
import { DESKTOP_SETTINGS } from '@/components/settings/desktop/desktopSettings';
import { SUB_AGENT_SETTINGS } from '@/components/settings/subAgent/subAgentSettings';
import { PROFILES_SETTINGS } from '@/components/settings/profiles/profilesSettings';
import { PROVIDERS_SETTINGS } from '@/components/settings/providers/providersSettings';
import { DELEGATION_SETTINGS } from '@/components/settings/delegation/delegationSettings';
import { MCP_ON_MACHINE_SETTINGS, MCP_PREVIEW_SETTINGS } from '@/components/settings/mcpServers/mcpSettings';
import { PLUGINS_SETTINGS } from '@/components/settings/plugins/pluginsSettings';
import { PROMPTS_SETTINGS } from '@/components/settings/prompts/promptsSettings';
import { PROMPTS_CONTEXT_SETTINGS } from '@/components/settings/prompts/context/promptsContextSettings';
import { MEMORY_SETTINGS } from '@/components/settings/memory/memorySettings';
import { SEARCH_SETTINGS } from '@/components/settings/search/searchSettings';
import { ACTIONS_CREATE_SESSION_SETTINGS, ACTIONS_PROMPT_DOCUMENT_SETTINGS } from '@/components/settings/actions/actionsSettings';
import { EXTERNAL_SESSIONS_SETTINGS } from '@/components/settings/externalSessions/externalSessionsSettings';
import { TRANSCRIPT_SETTINGS } from '@/components/settings/session/transcriptSettings';
import { PERMISSIONS_SETTINGS } from '@/components/settings/session/permissionsSettings';
import { HANDOFF_SETTINGS } from '@/components/settings/session/handoffSettings';
import { TOOL_RENDERING_SETTINGS } from '@/components/settings/session/toolRenderingSettings';
import { SOURCE_CONTROL_SETTINGS } from '@/components/settings/sourceControl/sourceControlSettings';
import { HOMES_ADD_SETTINGS, SERVERS_SETTINGS } from '@/components/settings/server/serverSettings';
import { SYSTEM_STATUS_SETTINGS } from '@/components/settings/systemStatus/systemStatusSettings';
import { NOTIFICATIONS_SETTINGS } from '@/components/settings/notifications/notificationsSettings';
import { NOTIFICATIONS_PUSH_SETTINGS } from '@/components/settings/notifications/notificationsPushSettings';
import { DIAGNOSIS_SETTINGS } from '@/components/settings/diagnosis/diagnosisSettings';
import { ATTACHMENTS_SETTINGS } from '@/components/settings/attachments/attachmentsSettings';
import { OVERVIEW_SETTINGS } from '@/components/settings/overview/overviewSettings';
import { USAGE_SETTINGS } from '@/components/settings/usage/usageSettings';
import { WORKFLOW_RUN_SETTINGS } from '@/components/automations/settings/workflowRunSettings';
import {
    HOME_GITHUB_APP_EDITOR_SETTINGS,
    HOME_GITHUB_APP_SETTINGS,
    HOME_IDENTITY_PROVIDER_SETTINGS,
    HOME_MANAGED_OIDC_SETTINGS,
    TEAM_GITHUB_APP_EDITOR_SETTINGS,
    TEAM_GITHUB_APP_SETTINGS,
    TEAM_MANAGED_OIDC_SETTINGS,
} from '@/components/settings/identity/identitySettings';
import { CONNECTED_SERVICES_SETTINGS, CONNECTED_SERVICES_USAGE_GAUGE_SETTINGS } from '@/components/settings/connectedServices/connectedServicesSettings';
import { TEAM_AUTHENTICATION_SETTINGS, TEAM_IDENTITY_CONNECTION_SETTINGS, HOME_IDENTITY_CONNECTION_SETTINGS, TEAM_WORKOS_SETUP_SETTINGS, HOME_WORKOS_SETUP_SETTINGS } from '@/components/settings/teams/identity/teamAuthenticationSettings';
import { DIRECTORY_SETTINGS, DIRECTORY_SOURCE_SETTINGS } from '@/components/settings/teams/identity/directorySettings';
import { HOME_AUTHENTICATION_SETTINGS } from '@/components/settings/home/governance/homeAuthenticationSettings';
import { HOME_DATA_SETTINGS } from '@/components/settings/home/governance/homeDataSettings';
import { HOME_EMAIL_SETTINGS } from '@/components/settings/home/governance/homeEmailSettings';
import { HOME_REACH_SETTINGS } from '@/components/settings/home/governance/homeReachSettings';
import { HOME_FEATURE_SETTINGS } from '@/components/settings/home/governance/homeFeatureSettings';
import { HOME_OVERVIEW_SETTINGS } from '@/components/settings/home/governance/homeOverviewSettings';
import { HOME_SERVER_SETTINGS } from '@/components/settings/home/governance/homeServerSettings';
import { HOME_SIGN_IN_PROVIDERS_SETTINGS } from '@/components/settings/home/signInProviders/homeSignInProvidersSettings';
import { HOME_TEAMS_POLICY_SETTINGS } from '@/components/settings/home/governance/homeTeamsPolicySettings';
import {
    VOICE_ADVANCED_SETTINGS,
    VOICE_CONVERSATIONS_SETTINGS,
    VOICE_DICTATION_SETTINGS,
    VOICE_PRIVACY_SETTINGS,
    projectVoiceSettingsPageDeclarations,
} from '@/voice/settings/voiceSettingsDeclarations';

import type { SettingsPageDeclaration } from './settingDeclarations';
import { getVoiceContributedSettingsDeclarations, voiceSettingsDeclarationRegistry } from '@/voice/settings/voiceContributedSettingsDeclarations';
import type { PluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import type { Settings } from '@/sync/domains/settings/settings';

/**
 * Every page that declares its settings for search. A page joins by adding its declaration here;
 * the catalog only offers a page's settings while the page itself is visible (feature gates apply).
 */
export const SETTINGS_PAGE_DECLARATIONS: readonly SettingsPageDeclaration[] = [
    OVERVIEW_SETTINGS,
    USAGE_SETTINGS,
    WORKFLOW_RUN_SETTINGS,
    HOME_MANAGED_OIDC_SETTINGS,
    HOME_AUTHENTICATION_SETTINGS,
    HOME_TEAMS_POLICY_SETTINGS,
    HOME_REACH_SETTINGS,
    HOME_EMAIL_SETTINGS,
    HOME_FEATURE_SETTINGS,
    HOME_DATA_SETTINGS,
    HOME_SERVER_SETTINGS,
    HOME_OVERVIEW_SETTINGS,
    HOME_SIGN_IN_PROVIDERS_SETTINGS,
    HOME_IDENTITY_PROVIDER_SETTINGS,
    TEAM_MANAGED_OIDC_SETTINGS,
    HOME_GITHUB_APP_SETTINGS,
    TEAM_GITHUB_APP_SETTINGS,
    HOME_GITHUB_APP_EDITOR_SETTINGS,
    TEAM_GITHUB_APP_EDITOR_SETTINGS,
    TEAM_AUTHENTICATION_SETTINGS,
    TEAM_IDENTITY_CONNECTION_SETTINGS,
    DIRECTORY_SETTINGS,
    DIRECTORY_SOURCE_SETTINGS,
    HOME_IDENTITY_CONNECTION_SETTINGS,
    TEAM_WORKOS_SETUP_SETTINGS,
    HOME_WORKOS_SETUP_SETTINGS,
    ACCOUNT_SETTINGS,
    ACCOUNT_SECURITY_SETTINGS,
    API_TOKEN_SETTINGS,
    EMBED_SETTINGS,
    APPEARANCE_SETTINGS,
    THEMES_SETTINGS,
    SESSION_SETTINGS,
    SESSION_RUNTIME_SETTINGS,
    SESSION_PROVIDER_LIMITS_SETTINGS,
    NEW_SESSION_WIZARD_SETTINGS,
    SESSION_COMPOSER_SETTINGS,
    SESSION_RESUME_SETTINGS,
    MACHINES_ADD_SETTINGS,
    MACHINES_DEFAULTS_SETTINGS,
    MACHINES_THIS_COMPUTER_SETTINGS,
    REMOTE_HOSTS_SETTINGS,
    REMOTE_HOSTS_ACCESS_SETTINGS,
    KEYBOARD_SETTINGS,
    PETS_SETTINGS,
    FEATURES_SETTINGS,
    LANGUAGE_SETTINGS,
    DESKTOP_SETTINGS,
    SUB_AGENT_SETTINGS,
    PROFILES_SETTINGS,
    PROVIDERS_SETTINGS,
    DELEGATION_SETTINGS,
    MCP_ON_MACHINE_SETTINGS,
    MCP_PREVIEW_SETTINGS,
    PLUGINS_SETTINGS,
    MEMORY_SETTINGS,
    SEARCH_SETTINGS,
    ACTIONS_CREATE_SESSION_SETTINGS,
    ACTIONS_PROMPT_DOCUMENT_SETTINGS,
    EXTERNAL_SESSIONS_SETTINGS,
    PROMPTS_SETTINGS,
    PROMPTS_CONTEXT_SETTINGS,
    TRANSCRIPT_SETTINGS,
    TRANSCRIPT_ADVANCED_SETTINGS,
    PERMISSIONS_SETTINGS,
    HANDOFF_SETTINGS,
    TOOL_RENDERING_SETTINGS,
    SOURCE_CONTROL_SETTINGS,
    SERVERS_SETTINGS,
    HOMES_ADD_SETTINGS,
    SYSTEM_STATUS_SETTINGS,
    NOTIFICATIONS_SETTINGS,
    NOTIFICATIONS_PUSH_SETTINGS,
    DIAGNOSIS_SETTINGS,
    ATTACHMENTS_SETTINGS,
    CONNECTED_SERVICES_SETTINGS,
    CONNECTED_SERVICES_USAGE_GAUGE_SETTINGS,
    VOICE_DICTATION_SETTINGS,
    VOICE_CONVERSATIONS_SETTINGS,
    VOICE_PRIVACY_SETTINGS,
    VOICE_ADVANCED_SETTINGS,
];

/** Static host declarations plus fields from the one currently admitted Voice registry. */
export function getSettingsPageDeclarations(localize?: PluginLocalizedTextResolver, settings?: Pick<Settings, 'voice'>): readonly SettingsPageDeclaration[] {
    const host = settings ? projectVoiceSettingsPageDeclarations(SETTINGS_PAGE_DECLARATIONS, settings.voice, voiceSettingsDeclarationRegistry) : SETTINGS_PAGE_DECLARATIONS;
    return [...host, ...getVoiceContributedSettingsDeclarations(undefined, localize)];
}
