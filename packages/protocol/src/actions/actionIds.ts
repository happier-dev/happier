import { z } from 'zod';
import { MACHINE_ADD_SSH_ACTION_IDS } from './specs/machineConnection.js';
import { SCOPE_ACTION_IDS } from './scopeActionFamily.js';
import { ROLE_ACTION_IDS_V1 } from '../prompts/roles/roleActionIdsV1.js';
import { WORK_BOARD_ACTION_IDS_V1 } from '../boards/actionIdsV1.js';
import { VOICE_CONVERSATION_ACTION_IDS } from './voiceConversationActionFamily.js';

import { HOME_GOVERNANCE_ACTION_IDS_V1 } from '../home/governance/actionsV1.js';
import { PLUGIN_SETTINGS_ADMINISTRATION_ACTION_IDS_V1 } from '../plugins/settingsAdministration.js';
import { SESSION_BOARD_ACTION_IDS_V1 } from '../sessions/board/actionIds.js';
import { SESSION_DISCUSSION_ACTION_IDS_V1 } from '../sessions/discussions/actionIds.js';
import { SESSION_READ_STATE_ACTION_IDS_V1 } from '../sessions/readState/actionIds.js';
import { SESSION_ATTENTION_SET_ACTION_ID } from '../sessions/organization/attentionAction.js';
import { MACHINE_POOL_ACTION_IDS_V1 } from '../machines/pools/actionsV1.js';
import { TEAM_ACTION_IDS_V1 } from '../teams/actionsV1.js';
import { MANAGED_GITHUB_APP_ACTION_IDS_V1 } from '../identity/githubApps.js';
import { MANAGED_IDENTITY_PROVIDER_ACTION_IDS_V1 } from '../identity/providers.js';
import { EPHEMERAL_RUNNER_ACTION_IDS_V1 } from '../ephemeralRunner/actionIdsV1.js';
import { SHARED_SAVED_SECRET_ACTION_IDS_V1 } from '../account/settings/savedSecretResourceActionsV1.js';
import { ARTIFACT_ACCESS_ACTION_IDS_V1 } from '../artifacts/artifactAccessV1.js';
import { ARTIFACT_ACTION_IDS_V1 } from '../artifacts/artifactActionsV1.js';
import { WORKSPACE_ACTION_IDS } from './workspaceActionFamily.js';
import { SESSION_CANVAS_ACTION_IDS } from './sessionCanvasActionIds.js';
import { CONNECTED_SERVICE_CONFIGURATION_ACTION_IDS_V1 } from '../connect/configurationActionIdsV1.js';
import { SETTINGS_DECLARATION_ACTION_IDS_V1 } from './settingsDeclarationActionFamily.js';
import { APP_SHELL_ACTION_IDS } from './appShellActionFamily.js';
import { SESSION_TERMINAL_ACTION_IDS } from './sessionTerminalActionFamily.js';
import { NOTIFICATION_CONFIGURATION_ACTION_IDS } from './notificationConfigurationActionFamily.js';
import { APP_UPDATE_ACTION_IDS } from './appUpdateActionFamily.js';
import { WIDGET_INSTANCE_ACTION_IDS_V1 } from '../widgets/actionIdsV1.js';
import { WIDGET_DEFINITION_ACTION_IDS_V1 } from '../widgets/definitionActionIdsV1.js';

export const WORKFLOW_ACTION_IDS_V1 = [
  'workflow.validate', 'workflow.run.start', 'workflow.run.list', 'workflow.run.summaries', 'workflow.run.get', 'workflow.run.wait',
  'workflow.run.pause', 'workflow.run.resume', 'workflow.run.cancel', 'workflow.run.invocations.list',
  'workflow.run.invocations.get', 'workflow.run.invocations.retry', 'workflow.run.delete',
  'workflow.run.invocations.publish_draft', 'workflow.run.invocations.complete_review',
  'workflow.definition.list', 'workflow.definition.get', 'workflow.definition.create',
  'workflow.definition.update', 'workflow.definition.edit', 'workflow.definition.delete',
  'workflow.trigger.list', 'workflow.trigger.add', 'workflow.trigger.update', 'workflow.trigger.remove',
  'session.trigger.list', 'session.trigger.add', 'session.trigger.update', 'session.trigger.remove',
] as const;
export type WorkflowActionIdV1 = typeof WORKFLOW_ACTION_IDS_V1[number];
export const WorkflowActionIdV1Schema = z.enum(WORKFLOW_ACTION_IDS_V1);

/**
 * The closed host Action vocabulary for the public plugin-authoring journey.
 * These operations project existing CLI/daemon owners; they do not make
 * plugin authoring a second command dispatcher.
 */
export const PLUGIN_DEV_LOOP_ACTION_IDS_V1 = [
  'plugins.scaffold',
  'plugins.install',
  'plugins.uninstall',
  'plugins.dev.submit',
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
  observation: ['wait'],
  capture_viewing: ['capture.view'],
  session_terminals: SESSION_TERMINAL_ACTION_IDS,
  workspace_layout: [...WORKSPACE_ACTION_IDS, ...SESSION_CANVAS_ACTION_IDS],
  session_organization_move: ['session.organization.move'],
  composer_ingress: ['composer.transaction.apply', 'composer.attachments.pick', 'repository.upload.pick'],
  list_reorder: ['session.pending.reorder', 'todos.reorder'],
  todo_session_link: ['todos.session.link'],
  workspace_file_search: ['workspace.files.search'],
  scope: SCOPE_ACTION_IDS,
  connected_services_configuration: CONNECTED_SERVICE_CONFIGURATION_ACTION_IDS_V1,
  boards: WORK_BOARD_ACTION_IDS_V1,
  widgets: [...WIDGET_INSTANCE_ACTION_IDS_V1, ...WIDGET_DEFINITION_ACTION_IDS_V1, 'widgets.snapshot.post'],
  roles: ROLE_ACTION_IDS_V1,
  launch_profiles: ['launch_profiles.publish'],
  discovery: [
    'action.spec.search',
    'action.spec.get',
    'action.options.resolve',
    'action.invoke',
  ],
  workflows: WORKFLOW_ACTION_IDS_V1,
  workflow_authoring: ['workflow.authoring.conversation.bind'],
  artifact_access: ARTIFACT_ACCESS_ACTION_IDS_V1,
  artifacts: ARTIFACT_ACTION_IDS_V1,
  settings_declarations: SETTINGS_DECLARATION_ACTION_IDS_V1,
  app_shell: APP_SHELL_ACTION_IDS,
  notifications: ['notifications.notify_me'],
  notification_configuration: NOTIFICATION_CONFIGURATION_ACTION_IDS,
  app_updates: APP_UPDATE_ACTION_IDS,
  home_hub_layout: ['home.hub.layout.get', 'home.hub.layout.update', 'home.reachNudge.dismiss'],
  machine_agent_install: [
    'machines.agents.install',
    'machines.agents.install.status',
    'machines.agents.install.cancel',
  ],
  machine_agent_sign_in: ['machines.agents.signIn.start', 'machines.agents.signIn.status', 'machines.agents.signIn.cancel', 'machines.agents.signIn.restart'],
  machine_connection: ['homes.connect', 'machines.add.command', 'machines.pairing.create', 'machines.terminal.open', 'machines.terminal.list', ...MACHINE_ADD_SSH_ACTION_IDS],
  session_access: [
    'session.access.grants.list',
    'session.access.grant.set',
    'session.access.grant.remove',
    'session.access.context.set',
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
    'workspace.sync.relationships.list',
    'workspace.sync.conflicts.list',
    'workspace.sync.conflict.inspect',
    'session.spawn_new',
  ],
  inventory: [
    'machines.agents.list',
    'paths.list_recent',
    'projects.list',
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
    'session.worker.publish',
  ],
  session_control: [
    'session.pending.next',
    'session.stop',
    'session.delete',
    'session.folder.set',
    'session.tags.set',
    'session.title.set',
    'session.reports_to.set',
    'session.model.set',
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
    'session.folders.list', 'session.folders.create', 'session.folders.rename', 'session.folders.delete',
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
    'session.follow.get',
    'session.follow.set',
    'session.follow.remove',
    'session.follow.preferences.get',
    'session.follow.preferences.set',
    'session.follow.sources.list',
    'session.follow.sources.set',
    'session.follow.sources.remove',
  ],
  session_transcripts: [
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
   * The Session-owned human discussion intents. UI, CLI, Agents and supported
   * SDK callers reach one family; the discussion schemas own their ids.
   */
  session_discussion: SESSION_DISCUSSION_ACTION_IDS_V1,
  session_permissions: [
    'session.approval_reviewer.set',
    'session.permission.respond',
    'session.permission.remote.pending.list',
    'session.permission.remote.respond',
    'session.user_action.remote.answer',
    'session.permission.remote.grants.list',
    'session.permission.remote.grants.revoke',
    'session.user_action.answer',
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
  command_palette: ['ui.command_palette.list', 'ui.command_palette.invoke'],
  find: ['ui.find'],
  prompt_picker: ['ui.prompts.picker.open'],
  companion_controls: [
    'ui.pet.choose',
  ],
  memory: [
    'memory.search',
    'memory.get_window',
    'memory.ensure_up_to_date',
  ],
  agent_acp_catalog: [
    'agents.acp.backends.upsert',
    'agents.acp.backends.delete',
  ],
  prompt_library: [
    'prompt_doc.get',
    'prompt_doc.create',
    'prompt_doc.favorite.set',
    'prompts.library.list',
    'prompt_doc.update',
    'prompt_bundle.update',
    'prompt_asset.export',
    'prompt_registry.install',
  ],
  daemon_admin: [
    'daemon.promptAssets.discover',
    'daemon.promptAssets.delete',
    'daemon.promptRegistry.scanSource',
    'daemon.promptRegistry.install',
    'daemon.filesystem.readFile',
    'daemon.filesystem.writeFile',
    'daemon.filesystem.listDirectory',
    'daemon.filesystem.getDirectoryTree',
    'daemon.filesystem.listRoots',
    'daemon.filesystem.browseDirectory',
    'bugreport.collectDiagnostics',
    'bugreport.getLogTail',
    'bugreport.uploadArtifact',
  ],
  browser_control: [
    'browser.sandbox.install',
    'browser.control.takeControl',
    'browser.control.handBack',
    'browser.view.open',
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
  plugin_webhooks: [
    'plugin.webhook.endpoint.ensure',
    'plugin.webhook.endpoint.read',
    'plugin.webhook.endpoint.revoke',
    'plugin.webhook.endpoint.retarget',
    'plugin.webhook.endpoint.checkCorrespondence',
    'plugin.webhook.endpoint.convergeTarget',
    'plugin.webhook.delivery.movePending',
    'plugin.webhook.endpoint.credential.configure',
    'plugin.webhook.endpoint.credential.rotate',
    'plugin.webhook.endpoint.credential.finishRotation',
  ],
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
  ephemeral_runner: EPHEMERAL_RUNNER_ACTION_IDS_V1,
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
    'scm.backend.describe',
    'scm.status.snapshot',
    'scm.worktrees.enrichment',
    'scm.diff.file',
    'scm.diff.commit',
    'scm.change.include',
    'scm.change.exclude',
    'scm.change.discard',
    'scm.commit.create',
    'scm.commit.backout',
    'scm.commit.undoLast',
    'scm.log.list',
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
    'scm.hostingRepository.publish',
  ],
  scm_diff_summary: [
    'scm.diffSummary.result.list',
    'scm.diffSummary.result.clear',
    'scm.diffSummary.capture',
    'scm.diffSummary.generate',
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
  teams: TEAM_ACTION_IDS_V1,
  saved_secret_sharing: SHARED_SAVED_SECRET_ACTION_IDS_V1,
} as const);

export const ACTION_IDS = [
  ...ACTION_ID_FAMILIES_V1.workflow_authoring,
  ...ACTION_ID_FAMILIES_V1.observation,
  ...ACTION_ID_FAMILIES_V1.capture_viewing,
  ...ACTION_ID_FAMILIES_V1.session_terminals,
  ...ACTION_ID_FAMILIES_V1.connected_services_configuration,
  ...ACTION_ID_FAMILIES_V1.workspace_layout,
  ...ACTION_ID_FAMILIES_V1.session_organization_move,
  ...ACTION_ID_FAMILIES_V1.composer_ingress,
  ...ACTION_ID_FAMILIES_V1.list_reorder,
  ...ACTION_ID_FAMILIES_V1.todo_session_link,
  ...ACTION_ID_FAMILIES_V1.workspace_file_search,
  ...ACTION_ID_FAMILIES_V1.home_hub_layout,
  ...ACTION_ID_FAMILIES_V1.scope,
  ...ACTION_ID_FAMILIES_V1.boards,
  ...ACTION_ID_FAMILIES_V1.widgets,
  ...ACTION_ID_FAMILIES_V1.computer,
  ...ACTION_ID_FAMILIES_V1.machine_connection,
  ...ACTION_ID_FAMILIES_V1.machine_agent_install,
  ...ACTION_ID_FAMILIES_V1.machine_agent_sign_in,
  ...ACTION_ID_FAMILIES_V1.roles,
  ...ACTION_ID_FAMILIES_V1.launch_profiles,
  ...ACTION_ID_FAMILIES_V1.artifact_access,
  ...ACTION_ID_FAMILIES_V1.artifacts,
  ...ACTION_ID_FAMILIES_V1.settings_declarations,
  ...ACTION_ID_FAMILIES_V1.app_shell,
  ...ACTION_ID_FAMILIES_V1.notification_configuration,
  ...ACTION_ID_FAMILIES_V1.app_updates,
  ...ACTION_ID_FAMILIES_V1.discovery,
  ...ACTION_ID_FAMILIES_V1.session_access,
  ...ACTION_ID_FAMILIES_V1.session_lifecycle,
  ...ACTION_ID_FAMILIES_V1.inventory,
  ...ACTION_ID_FAMILIES_V1.messaging,
  ...ACTION_ID_FAMILIES_V1.session_control,
  ...ACTION_ID_FAMILIES_V1.intent_start,
  ...ACTION_ID_FAMILIES_V1.session_organization_resources,
  ...ACTION_ID_FAMILIES_V1.review_comments,
  ...ACTION_ID_FAMILIES_V1.subagent_registry,
  ...ACTION_ID_FAMILIES_V1.execution_run_control,
  ...ACTION_ID_FAMILIES_V1.session_targeting,
  ...ACTION_ID_FAMILIES_V1.session_follow,
  ...ACTION_ID_FAMILIES_V1.session_read_state,
  ...ACTION_ID_FAMILIES_V1.session_attention,
  ...ACTION_ID_FAMILIES_V1.session_transcripts,
  ...ACTION_ID_FAMILIES_V1.session_board,
  ...ACTION_ID_FAMILIES_V1.session_discussion,
  ...ACTION_ID_FAMILIES_V1.session_permissions,
  ...ACTION_ID_FAMILIES_V1.external_sessions,
  ...ACTION_ID_FAMILIES_V1.voice_controls,
  ...ACTION_ID_FAMILIES_V1.current_ui_context,
  ...ACTION_ID_FAMILIES_V1.command_palette,
  ...ACTION_ID_FAMILIES_V1.find,
  ...ACTION_ID_FAMILIES_V1.prompt_picker,
  ...ACTION_ID_FAMILIES_V1.companion_controls,
  ...ACTION_ID_FAMILIES_V1.memory,
  ...ACTION_ID_FAMILIES_V1.prompt_library,
  ...ACTION_ID_FAMILIES_V1.daemon_admin,
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
  ...ACTION_ID_FAMILIES_V1.approvals,
  ...ACTION_ID_FAMILIES_V1.plugin_dev_loop,
  ...ACTION_ID_FAMILIES_V1.plugin_settings_administration,
  ...ACTION_ID_FAMILIES_V1.plugin_permission_grants,
  ...ACTION_ID_FAMILIES_V1.plugin_webhooks,
  ...ACTION_ID_FAMILIES_V1.account_plugin_data,
  ...ACTION_ID_FAMILIES_V1.account_sessions,
  ...ACTION_ID_FAMILIES_V1.account_security,
  ...ACTION_ID_FAMILIES_V1.account_api_tokens,
  ...ACTION_ID_FAMILIES_V1.agent_acp_catalog,
  ...ACTION_ID_FAMILIES_V1.identity_github_apps,
  ...ACTION_ID_FAMILIES_V1.identity_providers,
  ...ACTION_ID_FAMILIES_V1.machine_pools,
  ...ACTION_ID_FAMILIES_V1.ephemeral_runner,
  ...ACTION_ID_FAMILIES_V1.automation_events,
  ...ACTION_ID_FAMILIES_V1.automation_conversation,
  ...ACTION_ID_FAMILIES_V1.scm_pull_request,
  ...ACTION_ID_FAMILIES_V1.scm_git,
  ...ACTION_ID_FAMILIES_V1.scm_repository,
  ...ACTION_ID_FAMILIES_V1.scm_diff_summary,
  ...ACTION_ID_FAMILIES_V1.home_governance,
  ...ACTION_ID_FAMILIES_V1.teams,
  ...ACTION_ID_FAMILIES_V1.saved_secret_sharing,
  ...ACTION_ID_FAMILIES_V1.workflows,
  ...ACTION_ID_FAMILIES_V1.notifications,
] as const;

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

export const ActionIdSchema = z.enum(ACTION_IDS);
export type ActionId = z.infer<typeof ActionIdSchema>;
export type ActionIdFamilyV1 = keyof typeof ACTION_ID_FAMILIES_V1;
export const ActionIdFamilyV1Schema = z.enum(
  Object.keys(ACTION_ID_FAMILIES_V1) as [ActionIdFamilyV1, ...ActionIdFamilyV1[]],
);

export const RuntimeActionIdV1Schema = z.enum(RUNTIME_ACTION_IDS_V1);
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
