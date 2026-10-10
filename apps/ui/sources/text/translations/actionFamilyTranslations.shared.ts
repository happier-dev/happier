import type { ActionIdFamilyV1 } from '@happier-dev/protocol';


import { fileContentSearchTranslationsEnglish as fileContentSearchTranslations } from './fileContentSearchTranslations.shared';


import { promptPickerTranslationsEnglish as promptPickerTranslations } from './promptPickerTranslations.shared';



export function translated(value: typeof english): typeof english {
    return value;
}



export const surfaceFamilyLabels = {
    observation: 'Waiting',
    capture_viewing: 'Captures',
    session_terminals: 'Session terminals',
    workspace_layout: 'Workspace layout',
    workspace_file_search: fileContentSearchTranslations.en.textInFiles,
    scope: 'Scope',
    connected_services_configuration: 'Connected accounts',
    boards: 'Boards',
    artifacts: 'Artifacts',
    settings_declarations: 'Settings',
    home_hub_layout: 'Home layout',
    machine_connection: 'Machine connections',
    session_organization_resources: 'Projects and tags',
    session_organization_move: 'Session organization',
    composer_ingress: 'Composer and uploads',
    list_reorder: 'Pending input and todos',
    todo_session_link: 'Todo sessions',
    widgets: 'Widgets',
    workflow_authoring: 'Workflow authoring',
    command_palette: 'Search',
    find: 'Find',
    prompt_picker: promptPickerTranslations.en.open,
    app_updates: 'App updates',
    notification_configuration: 'Notification settings',
};



export const english = {
    actionFamilies: {
        ...surfaceFamilyLabels,
        app_shell: 'Workspace',
        roles: 'Roles',
        launch_profiles: 'Launch profiles',
        discovery: 'Action discovery',
        computer: 'Computer control',
        artifact_access: 'Artifact sharing',
        workflows: 'Workflows',
        workflow_effects: 'Webhooks and commands',
        notifications: 'Notifications',
        machine_agent_install: 'Agent installs',
        machine_agent_sign_in: 'Agent sign-in',
        session_access: 'Session sharing',
        session_lifecycle: 'Session lifecycle',
        inventory: 'Machine inventory',
        messaging: 'Messaging',
        session_control: 'Session controls',
        intent_start: 'Reviews and delegation',
        review_comments: 'Review comments',
        subagent_registry: 'Subagents',
        execution_run_control: 'Background runs',
        session_targeting: 'Session targeting',
        session_follow: 'Following sessions',
        session_transcripts: 'Session transcripts',
        session_read_state: 'Read state',
        session_attention: 'Attention',
        session_board: 'Session board',
        session_discussion: 'Discussions',
        session_permissions: 'Session permissions',
        external_sessions: 'External sessions',
        voice_controls: 'Voice controls',
        current_ui_context: 'Current screen',
        companion_controls: 'Companion',
        memory: 'Memory',
        agent_acp_catalog: 'ACP agents',
        prompt_library: 'Prompt library',
        daemon_admin: 'Daemon administration',
        browser_control: 'Browser control',
        browser_diagnostics: 'Browser diagnostics',
        browser_context: 'Browser context',
        browser_automation: 'Browser automation',
        browser_recording: 'Browser recording',
        local_services_inventory: 'Local services',
        local_services_launcher: 'Service launcher',
        local_services_preview: 'Service previews',
        local_services_public_preview: 'Public previews',
        local_services_actions: 'Service actions',
        peer_mediation_observability: 'Connection diagnostics',
        devices_simulator: 'Simulators',
        approvals: 'Approvals',
        plugin_dev_loop: 'Plugin development',
        plugin_settings_administration: 'Plugin settings',
        plugin_permission_grants: 'Plugin permissions',
        plugin_webhooks: 'Plugin webhooks',
        account_plugin_data: 'Plugin data',
        account_sessions: 'Signed-in devices',
        account_security: 'Account security',
        account_api_tokens: 'API tokens',
        identity_github_apps: 'GitHub Apps',
        identity_providers: 'Sign-in providers',
        machine_pools: 'Machine pools',
        ephemeral_runner: 'Runners',
        automation_events: 'Automation events',
        automation_conversation: 'Automation conversations',
        scm_git: 'Git',
        scm_pull_request: 'Pull requests',
        scm_repository: 'Repositories',
        scm_diff_summary: 'Diff summaries',
        home_governance: 'Home administration',
        teams: 'Teams',
        saved_secret_sharing: 'Shared secrets',
    },
} satisfies { actionFamilies: Record<ActionIdFamilyV1, string> };


export const actionFamilyTranslationsEnglish = { en: english } as const;
