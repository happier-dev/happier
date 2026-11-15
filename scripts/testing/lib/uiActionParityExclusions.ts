// Exact source operands audited at their canonical forwarding or presentation owner.
// Unknown siblings remain findings; a file is never exempt as a whole.
// WorkflowBlockListEditor.onChange is controlled, unsaved document editing:
// insert/remove/move/replace use workflowDefinitionEditV1's Protocol operations,
// and WorkflowEditorHostScreen.changeSnapshot owns the same history/revision as
// workflow.authoring.draft.edit (FIN AMEND-FIN-0.7, 04 §4.7). These local buffer
// edits need no Off/Ask admission. Agent access still uses draft.edit admission;
// Save/Run and transport/settings/platform effects retain their Actions.
export const SOURCE_PARITY_EXCLUSIONS: readonly Readonly<{
  filePath: string; operation: string; reason: string;
}>[] = [
  {
    filePath: 'apps/ui/sources/components/sessions/new/hooks/useCreateNewSession.ts',
    operation: 'seedAndOpenNewSession:submittedPoolRecovery',
    reason: 'Post-launch Pool refusal recovery restores the already-admitted submitted draft after its launcher retires. This is not a new user authoring open; a fresh Action would re-admit the existing operation and could block its recovery.',
  },
  {
    filePath: 'apps/ui/sources/sync/domains/workflows/workflowRunDetailActions.ts',
    operation: 'AsExpression: actionId as ActionId',
    reason: 'Private call helper forwards the literal workflow.run.* operands authored by this same detail facade to callWorkflowAction; every concrete call remains scanned.',
  },
  {
    filePath: 'apps/ui/sources/sync/ops/scm/machineScm.ts',
    operation: 'Identifier: actionId',
    reason: 'The shared SCM facade parses its published RPC method with ActionIdSchema before invokeUiScmAction admission; concrete facade methods retain their RPC owner and the Action executor owns all effects.',
  },
  {
    filePath: 'apps/ui/sources/sync/ops/sessionScm.ts',
    operation: 'Identifier: actionId',
    reason: 'Session SCM parses its published method with ActionIdSchema before shared invokeUiScmAction admission; the injected transport executes only beneath that admission.',
  },
  {
    filePath: 'apps/ui/sources/sync/ops/scmDiffSummary/savedResultOperations.ts',
    operation: 'PropertyAccessExpression: retry.actionId',
    reason: 'ScmDiffSummaryMarksCleanupFailureSchema.parse fixes retry.actionId to the declared scm.diffSummary.reviewed.unmark literal before the retry re-enters invokeUiScmAction (Protocol scm/diffSummaryResult.ts).',
  },
  {
    filePath: 'apps/ui/sources/sync/ops/workspaceFileSystem/fileReadWrite.ts',
    operation: 'Identifier: actionId',
    reason: 'The workspace read delivery callback receives the admitted FilesystemActionExecution from invokeWorkspaceFilesystemAction and preserves it through callAdmittedFilesystemActionRpc; this is byte delivery below the existing Action admission.',
  },
  {
    filePath: 'apps/ui/sources/components/settings/teams/identity/identityAdministrationClient.ts',
    operation: 'teams.invitations.accept.prepareApproval',
    reason: 'The generic HomeDomainActionIdV1 transport includes this internal approval custodian; its spec disables every UI/agent surface and the identity client exposes no invitation-preparation method (specs/teams.ts, approvalPreparation.ts).',
  },

  {
    filePath: 'apps/ui/sources/components/atmosphere/atmosphereSettings.ts',
    operation: 'project:invokeAtmospherePictureOperation',
    reason: 'Declared settings.invoke picture operation mutates the Project row only below Action admission',
  },
  {
    filePath: 'apps/ui/sources/components/navigation/shell/appRail/AppRailMachines.tsx',
    operation: 'local:machinesRailSeenV1',
    reason: 'Machine rail acknowledgement is device-local seen state (R4), not a machine or Account setting',
  },
  {
    filePath: 'apps/ui/sources/components/machines/vitals/MachineVitalsRangeBar.tsx',
    operation: 'local:machineVitalsRangeV1',
    reason: 'Remembered chart history range is device-local presentation state (plan 60 §4.1)',
  },
  {
    filePath: 'apps/ui/sources/components/machines/guard/activity/useGuardWayBack.ts',
    operation: 'PropertyAccessExpression: item.actionId',
    reason: 'Activity forwards the daemon ActionIdSchema-validated way-back reference through the Action executor',
  },
  {
    filePath: 'apps/ui/sources/activity/notifications/guardStopWarningLifecycle.ts',
    operation: 'PropertyAccessExpression: command.actionId',
    reason: 'Guard push forwards readGuardStopWarningPushActionV1 schema-admitted controls through the Action executor',
  },
  {
    filePath: "apps/ui/sources/activity/adapters/desktop/runtime/DesktopActivityOverlayRuntime.shared.tsx",
    operation: "PropertyAccessExpression: command.actionId",
    reason: "ActivityInteractionCommand and the verified desktop direct-action allowlist produce canonical Action ids; the overlay forwards their payload to the same Action executor.",
  },
  {
    filePath: "apps/ui/sources/activity/adapters/desktop/runtime/desktopActivityOverlayActions.ts",
    operation: "Identifier: actionId",
    reason: "The exact desktop bridge request is UiActionDispatchRequestV1Schema-validated before the unpacked Action id is forwarded.",
  },
  {
    filePath: "apps/ui/sources/activity/adapters/ios/runtime/ActivitySurfacesRuntime.tsx",
    operation: "AsExpression: command.actionId as ActionId",
    reason: "resolveActivityInteractionCommand produces the existing canonical Action intent; target/current-surface checks precede forwarding.",
  },
  {
    filePath: "apps/ui/sources/components/appShell/commandPalette/CommandPaletteProvider.tsx",
    operation: "AsExpression: actionId as any",
    reason: "The command builder callback is a typed ActionId transport; concrete commands are authored and walked in buildCommandPaletteCommands.",
  },
  {
    filePath: "apps/ui/sources/components/appShell/commandPalette/buildCommandPaletteCommands.ts",
    operation: "PropertyAccessExpression: notch.id",
    reason: "The notch comes from the canonical catalog Map indexed by desktop.notch.set; voice controls are readonly literal rows. Both enter actions.execute.",
  },
  {
    filePath: "apps/ui/sources/components/appShell/currentUiContext/currentUiContextVoiceToolPort.ts",
    operation: "SpreadElement: ...args",
    reason: "The Parameters<PluginSurfaceHostActionExecute> rest tuple is forwarded unchanged; concrete current-context commands supply the Action ids outside these default transport callbacks.",
  },
  {
    filePath: "apps/ui/sources/components/appShell/runtime/ClientActionReverseRuntime.tsx",
    operation: "SpreadElement: ...args",
    reason: "The contributed reverse-RPC handler supplies the unchanged executor tuple; createCurrentUiContributedActionRpcHandler owns the admitted request.",
  },
  {
    filePath: "apps/ui/sources/components/appShell/workspace/workspaceEntityDrop.ts",
    operation: "PropertyAccessExpression: effect.actionId",
    reason: "isWorkspaceActionId checks the existing EntityDropEffectV1 Action against its canonical family before Action execution.",
  },
  {
    filePath: "apps/ui/sources/components/approvals/executeWithInPlaceApprovalReview.ts",
    operation: "SpreadElement: ...args",
    reason: "In-place approval wraps the existing front-door execute tuple unchanged and observes its result; input.execute supplies concrete invocation.",
  },
  {
    filePath: "apps/ui/sources/components/plugins/surfaces/pluginSurfaceActionControls.ts",
    operation: "ConditionalExpression: hostId?.success ? hostId.data : 'action.invoke'",
    reason: "PluginInvocableActionIdSchema accepts host ids; contributed references use the existing action.invoke dispatch. This is the shared plugin invocation boundary, not a new effect.",
  },
  {
    filePath: "apps/ui/sources/components/plugins/surfaces/pluginSurfaceActionDispatch.ts",
    operation: "AsExpression: hostActionId.data as ActionId",
    reason: "PluginInvocableActionIdSchema.safeParse(input.action) must succeed before executeHostAction forwards its data.",
  },
  {
    filePath: "apps/ui/sources/components/plugins/surfaces/pluginWidgetAreaHost.ts",
    operation: "Identifier: actionId",
    reason: "Protocol createPluginWidgetAreaHostPortV1 validates PluginUiWidgetAreaRequestV1Schema, then supplies WidgetInstanceActionIdV1 to the injected executor.",
  },
  {
    filePath: "apps/ui/sources/components/plugins/surfaces/usePluginSurfaceActionApproval.ts",
    operation: "SpreadElement: ...args",
    reason: "Parameters<typeof executor> forwarding preserves ordinary and confirmed front-door calls; wrapper only observes approval receipts.",
  },
  {
    filePath: "apps/ui/sources/components/projects/deployments/useCatalogAppPreparation.ts",
    operation: "Identifier: actionId",
    reason: "prepareCatalogAppPublish authors deployments.publish.prepare and validates its input/result; the callback only adds captured UI scope.",
  },
  {
    filePath: "apps/ui/sources/components/sessions/agentInput/sessionActions/useSessionAgentInputExtraActionChips.tsx",
    operation: "Identifier: actionId",
    reason: "createScreenCaptureAttachmentActions has a screenCapture.start-only executor callback and authors both screenshot/recording inputs.",
  },
  {
    filePath: "apps/ui/sources/components/sessions/board/note/SessionBoardNoteEditorCard.tsx",
    operation: "Identifier: action",
    reason: "React Navigation dispatch resumes the original blocked before-remove navigation after save/discard; its operand is a navigation action, not a Happier Action id.",
  },
  {
    filePath: "apps/ui/sources/components/sessions/composer/ComposerEntityDropTarget.tsx",
    operation: "AsExpression: effect.actionId as ActionId",
    reason: "The shared entity-drop resolver produces EntityDropEffectV1 after account/currentness admission; execution enters the ordinary Action executor.",
  },
  {
    filePath: "apps/ui/sources/components/sessions/localServices/useServicesOpenInBrowser.ts",
    operation: "Identifier: actionId",
    reason: "Typed actionExecute forwards the existing useOpenBrowserTargetInWorkspace callback; that canonical opener authors browser.workspace.open.",
  },
  {
    filePath: "apps/ui/sources/components/sessions/terminal/jump/useTerminalJumpStep.tsx",
    operation: "PropertyAccessExpression: activation.actionId",
    reason: "buildTerminalJumpModel owns each activation Action and input; this callback looks up an exact displayed activation and enters the Action front door.",
  },
  {
    filePath: "apps/ui/sources/components/settings/connectedServices/npm/NpmRegistryProfilesSection.tsx",
    operation: "Identifier: actionId",
    reason: "LocalRegistryMutation derives the daemon mutation request and constructs the plugins.npm_registry_profiles operation before the mounted Action executor; this is a finite existing registered family.",
  },
  {
    filePath: "apps/ui/sources/components/widgets/area/useProjectWidgetAreaBinding.ts",
    operation: "PropertyAccessExpression: operation.actionId",
    reason: "The typed WidgetAreaPort operation is validated by the existing widget-area owner; buildWidgetAreaActionInputV1 builds the matching input before the same Action executor.",
  },
  {
    filePath: "apps/ui/sources/components/workflows/editor/useWorkflowSessionBinding.ts",
    operation: "Identifier: actionId",
    reason: "The mounted Workflow draft registration forwards WorkflowMountedDraftActions.execute, a local draft-owner operation under workflow.authoring.draft.edit admission, rather than declaring another Action.",
  },
  {
    filePath: "apps/ui/sources/hooks/ui/useClipboardWrite.ts",
    operation: "Identifier: actionId",
    reason: "writeClipboardStringFromUi supplies only clipboard.write to this callback; it retains native Action policy and the web gesture-owned implementation.",
  },
  {
    filePath: "apps/ui/sources/sync/api/account/apiAccountName.ts",
    operation: "Identifier: input",
    reason: "captureAccountProfileAction binds account.name.set before execute(input); the input is a schema-parsed object, not another Action id.",
  },
  {
    filePath: "apps/ui/sources/sync/api/account/apiUsername.ts",
    operation: "Identifier: input",
    reason: "captureAccountProfileAction binds account.username.check/release/set at construction. execute(input) receives only the schema-parsed operation input.",
  },
  {
    filePath: "apps/ui/sources/sync/api/discussions/discussionActions.ts",
    operation: "Identifier: actionId",
    reason: "The generic actionId extends keyof ClientActionInputs, an explicit finite request map; all discussions methods use this shared run adapter.",
  },
  {
    filePath: "apps/ui/sources/sync/api/machines/managedMachineOrigination.ts",
    operation: "Identifier: actionId",
    reason: "This branch narrows actionId to machines.managed.cancel before the canonical managed Machine Action client executes the matching schema-parsed input.",
  },
  {
    filePath: "apps/ui/sources/sync/api/session/sessionFollowApi.ts",
    operation: "PropertyAccessExpression: args.actionId",
    reason: "Existing SessionFollowActionIdV1 adapter forwards the canonical family and parses results. sessionFollowAction is an ActionExecutorDeps terminal, not independent UI ingress.",
  },
  {
    filePath: "apps/ui/sources/sync/api/session/sessionReadStateAction.ts",
    operation: "PropertyAccessExpression: args.actionId",
    reason: "ActionExecutorDeps sessionReadStateAction terminal forwards its admitted actionId/input to the canonical read-state owner.",
  },
  {
    filePath: "apps/ui/sources/sync/domains/browser/automation/reverseDispatchHandler.ts",
    operation: "PropertyAccessExpression: request.data.actionId",
    reason: "UiBrowserAutomationDispatchRequestV1Schema and the selected spec input schema validate the admitted reverse request before the browser runtime Action executor.",
  },
  {
    filePath: "apps/ui/sources/sync/domains/input/slashCommands/executeSessionComposerResolution.ts",
    operation: "Identifier: actionId",
    reason: "Composer resolution owns the Action id; this branch explicitly admits subagents.plan.start, subagents.delegate.start or voice_agent.start and executes their shared draft builder result.",
  },
  {
    filePath: "apps/ui/sources/sync/domains/plugins/settings/accountPluginDataEraseAction.ts",
    operation: "Identifier: input",
    reason: "defaultAction.execute receives PluginAccountDataEraseActionInputV1, the whole plugin-data erasure request, rather than an Action id; the existing action owner performs erasure.",
  },
  {
    filePath: "apps/ui/sources/sync/domains/transfers/runtime/transferRuntime/plumbing/filesystemTransferActionClient.ts",
    operation: "PropertyAccessExpression: params.actionId",
    reason: "FilesystemTransferActionParams has the canonical FilesystemTransferActionId family; the entire transfer enters invokeWorkspaceFileSystemAction before admitted transport.",
  },
  {
    filePath: "apps/ui/sources/sync/ops/actions/clientActionReverseDispatch.ts",
    operation: "Identifier: actionId",
    reason: "UiActionDispatchRequestV1Schema validates the reverse envelope, then admittedClientActionId preserves the original admission through the canonical executor.",
  },
  {
    filePath: "apps/ui/sources/sync/ops/actions/defaultActionExecutor.ts",
    operation: "Identifier: actionId",
    reason: "The canonical Action executor composes typed ActionExecutorDeps terminals, whole-catalog prepare/execute forwarding and native-managed dispatch. These existing internal calls do not introduce UI capabilities; concrete entry callers remain independently walked.",
  },
  {
    filePath: "apps/ui/sources/sync/ops/actions/defaultActionExecutor.ts",
    operation: "PropertyAccessExpression: request.actionId",
    reason: "The canonical Action executor composes typed ActionExecutorDeps terminals, whole-catalog prepare/execute forwarding and native-managed dispatch. These existing internal calls do not introduce UI capabilities; concrete entry callers remain independently walked.",
  },
  {
    filePath: "apps/ui/sources/sync/ops/actions/defaultActionExecutor.ts",
    operation: "Identifier: args",
    reason: "The canonical Action executor composes typed ActionExecutorDeps terminals, whole-catalog prepare/execute forwarding and native-managed dispatch. These existing internal calls do not introduce UI capabilities; concrete entry callers remain independently walked.",
  },
  {
    filePath: "apps/ui/sources/sync/ops/actions/defaultActionExecutor.ts",
    operation: "PropertyAccessExpression: args.actionId",
    reason: "The canonical Action executor composes typed ActionExecutorDeps terminals, whole-catalog prepare/execute forwarding and native-managed dispatch. These existing internal calls do not introduce UI capabilities; concrete entry callers remain independently walked.",
  },
  {
    filePath: "apps/ui/sources/sync/ops/actions/defaultActionExecutor.ts",
    operation: "Identifier: publicEndpointActionId",
    reason: "The canonical Action executor composes typed ActionExecutorDeps terminals, whole-catalog prepare/execute forwarding and native-managed dispatch. These existing internal calls do not introduce UI capabilities; concrete entry callers remain independently walked.",
  },
  {
    filePath: "apps/ui/sources/sync/ops/actions/defaultActionExecutor.ts",
    operation: "PropertyAccessExpression: native.actionId",
    reason: "The canonical Action executor composes typed ActionExecutorDeps terminals, whole-catalog prepare/execute forwarding and native-managed dispatch. These existing internal calls do not introduce UI capabilities; concrete entry callers remain independently walked.",
  },
  {
    filePath: "apps/ui/sources/sync/ops/actions/defaultRuntimeActionExecutor.ts",
    operation: "Identifier: args",
    reason: "RuntimeActionExecute forwards its entire already-admitted request to the peer-mediation fallback; args is not an Action-id operand.",
  },
  {
    filePath: "apps/ui/sources/sync/ops/actions/workflowActionDeps.ts",
    operation: "Identifier: args",
    reason: "The Workflow Action terminal selects account versus relay transport for the same admitted request; args is its whole envelope, not another Action id.",
  },
  {
    filePath: "apps/ui/sources/sync/ops/connectedAccounts/connectedAccountDaemon.ts",
    operation: "Identifier: actionId",
    reason: "CONNECTED_ACCOUNT_AUTHENTICATION_ACTION_ID_BY_OPERATION is the existing canonical immutable operation-to-Action map; the callback adds scope and request identity.",
  },
  {
    filePath: "apps/ui/sources/utils/platform/desktopWindowActionDispatch.ts",
    operation: "PropertyAccessExpression: admission.actionId",
    reason: "The desktop window admission reader returns the canonical admitted actionId; private capture navigation branches remain local while ordinary ids enter executor.execute.",
  },
  {
    filePath: "apps/ui/sources/voice/dictation/useTextInputDictation.ts",
    operation: "Identifier: actionId",
    reason: "executeMountedCurrentUiContextCommand supplies only ui.current_context.read and ui.current_context.command.invoke; the callback forwards its literal family.",
  },
  {
    filePath: "apps/ui/sources/voice/registry/externalVoiceProviderActivation.ts",
    operation: "Identifier: actionInput",
    reason: "PluginSettingsActionInput is an entire declared plugin-settings action request. declaredActions lookup and plugin settings admission own its action; it is not a host ActionId argument.",
  },
  {
    filePath: "apps/ui/sources/voice/tools/handlers.ts",
    operation: "Identifier: actionId",
    reason: "Voice tool handling resolves actionId against the canonical Action spec before executeSpokenAction; the shared spoken Action admission and executor remain the effect owner.",
  },
  {
    filePath: "apps/ui/sources/components/appShell/panes/PaneColumnsHost.tsx",
    operation: "local:rightPaneWidthPx",
    reason: "Completed pane resize/reset stores device presentation geometry only",
  },
  {
    filePath: "apps/ui/sources/components/appShell/panes/PaneColumnsHost.tsx",
    operation: "local:detailsPaneWidthPx",
    reason: "Completed pane resize/reset stores device presentation geometry only",
  },
  {
    filePath: "apps/ui/sources/components/appShell/panes/PaneColumnsHost.tsx",
    operation: "local:bottomPaneHeightPx",
    reason: "Completed pane resize/reset stores device presentation geometry only",
  },
  {
    filePath: "apps/ui/sources/components/appShell/panes/PaneColumnsHost.tsx",
    operation: "local:sessionColumnWidthPx",
    reason: "Completed pane resize/reset stores device presentation geometry only",
  },
  {
    filePath: "apps/ui/sources/components/navigation/shell/SidebarNavigator.tsx",
    operation: "local:sidebarWidthPx",
    reason: "Completed sidebar resize/reset stores device presentation geometry only",
  },
  {
    filePath: "apps/ui/sources/components/navigation/shell/SidebarNavigator.tsx",
    operation: "local:sidebarCollapsed",
    reason: "Store effect registered to mounted shell.column.set; UI visibility requests enter that Action",
  },
  {
    filePath: "apps/ui/sources/components/settings/shell/SettingsShell.tsx",
    operation: "local:settingsNavSidebarWidthPx",
    reason: "Completed Settings navigation resize/reset stores device presentation geometry only",
  },
  {
    filePath: "apps/ui/sources/components/ui/lists/collection/useCollectionRailWidth.ts",
    operation: "local:collectionRailWidthsV1",
    reason: "Collection resize/reset stores only device rail geometry by resizeKey",
  },
  {
    filePath: "apps/ui/sources/components/terminal/embedded/keys/terminalArrowPadState.ts",
    operation: "local:terminalArrowPadPlacement",
    reason: "Per-orientation terminal pad drag geometry; tucked interaction is separately persisted",
  },
  {
    filePath: "apps/ui/sources/hooks/ui/useTabState.ts",
    operation: "local:mainAppTab",
    reason: "The phone's last-selected main tab is device-local navigation state, not a preference (OWNER-RULINGS 2026-11-15 'Phone last-selected tab is device-local'); a tap never reaches the Account or an Action",
  },
  {
    filePath: "apps/ui/sources/sync/domains/machines/administration/selectionPreferences.ts",
    operation: "account:machineAdministrationTargetsLocalV1",
    reason: "Shared local selection effect owner below settings.set machines.administrationTarget and plugins.execution_origin.set/clear",
  },
  {
    filePath: "apps/ui/sources/sync/ops/actions/petChooseAction.ts",
    operation: "local:petsSelectedPetOverride",
    reason: "Device choice effect below canonical uiPetChooseAction; Account selection clears override only after success",
  },
  {
    filePath: "apps/ui/sources/sync/store/sessionCompanion.ts",
    operation: "local:sessionCompanionPreferencesBySessionV1",
    reason: "Shared realm-qualified companion effect owner beneath session.presentation.apply and widgets.item.*",
  },
  {
    filePath: "apps/ui/sources/sync/engine/settings/themeProfileMigration.ts",
    operation: "local:themeProfiles",
    reason: "Legacy theme-profile migration cleanup/selection projection after Account migration, not a person setting operation",
  },
  {
    filePath: "apps/ui/sources/sync/engine/settings/themeProfileMigration.ts",
    operation: "local:themeProfileSelection",
    reason: "Legacy theme-profile migration cleanup/selection projection after Account migration, not a person setting operation",
  },
  {
    filePath: "apps/ui/sources/components/pets/desktop/actions/desktopPetOverlayActions.ts",
    operation: "local:desktopPetOverlayEnabledOverride",
    reason: "Injected useApplyLocalSettings writer dispatches the canonical pets.desktopOverlayDeviceOverride settings.set declaration",
  },
  {
    filePath: "apps/ui/sources/app/(app)/settings/features.tsx",
    operation: "Identifier: setting",
    reason: "resolveFeatureToggleSetting returns a registry-declared SettingRef; useSettingActionFeedback submits it through settings.set.",
  },
  {
    filePath: "apps/ui/sources/components/onboarding/personalize/usePersonalizeFlow.ts",
    operation: "Identifier: write",
    reason: "Personalize injects useSettingActionFeedback into its controller; write is a declared setting plus its value and reaches settings.set.",
  },
  {
    filePath: "apps/ui/sources/components/sessions/shell/useSessionListViewOptionWriter.ts",
    operation: "Identifier: setting",
    reason: "The menu resolves its finite map of SESSION_SETTINGS SettingRefs and calls useSettingActionFeedback, preserving the same settings.set admission as Settings.",
  },
  {
    filePath: "apps/ui/sources/components/settings/connectedServices/ProviderUsageGaugeSettingsGroup.tsx",
    operation: "PropertyAccessExpression: settings.gaugeVisible",
    reason: "Both default and supplied SettingRefs enter useSettingActionFeedback and settings.set; property access does not bypass admission.",
  },
  {
    filePath: "apps/ui/sources/components/settings/connectedServices/ProviderUsageGaugeSettingsGroup.tsx",
    operation: "PropertyAccessExpression: settings.gaugeWindow",
    reason: "Both default and supplied SettingRefs enter useSettingActionFeedback and settings.set; property access does not bypass admission.",
  },
  {
    filePath: "apps/ui/sources/components/settings/connectedServices/ProviderUsageGaugeSettingsGroup.tsx",
    operation: "PropertyAccessExpression: settings.gaugeLabels",
    reason: "Both default and supplied SettingRefs enter useSettingActionFeedback and settings.set; property access does not bypass admission.",
  },
  {
    filePath: "apps/ui/sources/components/settings/connectedServices/ProviderUsageGaugeSettingsGroup.tsx",
    operation: "PropertyAccessExpression: settings.routingHints",
    reason: "Both default and supplied SettingRefs enter useSettingActionFeedback and settings.set; property access does not bypass admission.",
  },
  {
    filePath: "apps/ui/sources/components/settings/keyboard/KeyboardShortcutsSettingsView.tsx",
    operation: "Identifier: setting",
    reason: "resolveKeyboardCommandSetting indexes command registry declarations carrying commandStorage bindings; writes use settings.set through useSettingActionFeedback.",
  },
  {
    filePath: "apps/ui/sources/components/settings/machines/managed/MachineDefaultsView.tsx",
    operation: "PropertyAccessExpression: model.setting",
    reason: "readMachineRetentionDefaultsModel returns category-specific declared SettingRefs; the selected model.setting enters the shared settings.set writer.",
  },
  {
    filePath: "apps/ui/sources/components/settings/prompts/context/AccountMemoryDefaultsSection.tsx",
    operation: "Identifier: setting",
    reason: "Typed local write helper takes PROMPTS_CONTEXT_SETTINGS refs from the rendered three rows and delegates to useSettingActionWriter/settings.set.",
  },
  {
    filePath: "apps/ui/sources/components/settings/shell/useSettingActionFeedback.ts",
    operation: "Identifier: setting",
    reason: "This is the canonical presentation wrapper around useSettingActionWriter; its dynamic argument deliberately forwards declared SettingActionAddress to settings.set.",
  },
  {
    filePath: "apps/ui/sources/components/settings/sourceControl/FileEditorAiSuggestionSettings.tsx",
    operation: "PropertyAccessExpression: props.setting",
    reason: "Reusable field helpers take SOURCE_CONTROL_SETTINGS SettingRefs from their callers and send them through useSettingActionFeedback/settings.set.",
  },
  {
    filePath: "apps/ui/sources/components/settings/sourceControl/FileEditorAiSuggestionSettings.tsx",
    operation: "Identifier: setting",
    reason: "Reusable field helpers take SOURCE_CONTROL_SETTINGS SettingRefs from their callers and send them through useSettingActionFeedback/settings.set.",
  },
  {
    filePath: "apps/ui/sources/components/ui/lists/collection/useSetCollectionSpacesEnabled.ts",
    operation: "ArrowFunction: (current) => {\n        if (!next) return current[listKey] ? { [listKey]: false } : null;\n        const delta = {\n          ...(current.collectionSpacesEnabled\n            ? {}\n            : { collectionSpacesEnabled: true }),\n          ...(current[listKey] ? {} : { [listKey]: true }),\n        };\n        return Object.keys(delta).length ? delta : null;\n      }",
    reason: "The functional delta uses canonical COLLECTION_SPACE_ENABLEMENT_SETTING_KEYS_V1; useApplySettings resolves writable declaration bindings and dispatches settings.set for each changed key.",
  },
  {
    filePath: "apps/ui/sources/embed/bridge/EmbedBridgeRuntime.tsx",
    operation: "Identifier: delta",
    reason: "Embed style application only projects the parent frame style into this isolated renderer; embedStyleTheme applies uiFontScale with persist:false. It does not save a person preference.",
  },
  {
    filePath: "apps/ui/sources/embed/preview/EmbedPreviewScreen.tsx",
    operation: "Identifier: delta",
    reason: "Embed style application only projects the parent frame style into this isolated renderer; embedStyleTheme applies uiFontScale with persist:false. It does not save a person preference.",
  },
  {
    filePath: "apps/ui/sources/sync/engine/settings/syncSettings.ts",
    operation: "Identifier: nextSettings",
    reason: "The sync engine applies a versioned remote settings snapshot to the store; it is hydration/reconciliation, not a person-originated setter.",
  },
  {
    filePath: "apps/ui/sources/sync/engine/socket/socket.ts",
    operation: "Identifier: settings",
    reason: "The Account update socket consumer applies the received settings/version after shouldContinue; it is inbound reconciliation beneath transport ownership.",
  },
  {
    filePath: "apps/ui/sources/sync/ops/actions/defaultActionExecutor.ts",
    operation: "Identifier: delta",
    reason: "The canonical admitted settings Action owner receives writeLocalSettings; applyLocalSettings is the effect after executor admission, not a competing UI ingress.",
  },
  {
    filePath: "apps/ui/sources/sync/store/domains/settings.ts",
    operation: "Identifier: delta",
    reason: "subscribeLocalSettingsChanges replays externally persisted local settings with persist:false, avoiding a feedback loop; it is store reconciliation.",
  },
  {
    filePath: "apps/ui/sources/sync/store/hooks.ts",
    operation: "ArrowFunction: current => {\n          const next = value(current[name]);\n          return next === null ? null : delta(next);\n        }",
    reason: "Generic mutable-setting hooks construct a typed sparse delta and delegate to useApplySettings/useApplyLocalSettings, whose only writes dispatch settings.set through the canonical declaration owner.",
  },
  {
    filePath: "apps/ui/sources/sync/store/hooks.ts",
    operation: "CallExpression: delta(value)",
    reason: "Generic mutable-setting hooks construct a typed sparse delta and delegate to useApplySettings/useApplyLocalSettings, whose only writes dispatch settings.set through the canonical declaration owner.",
  },
  {
    filePath: "apps/ui/sources/sync/store/hooks.ts",
    operation: "PropertyAssignment: [name]: value",
    reason: "Generic mutable-setting hooks construct a typed sparse delta and delegate to useApplySettings/useApplyLocalSettings, whose only writes dispatch settings.set through the canonical declaration owner.",
  },
  {
    filePath: "apps/ui/sources/sync/store/settingsWriters.ts",
    operation: "Identifier: delta",
    reason: "The low-level forwarding helper is used only by desktop QA/CUA __MCP__.applyHappierLocalSettings instrumentation, not by a user-facing control. The ordinary UI adapter loops elsewhere in this module dispatch settings.set.",
  },
  {
    filePath: "apps/ui/sources/sync/store/settingsWriters.ts",
    operation: "Identifier: declaration",
    reason: "Declaration-derived Account/local adapter writes dispatch useSettingActionWriter/settings.set; dynamic declaration is obtained from the canonical BUILT_IN_SETTINGS_DECLARATIONS_V1 and writable whole-value storage binding.",
  },
  {
    filePath: "apps/ui/sources/voice/settings/panels/realtime/RealtimeProviderFields.tsx",
    operation: "Identifier: setting",
    reason: "Voice field resolves its contributed settingRef, parses through the owner binding, and invokes useSettingActionWriter/settings.set with the field lifetime signal.",
  },
  {
    filePath: "apps/ui/sources/components/appShell/AppCrashRecoveryBoundary.tsx",
    operation: "setStringAsync",
    reason: "Emergency root crash fallback can copy diagnostics after AppBoot/AuthProvider and its Action runtime fail.",
  },
  {
    filePath: "apps/ui/sources/components/web/WebCryptoUnsupportedScreen.tsx",
    operation: "setStringAsync",
    reason: "Unsupported-crypto bootstrap replaces AppBoot/AuthProvider before Account Action runtime exists.",
  },
  {
    filePath: "apps/ui/sources/hooks/ui/useClipboardWrite.web.ts",
    operation: "setClipboardStringSafe",
    reason: "Web text clipboard gesture exception is owned by writeClipboardStringFromUi and its synchronous platform outcome tests.",
  },
  {
    filePath: "apps/ui/sources/hooks/auth/usePairingSession.ts",
    operation: "machines.pairing.create",
    reason: "Present-person device-enrollment credential boundary: actionExecutor.machineConnection.test.ts refuses agent/MCP even after approval and asserts no pairing link disclosure.",
  },
];
