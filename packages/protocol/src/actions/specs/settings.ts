import { SETTINGS_DECLARATION_ACTION_IDS_V1, SettingsDeclarationActionInputSchemasV1, SettingsDeclarationActionOutputSchemasV1 } from '../settingsDeclarationActionFamily.js';
import { ACTION_POLICY_ACTION_IDS, ActionPolicyInputSchemas, ActionPolicyOutputSchemas } from '../actionPolicyActionFamily.js';
import { describeSettingsDeclarationApprovalSummaryV1, projectSettingsDeclarationApprovalInputV1, readBuiltInSettingDeclarationV1, readBuiltInSettingsOperationApprovalPolicyV1, readBuiltInSettingsWriteSafetyV1, readBuiltInSettingsPermissionChangingV1 } from '../settings/settingsDeclarations.js';
import type { PreNormalizedActionSpec } from './definition.js';


export const ACTION_POLICY_SPECS = Object.freeze([
  ...(ACTION_POLICY_ACTION_IDS.map((id): PreNormalizedActionSpec => ({
    id, title: id === 'actions.policy.get' ? 'Read Action policy' : id === 'actions.policy.reset' ? 'Reset Action policy' : 'Change Action policy',
    description: 'Read or change one exact Action policy preference. Default and reset restore inherited audience policy; unrelated preferences remain intact. Policy changes require human authority.',
    approval: { result: 'required' }, originalExecution: { terminalRoot: 'host' },
    ...(id !== 'actions.policy.get' ? { permissionChanging: true as const, approvalPolicy: { uiConfirmation: 'direct' as const } } : {}),
    safety: id === 'actions.policy.get' ? 'safe' : 'danger', sideEffectClass: id === 'actions.policy.get' ? 'read' : 'write',
    requiredAuthority: id === 'actions.policy.get' ? 'account_automation' : 'present_user',
    executionPlacement: 'account', placements: [],
    surfaces: { ui: true, cli: true, agent: true, mcp: true, voice: true, rpc: true },
    bindings: { rpcMethod: id, mcpToolName: id.replaceAll('.', '_'), voiceClientToolName: id.replaceAll('.', '_') },
    inputSchema: ActionPolicyInputSchemas[id], outputSchema: ActionPolicyOutputSchemas[id],
    inputHints: { fields: [
      { path: 'actionId', title: 'Action id', widget: 'text', required: true },
      { path: 'audience', title: 'Audience', widget: 'text', required: id !== 'actions.policy.set' },
      ...(id === 'actions.policy.set' ? [
        { path: 'mode', title: 'Audience policy', widget: 'text' as const },
        { path: 'change', title: 'Policy change', widget: 'json' as const },
      ] : []),
    ] },
    cli: { acceptsServerId: true, commands: [{ path: id.split('.'), visibility: 'canonical' }] },
  })) satisfies readonly PreNormalizedActionSpec[]),
] as const);


export const SETTINGS_ADMINISTRATION_ACTION_SPECS = Object.freeze([
  ...(SETTINGS_DECLARATION_ACTION_IDS_V1.map((id): PreNormalizedActionSpec => ({
    id, approval: { result: 'required' }, originalExecution: { terminalRoot: 'host' },
    // The operation schema stays behind realtime discovery; the native Agent
    // and Local Voice instructions share its ordinary direct-tool exposure.
    prompting: { voiceHotPath: id !== 'settings.invoke' },
    toolExposure: { agent: 'direct' },
    // Personal preferences carry their safety at the declaration; security and unknown anchors retain danger.
    ...(id === 'settings.set' || id === 'settings.reset' ? {
      approvalPolicy: { uiConfirmation: 'direct' as const }, safetyForInput: readBuiltInSettingsWriteSafetyV1,
      permissionChangingForInput: readBuiltInSettingsPermissionChangingV1,
    } : {}),
    ...(id === 'settings.invoke' ? { permissionChangingForInput: (input: unknown) => readBuiltInSettingsPermissionChangingV1(input, 'invoke'), approvalPolicy: {
      uiConfirmation: 'direct' as const,
      uiConfirmationForInput: (input: unknown) => readBuiltInSettingsOperationApprovalPolicyV1(input).uiConfirmationRequired,
    }, safetyForInput: (input: unknown): 'danger' | 'safe' => readBuiltInSettingsOperationApprovalPolicyV1(input).requiresApproval ? 'danger' : 'safe' } : {}),
    title: id === 'settings.list' ? 'List settings' : id === 'settings.get' ? 'Read a setting' : id === 'settings.reset' ? 'Reset a setting' : id === 'settings.invoke' ? 'Run a settings operation' : 'Change a setting',
    description: 'Discover settings, read or change their values, or request a settings operation through its owner. Operations retain their human interaction and credential trust requirements. Local preferences belong to the answering client.',
    safety: id === 'settings.set' || id === 'settings.reset' ? 'danger' : 'safe',
    sideEffectClass: id === 'settings.set' || id === 'settings.reset' || id === 'settings.invoke' ? 'write' : 'read',
    requiredAuthority: 'account_automation', executionPlacement: id === 'settings.invoke' ? 'client' : 'account', placements: [],
    executionPlacements: id === 'settings.list' ? ['account'] : id === 'settings.invoke' ? ['client'] : ['account', 'client'],
    executionPlacementForInput: (input: unknown) => {
      if (id === 'settings.list') return 'account';
      if (id === 'settings.invoke') return 'client';
      if (typeof input !== 'object' || input === null || !('anchor' in input)) return 'client';
      if ('target' in input && typeof input.target === 'object' && input.target !== null
        && 'kind' in input.target && input.target.kind === 'public_profile_draft') return 'client';
      const declaration = readBuiltInSettingDeclarationV1(input.anchor);
      if (declaration?.storage?.prerequisite === 'ui_account_encryption_requirement') return 'client';
      return declaration?.storage && declaration.storage.scope !== 'local' ? 'account' : 'client';
    },
    bindings: { rpcMethod: id, mcpToolName: id.replaceAll('.', '_'), voiceClientToolName: id.replaceAll('.', '_') },
    surfaces: { ui: true, cli: true, rpc: true, agent: true, mcp: true, voice: true },
    inputSchema: SettingsDeclarationActionInputSchemasV1[id], outputSchema: SettingsDeclarationActionOutputSchemasV1[id],
    approvalPresentation: { summary: (input: unknown) => describeSettingsDeclarationApprovalSummaryV1(id, input),
      projectInput: (input: unknown) => projectSettingsDeclarationApprovalInputV1(id, input) },
    inputHints: { fields: id === 'settings.list'
      ? [{ path: 'pageId', title: 'Settings page', widget: 'text' }]
      : [
        { path: 'anchor', title: 'Setting', widget: 'text', required: true },
        { path: 'target', title: 'Settings target', widget: 'json',
          description: 'Optional qualified target. For the mounted Public profile draft background or Look (planet, picture and atmosphere), use {kind:"public_profile_draft",serverId} with an appearance anchor from settings.list. This requires the answering client\'s captured draft and does not Publish or Apply. This target covers only atmosphere settings, not bio, links, period or field consent.' },
        ...(id === 'settings.set' ? [{ path: 'value', title: 'New value', widget: 'json' as const, required: true }] : []),
        ...(id === 'settings.invoke' ? [{ path: 'input', title: 'Operation input', widget: 'json' as const, description: 'The declared settings operation’s structured intent.' }] : []),
      ] },
    cli: { acceptsServerId: true, commands: [{ path: id.split('.'), visibility: 'canonical' }] },
  })) satisfies readonly PreNormalizedActionSpec[]),
] as const);
