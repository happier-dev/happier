import { lazyZodSchema } from '../lazyZodSchema.js';
import { CODE_INTELLIGENCE_ACTION_IDS } from './codeIntelligenceActionFamily.js';
import { z } from 'zod/mini';
import { MACHINE_ADD_SSH_ACTION_IDS, MACHINE_PAGE_ACTION_IDS } from './specs/machineConnectionActionIdsV1.js';
import { LOCAL_DAEMON_SERVICE_ACTION_IDS } from './specs/localDaemonServiceActionIdsV1.js';
import { USAGE_ACTION_IDS, USAGE_COACH_ACTION_IDS } from '../usage/usageActionIdsV1.js';
import { MACHINE_ACCESS_ACTION_IDS, MACHINE_WORK_SUMMARY_ACTION_IDS } from './specs/machine/accessActionIdsV1.js';
import { MACHINE_VITALS_ACTION_IDS } from './specs/machineVitalsActionIdsV1.js';
import { MACHINE_PROCESSES_ACTION_IDS } from './specs/machineProcessesActionIdsV1.js';
import { MACHINE_STORAGE_ACTION_IDS } from './specs/storageActionIdsV1.js';
import { MACHINE_RESOURCES_ACTION_IDS } from './specs/machineResourcesActionIdsV1.js';
import { MACHINE_GUARD_ACTION_IDS } from '../machines/guard/actionIdsV1.js';
import { MACHINE_TERMINAL_ACTION_IDS } from './specs/machineTerminalActionIdsV1.js';
import { SCOPE_ACTION_IDS } from './scopeActionFamily.js';
import { DIAGNOSTICS_ACTION_IDS } from './diagnosticsActionFamily.js';
import { ROLE_ACTION_IDS_V1 } from '../prompts/roles/roleActionIdsV1.js';
import { WORK_BOARD_ACTION_IDS_V1 } from '../boards/actionIdsV1.js';
import { VOICE_CONVERSATION_ACTION_IDS } from './voiceConversationActionFamily.js';
import { PROJECT_SOURCE_ACTION_IDS_V1 } from './specs/projectSourcesActionIdsV1.js';

import { HOME_GOVERNANCE_ACTION_IDS_V1 } from '../home/governance/actionsV1.js';
import { HOME_IDENTITY_ACTION_IDS_V1 } from '../teams/identity/actionIds.js';
import { PLUGIN_SETTINGS_ADMINISTRATION_ACTION_IDS_V1 } from '../plugins/settingsAdministration.js';
import { PLUGIN_WEBHOOK_ACTION_IDS_V1 } from '../plugins/webhooks/endpointV1.js';
import { PLUGIN_EXECUTION_ORIGIN_ACTION_IDS } from './pluginExecutionOriginActionFamily.js';
import { NPM_REGISTRY_PROFILE_ACTION_IDS_V1 } from './npmRegistryProfileActionIds.js';
import { PLUGIN_ACCOUNT_ADMINISTRATION_ACTION_IDS } from './pluginAccountAdministrationActionIds.js';
import { SESSION_BOARD_ACTION_IDS_V1 } from '../sessions/board/actionIds.js';
import { DISCUSSION_ACTION_IDS_V1 } from '../discussions/actionIds.js';
import { SESSION_READ_STATE_ACTION_IDS_V1 } from '../sessions/readState/actionIds.js';
import { SESSION_ATTENTION_SET_ACTION_ID } from '../sessions/organization/attentionAction.js';
import { MACHINE_POOL_ACTION_IDS_V1 } from '../machines/pools/actionsV1.js';
import { MANAGED_MACHINE_ACTION_IDS_V1 } from '../machines/managed/actionIdsV1.js';
import { MACHINE_PRESET_ACTION_IDS_V1 } from '../machines/managed/machinePresetActionIdsV1.js';
import { PROJECT_WORKER_ACTION_IDS_V1 } from './specs/projectWorkersActionIdsV1.js';
import { ACTION_OPERATION_ACTION_IDS_V1 } from './operations/actionIdsV1.js';
import { TEAM_ACTION_IDS_V1 } from '../teams/actionsV1.js';
import { MANAGED_GITHUB_APP_ACTION_IDS_V1 } from '../identity/githubApps.js';
import { MANAGED_IDENTITY_PROVIDER_ACTION_IDS_V1 } from '../identity/providers.js';
import { EPHEMERAL_RUNNER_ACTION_IDS_V1 } from '../ephemeralRunner/actionIdsV1.js';
import { AUTOMATION_OCCURRENCE_ACTION_IDS } from '../automations/occurrenceActionIds.js';
import { SHARED_SAVED_SECRET_ACTION_IDS_V1 } from '../account/settings/savedSecretResourceActionIdsV1.js';
import { PERSONAL_SAVED_SECRET_ACTION_IDS_V1 } from '../account/settings/personalSavedSecretActionsV1.js';
import { ARTIFACT_ACCESS_ACTION_IDS_V1 } from '../artifacts/artifactAccessV1.js';
import { ARTIFACT_ACTION_IDS_V1 } from '../artifacts/artifactActionIdsV1.js';
import { DOC_COLLABORATION_ACTION_IDS_V1 } from '../artifacts/artifactCollaborationActionIdsV1.js';
import { WORKSPACE_ACTION_IDS } from './workspaceActionFamily.js';
import { PROJECT_ACTION_IDS_V1 } from './projectActionIdsV1.js';
import { PROJECT_DEFINITION_ACTION_IDS } from './projectDefinitionActionFamily.js';
import { CONNECTED_SERVICE_CONFIGURATION_ACTION_IDS_V1 } from '../connect/configurationActionIdsV1.js';
import { SETTINGS_DECLARATION_ACTION_IDS_V1 } from './settingsDeclarationActionFamily.js';
import { ACTION_POLICY_ACTION_IDS } from './actionPolicyActionIds.js';
import { APP_SHELL_ACTION_IDS } from './appShellActionFamily.js';
import { SESSION_TERMINAL_ACTION_IDS } from './sessionTerminalActionFamily.js';
import { SESSION_AGENT_TRANSITION_ACTION_IDS } from './sessionAgentTransitionActionFamily.js';
import { NOTIFICATION_CONFIGURATION_ACTION_IDS } from './notificationConfigurationActionIds.js';
import { APP_UPDATE_ACTION_IDS } from './appUpdateActionFamily.js';
import { BUG_REPORT_SUBMISSION_ACTION_IDS } from './specs/bugReportActionIdsV1.js';
import { UPDATES_ACTION_IDS } from './updatesActionFamily.js';
import { CLIPBOARD_ACTION_IDS } from './clipboardActionFamily.js';
import { WIDGET_INSTANCE_ACTION_IDS_V1 } from '../widgets/actionIdsV1.js';
import { WIDGET_DEFINITION_ACTION_IDS_V1 } from '../widgets/definitionActionIdsV1.js';
import { WIDGET_LAYOUT_FRAGMENT_ACTION_IDS_V1 } from '../widgets/fragmentActionIdsV1.js';
import { WORKFLOW_EFFECT_ACTION_IDS_V1 } from '../workflows/workflowEffectActionIdsV1.js';
import { FILESYSTEM_ACTION_IDS } from './filesystemActionFamily.js';
import { PROFILE_ACTION_IDS_V1 } from '../profiles/profileActionIdsV1.js';
import { MCP_SERVER_ACTION_IDS_V1 } from '../mcp/servers/serverActionIdsV1.js';
import { CAPABILITY_RULES_ACTION_IDS_V1 } from './capabilityRulesActionIdsV1.js';
import { SESSION_CAPABILITIES_ACTION_IDS_V1 } from './sessionCapabilitiesActionIdsV1.js';
import { SKILL_ACTION_IDS_V1 } from '../prompts/library/skills/skillActionIdsV1.js';
import { PROVIDER_ACTION_IDS_V1 } from '../providers/providerActionIdsV1.js';
import { REMOTE_HOST_ACTION_IDS_V1 } from '../remoteHosts/remoteHostActionIdsV1.js';
import { HOME_RUNTIME_ACTION_IDS_V1 } from '../home/runtime/actionIdsV1.js';
import { ACCOUNT_LIFECYCLE_ACTION_IDS } from './accountLifecycleActionFamily.js';
import { ARTIFACT_FOLDER_ACTION_IDS_V1 } from '../prompts/library/artifactFolderActionIdsV1.js';
import { USAGE_SOURCE_ACTION_IDS } from '../usage/usageSources.js';
import { WORKFLOW_AUTHORING_ACTION_IDS } from './workflowAuthoringActionIds.js';
import { PROMPT_INVOCATION_ACTION_IDS } from './promptInvocationActionIds.js';
import { PUBLIC_PROFILE_ACTION_IDS_V1 } from '../account/publicProfileActionIds.js';

export const WORKFLOW_ACTION_IDS_V1 = [
  'workflow.validate', 'workflow.run.start', 'workflow.run.list', 'workflow.run.summaries', 'workflow.run.get', 'workflow.run.wait',
  'workflow.run.pause', 'workflow.run.resume', 'workflow.run.cancel', 'workflow.run.invocations.list',
  'workflow.run.invocations.get', 'workflow.run.invocations.retry', 'workflow.run.delete',
  'workflow.run.invocations.publish_draft', 'workflow.run.invocations.complete_review',
  'workflow.definition.list', 'workflow.definition.get', 'workflow.definition.create',
  'workflow.definition.update', 'workflow.definition.edit', 'workflow.definition.delete',
  'workflow.definition.import', 'workflow.definition.export', 'workflow.definition.capture',
  'workflow.trigger.list', 'workflow.trigger.add', 'workflow.trigger.update', 'workflow.trigger.remove',
  'workflow.trigger.run_now',
  'session.trigger.list', 'session.trigger.add', 'session.trigger.update', 'session.trigger.remove',
] as const;
export type WorkflowActionIdV1 = typeof WORKFLOW_ACTION_IDS_V1[number];
export const WorkflowActionIdV1Schema = lazyZodSchema(() => z.enum(WORKFLOW_ACTION_IDS_V1));

/**
 * The closed host Action vocabulary for the public plugin-authoring journey.
 * These operations project existing CLI/daemon owners; they do not make
 * plugin authoring a second command dispatcher.
 */
export const PLUGIN_DEV_LOOP_ACTION_IDS_V1 = [
  'plugins.scaffold',
  'plugins.install',
  'plugins.uninstall',
  'plugins.enable',
  'plugins.disable',
  'plugins.rollback',
  'plugins.trust.forget',
  'plugins.update_policy.set',
  'plugins.dev.submit',
  'plugins.dev.unregister',
  'plugins.dev.install',
  'plugins.dev.typecheck',
  'plugins.dev.build',
  'plugins.dev.test',
  'plugins.doctor',
  'plugins.pack',
  'plugins.reload',
  'plugins.list',
  'plugins.change.status',
] as const;
export type PluginDevLoopActionIdV1 = typeof PLUGIN_DEV_LOOP_ACTION_IDS_V1[number];

export function isPluginDevLoopActionIdV1(value: string): value is PluginDevLoopActionIdV1 {
  return (PLUGIN_DEV_LOOP_ACTION_IDS_V1 as readonly string[]).includes(value);
}

// B8 closure note:
// Action ids remain protocol-owned and closed in this wave.
// Plugin/runtime unification must not imply plugin-defined action-id authoring parity yet.
export const ACTION_ID_FAMILIES_V1 = Object.freeze({
  registries: REGISTRY_ACTION_IDS_V1,
  personal_saved_secrets: PERSONAL_SAVED_SECRET_ACTION_IDS_V1,
  plugin_execution_origin: PLUGIN_EXECUTION_ORIGIN_ACTION_IDS,
  npm_registry_profiles: NPM_REGISTRY_PROFILE_ACTION_IDS_V1,
  plugin_account_administration: PLUGIN_ACCOUNT_ADMINISTRATION_ACTION_IDS,
  usage: [...USAGE_ACTION_IDS, ...USAGE_COACH_ACTION_IDS],
  project_sources: PROJECT_SOURCE_ACTION_IDS_V1,
  project_execution: PROJECT_ACTION_IDS_V1,
  project_definitions: PROJECT_DEFINITION_ACTION_IDS,
  observation: ['wait'],
  account_profile: ['account.profile.get', 'account.name.set', 'account.username.set', 'account.username.check', 'account.username.release', ...PUBLIC_PROFILE_ACTION_IDS_V1],
  friends: ['friends.add', 'friends.remove'],
  project_workers: PROJECT_WORKER_ACTION_IDS_V1,
  operation_output: ACTION_OPERATION_ACTION_IDS_V1,
  capture_viewing: ['capture.view'],
  session_terminals: SESSION_TERMINAL_ACTION_IDS,
  session_agent_transition: SESSION_AGENT_TRANSITION_ACTION_IDS,
  workspace_layout: WORKSPACE_ACTION_IDS,
  session_organization_move: ['session.organization.move', 'session.organization.pin.set'],
  composer_ingress: ['composer.transaction.apply', 'composer.attachments.pick', 'repository.upload.pick'],
  list_reorder: ['session.pending.reorder', 'tasks.internal.reorder'],
  todo_session_link: ['tasks.internal.session.link'],
  internal_tasks: ['tasks.internal.list', 'tasks.internal.create', 'tasks.internal.edit', 'tasks.internal.transition'],
  workspace_file_search: ['workspace.files.search', 'workspace.files.replace.preview', 'workspace.files.replace'],
  code_intelligence: CODE_INTELLIGENCE_ACTION_IDS,
  workflow_event_catalog: ['workflow.events.list'],
  filesystem: FILESYSTEM_ACTION_IDS,
  scope: SCOPE_ACTION_IDS,
  diagnostics: DIAGNOSTICS_ACTION_IDS,
  connected_services_configuration: CONNECTED_SERVICE_CONFIGURATION_ACTION_IDS_V1,
  usage_sources: USAGE_SOURCE_ACTION_IDS,
  boards: WORK_BOARD_ACTION_IDS_V1,
  widgets: [...WIDGET_INSTANCE_ACTION_IDS_V1, ...WIDGET_DEFINITION_ACTION_IDS_V1, ...WIDGET_LAYOUT_FRAGMENT_ACTION_IDS_V1, 'widgets.snapshot.post'],
  roles: ROLE_ACTION_IDS_V1,
  launch_profiles: ['launch_profiles.publish', ...PROFILE_ACTION_IDS_V1],
  mcp_servers: MCP_SERVER_ACTION_IDS_V1,
  capability_rules: CAPABILITY_RULES_ACTION_IDS_V1,
  session_capabilities: SESSION_CAPABILITIES_ACTION_IDS_V1,
  skills: SKILL_ACTION_IDS_V1,
  providers: PROVIDER_ACTION_IDS_V1,
  model_preferences: ['models.favorite.set'],
  remote_hosts: REMOTE_HOST_ACTION_IDS_V1,
  home_runtime: HOME_RUNTIME_ACTION_IDS_V1,
  account_lifecycle: ACCOUNT_LIFECYCLE_ACTION_IDS,
  artifact_folders: ARTIFACT_FOLDER_ACTION_IDS_V1,
  discovery: [
    'action.spec.search',
    'action.spec.get',
    'action.options.resolve',
    'action.invoke',
  ],
  workflows: WORKFLOW_ACTION_IDS_V1,
  workflow_effects: WORKFLOW_EFFECT_ACTION_IDS_V1,
  workflow_authoring: WORKFLOW_AUTHORING_ACTION_IDS,
  workflow_diagnostics: ['workflow.trigger.test', 'workflow.starters.list', 'workflow.starters.resolve'],
  session_authoring: ['session.authoring.open'],
  artifact_access: ARTIFACT_ACCESS_ACTION_IDS_V1,
  artifacts: ARTIFACT_ACTION_IDS_V1,
  doc_collaboration: DOC_COLLABORATION_ACTION_IDS_V1,
  settings_declarations: [...SETTINGS_DECLARATION_ACTION_IDS_V1, ...ACTION_POLICY_ACTION_IDS],
  app_shell: APP_SHELL_ACTION_IDS,
  notifications: ['notifications.notify_me'],
  notification_configuration: NOTIFICATION_CONFIGURATION_ACTION_IDS,
  app_updates: APP_UPDATE_ACTION_IDS,
  updates: UPDATES_ACTION_IDS,
  clipboard: CLIPBOARD_ACTION_IDS,
  home_hub_layout: ['home.hub.layout.get', 'home.hub.layout.update', 'home.reachNudge.dismiss'],
  machine_agent_install: [
    'machines.agents.install',
    'machines.agents.uninstall',
    'machines.agents.install.status',
    'machines.agents.install.cancel',
  ],
  machine_agent_sign_in: ['machines.agents.signIn.start', 'machines.agents.signIn.status', 'machines.agents.signIn.cancel', 'machines.agents.signIn.restart'],
  machine_connection: ['homes.connect', 'homes.reconnect', 'machines.add.command', 'machines.pairing.create', ...MACHINE_PAGE_ACTION_IDS, ...MACHINE_TERMINAL_ACTION_IDS, ...MACHINE_ADD_SSH_ACTION_IDS],
  local_daemon_services: LOCAL_DAEMON_SERVICE_ACTION_IDS,
  machine_access: MACHINE_ACCESS_ACTION_IDS,
  machine_work_summary: MACHINE_WORK_SUMMARY_ACTION_IDS,
  machine_vitals: MACHINE_VITALS_ACTION_IDS,
  machine_processes: MACHINE_PROCESSES_ACTION_IDS,
  machine_storage: MACHINE_STORAGE_ACTION_IDS,
  machine_resources: MACHINE_RESOURCES_ACTION_IDS,
  machine_guard: MACHINE_GUARD_ACTION_IDS,
  session_access: [
    'session.access.candidates.inspect',
    'session.access.principals.resolve',
    'session.access.accounts.search',
    'session.access.grants.list',
    'session.access.grant.set',
    'session.access.grant.remove',
    'session.access.context.set',
    'session.access.encryption.prepare',
    'session.access.encryption.reprepare',
    'session.access.layout.update',
    'session.responsibility.set',
    'session.responsibility.candidates.list',
    'session.public_link.get',
    'session.public_link.create',
    'session.public_link.remove',
  ],
  session_lifecycle: [
    'session.open',
    'session.fork',
    'session.continue_with_replay',
    'session.rollback',
    'session.checkpoint_code_rollback',
    'session.checkpoint',
    'session.restore',
    'session.handoff',
    'session.handoff.prepare_target',
    'session.handoff.prepare_target.resume',
    'session.handoff.prepare_target_result.get',
    'session.handoff.commit',
    'session.handoff.abort',
    'session.handoff.status.get',
    'workspace.sync.conflict.resolve',
    'workspace.sync.relationship.create',
    'workspace.sync.relationship.disable',
    'workspace.sync.relationship.enable',
    'workspace.sync.relationship.flush',
    'workspace.sync.relationship.terminate',
    'workspace.sync.relationships.list',
    'workspace.sync.conflicts.list',
    'workspace.sync.conflict.inspect',
    'session.spawn_new',
  ],
  inventory: [
    'machines.agents.list',
    'paths.list_recent',
    'projects.list',
    'projects.open',
    'projects.context.update',
    'projects.visibility.set',
    'projects.workspace.update',
    'projects.workspace.forget',
    'prompts.invocations.list',
    'prompts.invocation.resolve',
    'machines.list',
    'servers.list',
    'review.engines.list',
    'agents.backends.list',
    'agents.models.list',
    'agents.config_options.list',
    'agents.session_modes.list',
    'sessions.spawn.profiles.list',
    'sessions.spawn.connected_services.list',
    'sessions.spawn.mcp_servers.preview',
  ],
  messaging: [
    'session.message.send',
    'session.message.reply',
    'session.update.post',
  ],
  session_control: [
    'session.pending.action.set',
    'session.pending.resetStart.set',
    'session.pending.resetStart.cancel',
    'session.pending.next',
    'session.pending.withdraw',
    'session.pending.markHandled',
    'session.pending.dismiss',
    'session.pending.sendAsNew',
    'session.turn.cancel',
    'session.stop',
    'session.exchange.control',
    'session.runtime.refresh',
    'session.delete',
    'session.section.set',
    'session.tags.set',
    'session.title.set',
    'session.status.set_reason',
    'session.coordinator.enable',
    'session.bot.set',
    'session.memory.set',
    'session.voice.preference.set',
    'session.context.update',
    'session.instructions.set',
    'session.view.toolCalls.set',
    'session.manager.set',
    'session.model.set',
    'session.model.unarm',
    'session.config_option.set',
    'session.connected_services_auth.set',
    'session.permission_mode.set',
    'session.archive',
    'session.unarchive',
    'session.status.get',
    'session.work_state.get',
    'session.goal.get',
    'session.goal.set',
    'session.goal.clear',
    'session.usageLimit.waitResume.enable',
    'session.usageLimit.waitResume.cancel',
    'session.usageLimit.checkNow',
    'session.usageLimit.consumeResetCredit',
    'session.terminalComposer.clear',
    'session.pendingInput.interruptAndRun',
    'session.vendor_plugin_catalog.list',
    'session.skill_catalog.list',
    'session.history.get',
    'session.wait.idle',
    'session.presentation.apply',
  ],
  session_organization_resources: [
    'session.sections.list', 'session.sections.create', 'session.sections.update', 'session.sections.reorder', 'session.sections.delete', 'session.sections.archive',
    'session.tags.list', 'session.tags.create', 'session.tags.rename', 'session.tags.delete',
  ],
  intent_start: [
    'review.start',
    'review.walkthrough',
    'review.explain_findings',
    'subagents.plan.start',
    'subagents.delegate.start',
    'voice_agent.start',
  ],
  review_comments: [
    'reviews.comments.create',
    'reviews.comments.list',
    'reviews.comments.get',
    'reviews.comments.transition',
    'reviews.comments.edit',
    'reviews.comments.reply',
    'reviews.comments.redact',
    'reviews.comments.setDisposition',
    'reviews.comments.attachEvidence',
    'reviews.comments.bulkTransition',
    'reviews.comments.claimPublicationDispatch',
  ],
  subagent_registry: [
    'sessions.subagents.list',
    'sessions.subagents.get',
    'sessions.subagents.watch',
    'sessions.subagents.upsert',
    'sessions.subagents.updateStatus',
    'sessions.subagents.complete',
  ],
  execution_run_control: [
    'execution.run.start',
    'execution.run.list',
    'execution.run.get',
    'execution.run.send',
    'execution.run.ensure',
    'execution.run.ensure_or_start',
    'execution.run.stream.start',
    'execution.run.stream.read',
    'execution.run.stream.cancel',
    'execution.run.stop',
    'execution.run.cancel_turn',
    'execution.run.action',
    'execution.run.permission.respond',
    'execution.run.wait',
  ],
  session_targeting: [
    'session.targets.resolve',
    'session.target.primary.set',
    'session.target.tracked.set',
    'session.list',
    'session.activity.get',
    'session.messages.recent.get',
  ],
  /**
   * Durable Session-to-Session Follow authoring. `set` and `remove` create or
   * remove durable cross-Session context flow, so they are classified `danger`
   * in the Action safety source of truth and inherit the shared approval
   * default and user override; this family adds no approval policy of its own.
   */
  session_follow: [
    'follow.get',
    'follow.set',
    'follow.remove',
    'follow.list',
    'follow.preview',
    'follow.preferences.get',
    'follow.preferences.set',
    'session.delivery.mute.set',
    'session.delivery.mute.remove',
    'session.delivery.mute.list',
  ],
  session_transcripts: [
    'session.input.result.get',
    'session.transcript.get',
    'session.events.get',
    'session.log.tail',
    'transcript.page',
    'transcript.readAfter',
    'transcript.follow',
    'transcript.unfollow',
    'transcript.import',
    'transcript.search',
  ],
  /**
   * The one explicit-human Session read-state intent. UI and CLI reach the
   * same durable viewer frontier through this id; automatic viewport sync
   * stays an internal owner operation with no id here, so an Agent reading
   * context can never acknowledge what the human saw.
   */
  session_read_state: SESSION_READ_STATE_ACTION_IDS_V1,
  /**
   * The present-user Inbox attention intent over the existing standing route (ORC R-10):
   * Settle writes `standing: false`, snooze writes `remindAt`.
   */
  session_attention: [SESSION_ATTENTION_SET_ACTION_ID],
  /** The shared human and Agent Board intents; the Board schemas own their ids. */
  session_board: SESSION_BOARD_ACTION_IDS_V1,
  /**
   * The Home-owned Discussion intents. UI, CLI, Agents and supported
   * SDK callers reach one family; the discussion schemas own their ids.
   */
  discussion: DISCUSSION_ACTION_IDS_V1,
  session_permissions: [
    'session.approval_reviewer.set',
    'session.permission.respond',
    'session.permission.remote.pending.list',
    'session.permission.remote.respond',
    'session.user_action.remote.answer',
    'session.permission.remote.grants.list',
    'session.permission.remote.grants.revoke',
    'session.user_action.answer',
    'session.needs_you.raise',
    'session.control.switch',
    'session.mode.set',
  ],
  external_sessions: [
    'sessions.external.candidates.list',
    'sessions.external.candidate.delete',
    'sessions.external.link.ensure',
    'sessions.external.follow',
    'sessions.external.unfollow',
    'sessions.external.backgroundFollow.set',
    'sessions.external.status.get',
    'sessions.external.transcript.page',
    'sessions.external.transcript.readAfter',
    'sessions.external.takeover',
    'sessions.external.materialize.start',
    'sessions.external.takeover.start',
    'sessions.external.operation.status.get',
    'sessions.external.operation.cancel',
    'sessions.external.operation.resume',
    'sessions.external.operation.retry',
    'sessions.external.operation.discard',
  ],
  voice_controls: [
    ...VOICE_CONVERSATION_ACTION_IDS,
    'ui.voice_global.reset',
    'ui.voice_agent.teleport',
  ],
  current_ui_context: [
    'ui.current_context.read',
    'ui.current_context.command.invoke',
  ],
  account_home_continuation: ['account.home_continuation.invoke'],
  command_palette: ['ui.command_palette.list', 'ui.command_palette.invoke'],
  find: ['ui.find'],
  prompt_picker: ['ui.prompts.picker.open'],
  companion_controls: [
    'ui.pet.choose',
  ],
  memory: [
    'memory.remember', 'memory.decision.save', 'memory.update', 'memory.forget', 'memory.read', 'memory.list',
    'memory.search',
    'search.settings.get',
    'search.settings.set',
    'search.conversations',
    'memory.status',
    'memory.clear_index',
    'memory.get_window',
    'memory.ensure_up_to_date',
  ],
  agent_acp_catalog: [
    'agents.acp.backends.get',
    'agents.acp.backends.upsert',
    'agents.acp.backends.delete',
    'agents.acp.backends.installFromRegistry',
  ],
  prompt_library: [
    ...PROMPT_INVOCATION_ACTION_IDS,
    'prompts.stack.update',
    'prompt_doc.get',
    'prompt_doc.create',
    'prompt_doc.favorite.set',
    'prompts.library.list',
    'prompt_doc.update',
    'prompt_bundle.update',
    'prompt_registry.install',
  ],
  bug_report_submission: BUG_REPORT_SUBMISSION_ACTION_IDS,
  daemon_admin: [
    'daemon.filesystem.listRoots',
    'daemon.filesystem.browseDirectory',
    'bugreport.collectDiagnostics',
    'bugreport.getLogTail',
    'bugreport.uploadArtifact',
  ],
  browser_control: [
    'browser.workspace.open',
    'browser.sandbox.install',
    'browser.control.takeControl',
    'browser.control.handBack',
    'browser.view.open',
    'browser.view.openExternal',
    'browser.view.close',
    'browser.view.focus',
    'browser.target.set',
    'browser.navigate',
    'browser.reload',
    'browser.goBack',
    'browser.goForward',
    'browser.stop',
  ],
  browser_diagnostics: [
    'browser.diagnostics.snapshot',
    'browser.diagnostics.clear',
    'browser.diagnostics.pause',
    'browser.diagnostics.resume',
    'browser.diagnostics.eval',
    'browser.diagnostics.getProperties',
    'browser.diagnostics.releaseObjectGroup',
    'browser.diagnostics.elementPicker.start',
    'browser.diagnostics.elementPicker.cancel',
  ],
  browser_context: [
    'browser.context.capturePage',
    'browser.context.captureScreenshot',
    'browser.context.captureSelectedElement',
    'browser.context.captureNetworkSummary',
    'browser.context.captureConsoleSummary',
    'browser.context.annotation.start',
    'browser.context.annotation.cancel',
    'browser.context.annotation.captureRegion',
    'browser.context.annotation.captureElement',
    'browser.context.annotation.attachComment',
    'browser.context.annotation.attachStroke',
    'browser.context.annotation.attachStyleIntent',
    'browser.context.annotation.attachDraft',
    'browser.context.attachToComposer',
    'browser.context.attachToAgentTurn',
    'browser.context.clear',
  ],
  browser_automation: [
    'browser.automation.status',
    'browser.automation.snapshot',
    'browser.automation.semanticSnapshot',
    'browser.automation.queryElements',
    'browser.automation.waitFor',
    'browser.automation.timeline.get',
    'browser.automation.cancelActive',
    'browser.automation.navigate',
    'browser.automation.reload',
    'browser.automation.goBack',
    'browser.automation.goForward',
    'browser.automation.click',
    'browser.automation.tap',
    'browser.automation.type',
    'browser.automation.press',
    'browser.automation.scroll',
    'browser.automation.hover',
    'browser.automation.focus',
    'browser.automation.select',
    'browser.automation.setValue',
    'browser.automation.secret.fill',
    'browser.automation.upload',
    'browser.automation.drag',
  ],
  computer: [
    'computer.targets.list',
    'computer.target.get',
    'computer.target.select',
    'computer.permissions.openSettings',
    'computer.capture',
    'computer.query',
    'computer.input',
    'computer.secret.fill',
    'computer.control.status',
    'computer.control.interrupt',
    'computer.control.handBack',
    'computer.target.close',
  ],
  browser_recording: [
    'browser.recording.start',
    'browser.recording.stop',
    'browser.recording.cancel',
    'browser.recording.status',
    'browser.recording.listForView',
    'browser.recording.discard',
    'browser.recording.cleanupExpired',
    'browser.recording.attachToComposer',
  ],
  local_services_inventory: [
    'localServices.inventory.list',
    'localServices.inventory.refresh',
  ],
  local_services_launcher: [
    'localServices.launcher.snapshot',
    'localServices.launcher.start',
    'localServices.launcher.openPreview',
    'localServices.launcher.registerPreview',
    'localServices.launcher.history.clear',
  ],
  local_services_preview: [
    'localServices.preview.openOrCreate',
    'localServices.preview.status',
    'localServices.preview.revoke',
  ],
  local_services_public_preview: [
    'localServices.publicPreview.create',
    'localServices.publicPreview.status',
    'localServices.publicPreview.revoke',
    'localServices.publicPreview.copyUrl',
  ],
  local_services_actions: [
    'projects.service.relocate',
    'localServices.actions.copyUrl',
    'localServices.actions.openPreview',
    'localServices.actions.forget',
    'localServices.actions.stopManaged',
    'localServices.actions.restartManaged',
    'localServices.actions.terminateDetected',
  ],
  peer_mediation_observability: [
    'peerMediation.observability.snapshot',
    'peerMediation.observability.subscribe',
    'peerMediation.observability.unsubscribe',
  ],
  devices_simulator: [
    'devices.simulator.list',
    'devices.simulator.stream.keyframe',
    'devices.simulator.stream.snapshot',
    'devices.simulator.stream.quality.set',
    'devices.simulator.stream.fps.set',
    'devices.simulator.stream.scale.set',
    'devices.simulator.lease.acquire',
    'devices.simulator.lease.renew',
    'devices.simulator.lease.release',
    'devices.simulator.input.tap',
    'devices.simulator.input.swipe',
    'devices.simulator.input.text',
    'devices.simulator.input.key',
    'devices.simulator.input.button',
    'devices.simulator.input.orientation',
    'devices.simulator.input.pinch',
    'devices.simulator.input.rotate',
    'devices.simulator.sideband.request',
  ],
  approvals: [
    'approval.request.list',
    'approval.request.get',
    'approval.request.create',
    'approval.request.decide',
  ],
  plugin_dev_loop: [
    ...PLUGIN_DEV_LOOP_ACTION_IDS_V1,
    'plugins.sessionHooks.status.get',
    'plugins.sessionHooks.install',
    'plugins.sessionHooks.disable',
    'plugins.sessionHooks.enable',
    'plugins.sessionHooks.uninstall',
  ],
  plugin_settings_administration: PLUGIN_SETTINGS_ADMINISTRATION_ACTION_IDS_V1,
  plugin_permission_grants: [
    'plugins.permissions.grants.list',
    'plugins.permissions.grants.request',
    'plugins.permissions.grants.grant',
    'plugins.permissions.grants.revoke',
    'plugins.permissions.grants.dismissRequest',
  ],
  plugin_webhooks: PLUGIN_WEBHOOK_ACTION_IDS_V1,
  account_plugin_data: [
    'account.plugins.data.erase',
  ],
  account_sessions: [
    'account.sessions.signOutEverywhere',
  ],
  account_security: [
    'account.encryption.historicalKey.forget',
    'account.encryption.automationTemplates.recover',
    'account.security.get',
    'account.security.terminalPresentUser.set',
    'account.password.enroll',
    'account.password.change',
    'account.password.remove',
    'account.email.change.request',
  ],
  account_api_tokens: [
    'account.apiTokens.create',
    'account.apiTokens.list',
    'account.apiTokens.update',
    'account.apiTokens.revoke',
    'account.apiTokens.revokeAll',
  ],
  identity_github_apps: MANAGED_GITHUB_APP_ACTION_IDS_V1,
  identity_providers: MANAGED_IDENTITY_PROVIDER_ACTION_IDS_V1,
  machine_pools: MACHINE_POOL_ACTION_IDS_V1,
  managed_machines: MANAGED_MACHINE_ACTION_IDS_V1,
  machine_presets: MACHINE_PRESET_ACTION_IDS_V1,
  ephemeral_runner: EPHEMERAL_RUNNER_ACTION_IDS_V1,
  automation_occurrences: AUTOMATION_OCCURRENCE_ACTION_IDS,
  automation_events: [
    'automation.event.sources.list',
    'automation.event.admit',
    'automation.event.source.status.report',
  ],
  automation_conversation: [
    'automation.conversation.targets.list',
    'automation.conversation.target.verify',
    'automation.conversation.admit',
  ],
  scm_git: [
    'scm.file.read',
    'scm.backend.describe',
    'scm.status.snapshot',
    'scm.worktrees.enrichment',
    'scm.diff.file',
    'scm.blame.get',
    'scm.diff.commit',
    'scm.change.include',
    'scm.change.exclude',
    'scm.change.discard',
    'scm.commit.create',
    'scm.commit.backout',
    'scm.commit.undoLast',
    'scm.log.list',
    'scm.history.entries',
    'scm.branch.list',
    'scm.branch.create',
    'scm.branch.checkout',
    'scm.branch.merge',
    'scm.branch.rebase',
    'scm.branch.operation.continue',
    'scm.branch.operation.skip',
    'scm.branch.operation.abort',
    'scm.conflict.acceptSide',
    'scm.conflict.markResolved',
    'scm.worktree.create',
    'scm.worktree.remove',
    'scm.worktree.prune',
    'scm.remote.add',
    'scm.remote.setUrl',
    'scm.remote.remove',
    'scm.remote.fetch',
    'scm.remote.pull',
    'scm.remote.push',
    'scm.remote.publish',
    'scm.stash.list',
    'scm.stash.show',
    'scm.stash.create',
    'scm.stash.apply',
    'scm.stash.pop',
    'scm.stash.drop',
  ],
  scm_pull_request: [
    'scm.pullRequest.list',
    'scm.pullRequest.get',
    'scm.pullRequest.openOrReuse',
    'scm.pullRequest.openCompose',
    'scm.pullRequest.checkout',
    'scm.pullRequest.prepareWorktree',
    'scm.reviewWorkspace.materializePrepared',
    'scm.pullRequest.runStacked',
  ],
  scm_repository: [
    'scm.repository.clone',
    'scm.repository.init',
    'scm.repository.removeIndexLock',
    'scm.hostingRepository.describePublishTargets',
    'scm.hostingRepository.resolveAddress',
    'scm.hostingRepository.get',
    'scm.hostingRepository.publish',
  ],
  scm_diff_summary: [
    'scm.diffSummary.result.list',
    'scm.diffSummary.result.clear',
    'scm.diffSummary.capture',
    'scm.diffSummary.generate',
    'scm.diffSummary.draftPullRequest',
    'scm.diffSummary.result.read',
    'scm.diffSummary.result.edit',
    'scm.diffSummary.result.undo',
    'scm.diffSummary.result.delete',
    'scm.diffSummary.refine',
    'scm.diffSummary.addOutputs',
    'scm.diffSummary.discuss',
    'scm.diffSummary.commitPlan.accept',
    'scm.diffSummary.commitPlan.stop',
    'scm.diffSummary.commitPlan.includeHookChanges',
    'scm.diffSummary.commitPlan.cancel',
    'scm.diffSummary.commitPlan.recover',
    'scm.commit.resolveOutcome',
    'scm.diffSummary.reviewed.mark',
    'scm.diffSummary.reviewed.unmark',
  ],
  /**
   * Home governance and Teams are carried to one exact Home by the same
   * transport family. The ids stay in their domain owners so neither family
   * becomes the other's registry.
   */
  home_governance: HOME_GOVERNANCE_ACTION_IDS_V1,
  home_identity: HOME_IDENTITY_ACTION_IDS_V1,
  teams: TEAM_ACTION_IDS_V1,
  saved_secret_sharing: SHARED_SAVED_SECRET_ACTION_IDS_V1,
} as const);

type ActionFamilyId = (typeof ACTION_ID_FAMILIES_V1)[keyof typeof ACTION_ID_FAMILIES_V1][number];

export const ACTION_IDS: readonly ActionFamilyId[] = Object.freeze(Object.values(ACTION_ID_FAMILIES_V1).flat());

export const RUNTIME_ACTION_IDS_V1 = [
  ...ACTION_ID_FAMILIES_V1.computer,
  ...ACTION_ID_FAMILIES_V1.browser_control,
  ...ACTION_ID_FAMILIES_V1.browser_diagnostics,
  ...ACTION_ID_FAMILIES_V1.browser_context,
  ...ACTION_ID_FAMILIES_V1.browser_automation,
  ...ACTION_ID_FAMILIES_V1.browser_recording,
  ...ACTION_ID_FAMILIES_V1.local_services_inventory,
  ...ACTION_ID_FAMILIES_V1.local_services_launcher,
  ...ACTION_ID_FAMILIES_V1.local_services_preview,
  ...ACTION_ID_FAMILIES_V1.local_services_public_preview,
  ...ACTION_ID_FAMILIES_V1.local_services_actions,
  ...ACTION_ID_FAMILIES_V1.peer_mediation_observability,
  ...ACTION_ID_FAMILIES_V1.devices_simulator,
] as const;

export type ActionId = typeof ACTION_IDS[number];
export const ActionIdSchema: z.ZodMiniEnum<{ [Id in ActionId]: Id }> = lazyZodSchema(() => z.enum(ACTION_IDS));
export type ActionIdFamilyV1 = keyof typeof ACTION_ID_FAMILIES_V1;
export const ActionIdFamilyV1Schema = lazyZodSchema(() => z.enum(
  Object.keys(ACTION_ID_FAMILIES_V1) as [ActionIdFamilyV1, ...ActionIdFamilyV1[]],
));

export const RuntimeActionIdV1Schema = lazyZodSchema(() => z.enum(RUNTIME_ACTION_IDS_V1));
export type RuntimeActionIdV1 = z.infer<typeof RuntimeActionIdV1Schema>;

const RUNTIME_ACTION_ID_V1_SET: ReadonlySet<string> = new Set(RUNTIME_ACTION_IDS_V1);

export function isRuntimeActionIdV1(value: string): value is RuntimeActionIdV1 {
  return RUNTIME_ACTION_ID_V1_SET.has(value);
}

const LEGACY_ACTION_ID_ALIASES: Readonly<Record<string, ActionId>> = Object.freeze({
  'plan.start': 'subagents.plan.start',
  'delegate.start': 'subagents.delegate.start',
});

export function normalizeLegacyActionId(value: string): string {
  return LEGACY_ACTION_ID_ALIASES[value] ?? value;
}

export type SessionAccessActionId = typeof ACTION_ID_FAMILIES_V1.session_access[number];
export function isSessionAccessActionId(value: string): value is SessionAccessActionId {
  return (ACTION_ID_FAMILIES_V1.session_access as readonly string[]).includes(value);
}
import { REGISTRY_ACTION_IDS_V1 } from '../registries/registryActionsV1.js';
