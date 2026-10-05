function available(provingConsumer, sourceMetadata = {}) {
  return Object.freeze({
    ...sourceMetadata,
    availabilityDisposition: 'available',
    provingConsumer,
  });
}

function deferred(unblockCondition, sourceMetadata = {}) {
  return Object.freeze({
    ...sourceMetadata,
    availabilityDisposition: 'deferred',
    provingConsumer: null,
    // A deferred capability has no host binder and no runtime lifecycle owner:
    // that absence is exactly what defers it.
    specialistOwner: null,
    lifecycleOwner: null,
    unblockCondition,
  });
}

// r0.134: capability availability follows the canonical producer, public
// registration/projection, and complete applicable lifecycle. A maintained
// consumer or loaded invocation is optional, separately truthful evidence and
// never gates the existence of an implemented Preview capability, so rows
// whose only gap was missing dogfood are `available` here with no claimed
// consumer. `deferred` is reserved for declarations whose applicable realm
// has no host authority or service owner behind them at all.

/**
 * The only hand-authored capability-matrix facts. Canonical catalogs supply
 * identities, schemas, realms, registration/lifecycle fields, and public
 * source modules, and the canonical owner maps in `capabilityMatrix.mjs`
 * supply every available row's host binder and runtime lifecycle owner. This
 * file records the non-inferable availability outcome and optional maintained
 * consumer evidence for every capability family, plus exceptional HostAccess
 * lifecycle facts that catalogs do not own. It never authors an owner for an
 * available row.
 */
export const CAPABILITY_MATRIX_DECLARATIONS_V1 = Object.freeze({
  manifestFamilies: Object.freeze({
    agents: available('packages/plugins/claude/src/manifest.ts'),
    providers: available('packages/plugins/openai-models/src/manifest.ts'),
    actions: available('packages/plugins/channels/src/manifest.ts'),
    commands: available(null),
    tools: available(null),
    resources: available('packages/plugins/channels/src/manifest.ts'),
    transcriptActivities: available('packages/plugins/channels/src/manifest.ts'),
    sessionInfoSections: available('packages/plugins/channels/src/manifest.ts'),
    sessionHeaderActions: available('packages/plugins/channels/src/manifest.ts'),
    browserTargets: available('packages/plugin-sdk/examples/action-contract-producer/src/index.ts'),
    browserActions: available('packages/plugin-sdk/examples/action-contract-producer/src/index.ts'),
    settings: available('packages/plugins/inspector/src/manifest.ts'),
    events: available('packages/plugins/scm-github/src/manifest.ts'),
    executionRunProfiles: available('packages/plugins/review-deepsec/src/manifest.ts'),
    roles: available('packages/plugin-sdk/examples/public-authoring/definition.ts'),
    workflows: available(null),
    inputTypes: available('packages/plugin-sdk/examples/public-authoring/definition.ts'),
    dragSources: available('packages/plugins/triage/src/manifest.ts'),
    dropTargets: available('packages/plugins/triage/src/manifest.ts'),
    notifications: available(null),
    notificationChannels: available(null),
    scmHostingProviders: available('packages/plugins/scm-github/src/manifest.ts'),
    scmBackends: available('packages/plugins/scm-git/src/manifest.ts'),
    connectedAccountDescriptors: available('packages/plugins/gemini/src/manifest.ts'),
    managedDependencies: available('packages/plugins/codex/src/manifest.ts'),
    systemTools: available('packages/plugins/antigravity/src/manifest.ts'),
    promptAssets: available('packages/plugins/review-deepsec/src/manifest.ts'),
    hooks: available('packages/plugins/gemini/src/manifest.ts'),
    requestInterceptors: available('packages/plugin-sdk/examples/action-contract-producer/src/index.ts'),
    voiceModelPacks: available(null),
    voiceProviders: available('packages/plugins/openai/src/manifest.ts'),
    backgroundServices: available('packages/plugins/channels/src/manifest.ts'),
    captureSources: available(null),
    daemonDatabases: available(null),
    composerReferences: available('packages/plugin-ui/fixtures/external-authoring/src/index.ts'),
    searchProviders: available('packages/plugins/triage/src/manifest.ts'),
    composerAttachments: available('packages/tests/fixtures/plugin-platform/composer-external-dogfood/src/index.mjs'),
    composerControls: available('packages/tests/fixtures/plugin-platform/composer-external-dogfood/src/index.mjs'),
    composerRegions: available('packages/plugin-ui/fixtures/external-authoring/src/index.ts'),
    openableContentViewers: available(null),
    accountCollections: available('packages/plugins/channels/src/manifest.ts'),
    webhooks: available('packages/plugins/scm-github/src/manifest.ts'),
    pluginContributionPoints: available('packages/plugin-sdk/fixtures/external-targeted-packages/target/src/index.ts'),
    targetedPluginContributions: available('packages/plugin-sdk/fixtures/external-targeted-packages/contributor/src/index.ts'),
    'settings.fields': available('packages/plugins/inspector/src/manifest.ts'),
    'ui.views': available('packages/plugins/inspector/src/manifest.ts'),
    'ui.renderers': available('packages/plugins/inspector/src/manifest.ts'),
    'ui.settingsGroups': available('packages/plugins/channels/src/manifest.ts'),
    'ui.settingsPages': available('packages/plugins/channels/src/manifest.ts'),
    'ui.translations': available('packages/plugins/inspector/src/manifest.ts'),
    'mcp.servers': available(null),
    'mcp.discoverySources': available('packages/plugins/opencode/src/manifest.ts'),
  }),
  services: Object.freeze({
    logger: available('packages/plugins/pi/src/agent/runtime/engine.ts'),
    storage: available('packages/plugins/channels/src/requiredAccountStorage.ts'),
    settings: available('packages/plugins/cursor/src/agent/acp/connection.ts'),
    secrets: available(null),
    events: available(null),
    http: available('packages/plugins/channel-telegram/src/channelActions.ts'),
    fs: available(null),
    exec: available('packages/plugins/review-coderabbit/src/agent/reviews/nativeRun.ts'),
    providers: available(null),
    managedServices: available('packages/plugins/opencode/src/agent/runtime/server/runtimeContext.ts'),
    sessions: available('packages/plugins/channels/src/ingress.ts'),
    resources: available(null),
    mcp: available(null),
    notifications: available(null),
    connectedAccounts: available('packages/plugins/channel-discord/src/discordActions.ts'),
    actions: available('packages/plugins/channels/src/ingress.ts'),
    targetedContributions: available('packages/plugins/channels/src/ingress.ts'),
    interactions: available('packages/plugins/cursor/src/agent/acp/extensions/handlers.ts'),
    composerContent: available(
      'packages/tests/fixtures/plugin-platform/composer-external-dogfood/src/index.mjs',
    ),
  }),
  hostAccess: Object.freeze({
    network: available('packages/plugin-sdk/examples/public-authoring/definition.ts'),
    'network.client': available(
      'packages/tests/fixtures/plugin-platform/out-of-tree-channel-socket-provider/src/index.mjs',
    ),
    filesystem: available('packages/plugins/opencode/src/manifest.ts'),
    process: available('packages/plugins/opencode/src/manifest.ts'),
    environment: available('packages/plugins/review-deepsec/src/manifest.ts'),
    connectedAccounts: available('packages/plugins/posthog/src/manifest.ts'),
    sessions: available('packages/plugins/claude/src/manifest.ts'),
    // The Agent-session terminal is outside an ordinary invocation's topology,
    // so it declares its own lifecycle. Its binder and lifecycle owner come
    // from the canonical HostAccess owner map like every other row's.
    terminal: available(
      'packages/plugins/claude/src/manifest.ts',
      { lifecycle: 'session-runtime' },
    ),
    browser: deferred(
      'The manifest declaration has no host authority or service owner: no canonical browser owner binds present-intent, cancellation, currentness, or cleanup yet.',
      { lifecycle: 'declaration-only' },
    ),
    clipboard: deferred(
      'The manifest declaration has no host authority or service owner: no canonical clipboard owner binds present-intent, platform behavior, or cleanup yet.',
      { lifecycle: 'declaration-only' },
    ),
    externalLinks: deferred(
      'The manifest declaration has no host authority or service owner: no canonical external-link owner binds present-intent or canonical URL handling yet.',
      { lifecycle: 'declaration-only' },
    ),
    'storage.account': available('packages/plugins/channels/src/manifest.ts'),
    mcp: available(null),
  }),
  subpaths: Object.freeze({
    '.': available('packages/plugins/channels/src/manifest.ts'),
    './actions': available('packages/plugins/inspector/src/manifest.ts'),
    './agents': available('packages/plugins/gemini/src/manifest.ts'),
    './agents/runtime': available('packages/plugins/kiro/src/agent/acp/runtimeDefinition.ts'),
    './async': available('packages/plugins/pi/src/agent/runtime/rpc/operations.ts'),
    './automations': available('packages/plugins/channels/src/automationResultDelivery.ts'),
    './background-services': available('packages/plugin-sdk/examples/advanced-package-root/background/refreshCatalog.ts'),
    './browser': available('packages/plugin-sdk/examples/action-contract-producer/src/index.ts'),
    './connected-accounts': available('packages/plugins/gemini/src/connectedAccounts/runtime.ts'),
    './first-party/connected-accounts': available('packages/plugins/codex/src/connectedAccounts/openAiCodexProfile.ts'),
    './collections': available('packages/plugins/channels/src/collections.ts'),
    './events': available('packages/plugins/scm-github/src/githubAutomationEventActions.ts'),
    './exec': available('packages/plugins/claude/src/agent/sdk/nativeExec.ts'),
    './exec/protocol-clients': available('packages/plugins/codex/src/agent/runtime/appServer/client.ts'),
    './fs': available('packages/plugins/antigravity/src/agent/cliPrint/observation.ts'),
    './hooks': available('packages/plugins/kimi/src/manifest.ts'),
    './http': available('packages/plugins/opencode/src/agent/runtime/server/transport.ts'),
    './interactions': available('packages/plugins/codex/src/agent/runtime/appServer/interactions.ts'),
    './managed-services': available('packages/plugins/ollama/src/provider/publicManagedRuntime.ts'),
    './managed-services/native': available('packages/plugins/codex/src/agent/acp/command.ts'),
    './manifest': available('packages/plugins/channels/src/manifest.ts'),
    './mcp': available('packages/plugins/opencode/src/manifest.ts'),
    './notifications': available(null),
    './providers': available('packages/plugins/openai-compat/src/voice/speech.ts'),
    './protocol': available('packages/plugins/channels/src/bindingTransition.ts'),
    './contributions': available(
      'packages/tests/fixtures/plugin-platform/packed-targeted-contribution-projection/public-protocol.ts',
    ),
    './resources': available('packages/plugins/gemini/src/agent/promptAssets/descriptors.ts'),
    './reviews': available('packages/plugins/review-deepsec/src/agent/reviews/findings.ts'),
    './scm': available('packages/plugins/scm-gitlab/src/pullRequests/gitlabCliAdapter.ts'),
    './scm/backend': available('packages/plugins/scm-git/src/capabilities.ts'),
    './scm/hosting': available('packages/plugins/scm-gitlab/src/pullRequests/gitlabCliAdapter.ts'),
    './secrets': available('packages/plugins/elevenlabs/src/protocol/voice/index.ts'),
    './sessions': available('packages/plugins/gemini/src/agent/acp/toolNames.ts'),
    './sessions/external': available('packages/plugins/antigravity/src/agent/cliPrint/observation.ts'),
    './sessions/file-stores': available('packages/plugins/antigravity/src/agent/cliPrint/conversationStore.ts'),
    './sessions/subagents': available('packages/plugins/claude/src/agent/workflowRecords/correlation.ts'),
    './sessions/work-state': available('packages/plugins/cursor/src/agent/acp/workState/normalize.ts'),
    './settings': available('packages/plugins/claude/src/agentSettings/definition.ts'),
    './storage': available('packages/plugins/claude/src/agent/runtime/terminal/unified/terminalOriginLocalIds.ts'),
    './testing': available('packages/plugins/channels/src/activate.test.ts'),
    './ui': available('packages/plugins/inspector/src/ui/renderSurface.tsx'),
    './ui/build': available('packages/plugin-sdk/examples/public-authoring/definition.ts'),
    './ui/client': available('packages/plugin-sdk/examples/public-authoring/ui/reviewPanel.web.tsx'),
    './voice': available('packages/plugins/openai-compat/src/voice/speech.ts'),
    './voice/client': available('packages/plugins/openai/src/ui/voice/protocol.ts'),
    './voice/speech': available('packages/plugins/openai-compat/src/voice/speech.ts'),
    './webhooks': available('packages/plugins/scm-github/src/webhookAction.ts'),
  }),
});
