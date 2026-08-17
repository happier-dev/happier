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
    provingConsumer: 'no current positive consumer',
    unblockCondition,
  });
}

const EXTERNAL_AUTHOR_PROOF = 'packages/plugin-sdk/examples/action-contract-producer/src/index.ts';

/**
 * The only hand-authored capability-matrix facts. Canonical catalogs supply
 * identities, schemas, realms, registration/lifecycle fields, and public
 * source modules. This file records the non-inferable availability outcome and
 * maintained positive consumer (or deferred unblock) for every capability
 * family, plus exceptional HostAccess source/lifecycle facts that catalogs do
 * not own.
 */
export const CAPABILITY_MATRIX_DECLARATIONS_V1 = Object.freeze({
  manifestFamilies: Object.freeze({
    agents: available('packages/plugins/claude/src/manifest.ts'),
    providers: available('packages/plugins/openai-models/src/manifest.ts'),
    actions: available('packages/plugins/channels/src/manifest.ts'),
    commands: deferred(
      'A maintained plugin author declares a command and proves its canonical registration and invocation lifecycle.',
    ),
    tools: deferred(
      'A maintained plugin author declares a tool and proves its canonical registration and invocation lifecycle.',
    ),
    resources: available('packages/plugins/channels/src/manifest.ts'),
    transcriptActivities: available('packages/plugins/channels/src/manifest.ts'),
    sessionHeaderActions: deferred(
      'A maintained plugin author declares a session header Action and proves the canonical Session UI lifecycle.',
    ),
    browserTargets: available(EXTERNAL_AUTHOR_PROOF),
    browserActions: available(EXTERNAL_AUTHOR_PROOF),
    settings: available('packages/plugins/inspector/src/manifest.ts'),
    events: available('packages/plugins/scm-github/src/manifest.ts'),
    executionRunProfiles: available('packages/plugins/review-deepsec/src/manifest.ts'),
    notifications: deferred(
      'A maintained plugin author declares a notification category and proves the canonical notification delivery lifecycle.',
    ),
    notificationChannels: deferred(
      'A maintained plugin author declares and registers a notification channel with canonical delivery proof.',
    ),
    scmHostingProviders: available('packages/plugins/scm-github/src/manifest.ts'),
    scmBackends: available('packages/plugins/scm-git/src/manifest.ts'),
    connectedAccountDescriptors: available('packages/plugins/gemini/src/manifest.ts'),
    managedDependencies: available('packages/plugins/codex/src/manifest.ts'),
    systemTools: available('packages/plugins/antigravity/src/manifest.ts'),
    promptAssets: available('packages/plugins/review-deepsec/src/manifest.ts'),
    hooks: available('packages/plugins/gemini/src/manifest.ts'),
    requestInterceptors: available(EXTERNAL_AUTHOR_PROOF),
    voiceModelPacks: deferred(
      'A maintained Voice plugin author declares a model pack and proves the canonical Voice lifecycle.',
    ),
    voiceProviders: available('packages/plugins/openai/src/manifest.ts'),
    backgroundServices: available('packages/plugins/channels/src/manifest.ts'),
    daemonDatabases: deferred(
      'A maintained plugin author declares a daemon database and proves its canonical migration and lifecycle owner.',
    ),
    composerReferences: deferred(
      'A maintained plugin author declares composer.references and proves the canonical picker, search, and resolution lifecycle.',
    ),
    composerAttachments: deferred(
      'A maintained plugin author declares composer.attachments and proves preparation, Message admission, dispatch resolution, and fallback lifecycle.',
    ),
    composerControls: deferred(
      'A maintained plugin author declares composer.controls and proves canonical control projection and interaction lifecycle.',
    ),
    composerRegions: deferred(
      'A maintained plugin author declares composer.regions and proves canonical before/after composer mount lifecycle.',
    ),
    openableContentViewers: deferred(
      'A maintained plugin author declares an openable-content viewer and proves the canonical host read lifecycle.',
    ),
    accountCollections: available('packages/plugins/channels/src/manifest.ts'),
    webhooks: available('packages/plugins/scm-github/src/manifest.ts'),
    pluginContributionPoints: available('packages/plugins/channels/src/manifest.ts'),
    targetedPluginContributions: available('packages/plugins/channel-discord/src/manifest.ts'),
    'settings.fields': available('packages/plugins/inspector/src/manifest.ts'),
    'ui.views': available('packages/plugins/inspector/src/manifest.ts'),
    'ui.renderers': available('packages/plugins/inspector/src/manifest.ts'),
    'ui.settingsGroups': available('packages/plugins/channels/src/manifest.ts'),
    'ui.settingsPages': available('packages/plugins/channels/src/manifest.ts'),
    'ui.translations': available('packages/plugins/inspector/src/manifest.ts'),
    'mcp.servers': deferred(
      'A maintained plugin author declares and registers an MCP server through the canonical MCP lifecycle.',
    ),
    'mcp.discoverySources': available('packages/plugins/opencode/src/activate.ts'),
  }),
  services: Object.freeze({
    logger: available('packages/plugins/pi/src/agent/runtime/engine.ts'),
    storage: available('packages/plugins/channels/src/ingress.ts'),
    settings: available('packages/plugins/cursor/src/agent/acp/connection.ts'),
    secrets: deferred(
      'A maintained plugin author invokes the canonical SecretsService through an invocation lifecycle.',
    ),
    events: deferred(
      'A maintained plugin author invokes the canonical EventsService through an invocation lifecycle.',
    ),
    http: available('packages/plugins/channel-telegram/src/channelActions.ts'),
    fs: deferred(
      'A maintained plugin author invokes the canonical FileSystemService through an invocation lifecycle.',
    ),
    exec: available('packages/plugins/review-coderabbit/src/agent/reviews/nativeRun.ts'),
    providers: deferred(
      'A maintained plugin author invokes the canonical ProvidersService through an invocation lifecycle.',
    ),
    managedServices: available('packages/plugins/opencode/src/agent/runtime/server/runtimeContext.ts'),
    sessions: available('packages/plugins/channels/src/ingress.ts'),
    resources: deferred(
      'A maintained plugin author invokes the canonical ResourcesService through an invocation lifecycle.',
    ),
    mcp: available('packages/plugins/antigravity/src/agent/runtime/nativeSession.ts'),
    notifications: deferred(
      'A maintained plugin author invokes the canonical NotificationsService through an invocation lifecycle.',
    ),
    connectedAccounts: available('packages/plugins/channel-discord/src/discordActions.ts'),
    actions: available('packages/plugins/channels/src/ingress.ts'),
    targetedContributions: available('packages/plugins/channels/src/ingress.ts'),
    interactions: available('packages/plugins/cursor/src/agent/acp/extensions/handlers.ts'),
    composerContent: available(
      'packages/tests/fixtures/plugin-platform/composer-external-dogfood/src/index.mjs',
    ),
  }),
  hostAccess: Object.freeze({
    network: available('packages/plugins/opencode/src/agent/runtime/server/transport.ts'),
    'network.client': available('packages/plugins/channel-discord/src/discordGatewayWorker.ts'),
    filesystem: available('packages/plugins/antigravity/src/agent/cliPrint/observation.ts'),
    process: available('packages/plugins/antigravity/src/agent/preflight/models.ts'),
    environment: available('packages/plugins/opencode/src/agent/runtime/server/transport.ts'),
    connectedAccounts: available('packages/plugins/gemini/src/connectedAccounts/runtime.ts'),
    sessions: available('packages/plugins/channels/src/activate.ts'),
    terminal: available(
      'packages/plugins/claude/src/agent/runtime/terminal/unified/nativeSession.ts',
      {
        producer: 'apps/cli/src/agent/runtime/registry/engineRegistry/nativeAgentSessionHostServiceOwners.ts',
        lifecycle: 'session-runtime',
        specialistOwner: 'apps/cli/src/plugins/runtime/context/terminalHost.ts',
      },
    ),
    browser: deferred(
      'A plugin-owned browser product flow proves present-intent, cancellation, currentness, and cleanup through the canonical browser owner.',
      {
        producer: 'packages/protocol/src/plugins/manifest/v2.ts',
        lifecycle: 'declaration-only',
        specialistOwner: 'apps/cli/src/plugins/runtime/lifecycle/activation/policy.ts',
      },
    ),
    clipboard: deferred(
      'A plugin-owned clipboard product flow proves present-intent, platform behavior, and cleanup through the canonical clipboard owner.',
      {
        producer: 'packages/protocol/src/plugins/manifest/v2.ts',
        lifecycle: 'declaration-only',
        specialistOwner: 'apps/cli/src/plugins/runtime/lifecycle/activation/policy.ts',
      },
    ),
    externalLinks: deferred(
      'A plugin-owned external-link product flow proves present-intent and canonical URL handling through the external-link owner.',
      {
        producer: 'packages/protocol/src/plugins/manifest/v2.ts',
        lifecycle: 'declaration-only',
        specialistOwner: 'apps/cli/src/plugins/runtime/lifecycle/activation/policy.ts',
      },
    ),
    'storage.account': available('packages/plugins/channels/src/collections.ts'),
    mcp: available('packages/plugins/opencode/src/activate.ts'),
  }),
  subpaths: Object.freeze({
    '.': available('packages/plugins/channels/src/activate.ts'),
    './actions': available('packages/plugins/inspector/src/activate.ts'),
    './agents': available('packages/plugins/gemini/src/protocol/profiles.ts'),
    './agents/runtime': available('packages/plugins/kiro/src/agent/acp/runtimeDefinition.ts'),
    './async': available('packages/plugins/pi/src/agent/runtime/rpc/operations.ts'),
    './automations': available('packages/plugins/channels/src/automationResultDelivery.ts'),
    './background-services': available('packages/plugin-sdk/examples/advanced-package-root/background/refreshCatalog.ts'),
    './browser': available(EXTERNAL_AUTHOR_PROOF),
    './connected-accounts': available('packages/plugins/gemini/src/connectedAccounts/runtime.ts'),
    './collections': available('packages/plugins/channels/src/collections.ts'),
    './events': available('packages/plugins/scm-github/src/githubAutomationEventActions.ts'),
    './exec': available('packages/plugins/antigravity/src/agent/preflight/models.ts'),
    './exec/protocol-clients': available('packages/plugins/antigravity/src/agent/localharness/client/handshake.ts'),
    './fs': available('packages/plugins/antigravity/src/agent/cliPrint/observation.ts'),
    './hooks': available('packages/plugins/kimi/src/activate.ts'),
    './http': available('packages/plugins/opencode/src/agent/runtime/server/transport.ts'),
    './interactions': available('packages/plugins/antigravity/src/agent/runtime/nativeSession.ts'),
    './managed-services': available('packages/plugins/ollama/src/provider/publicManagedRuntime.ts'),
    './manifest': available('packages/plugins/channels/src/manifest.ts'),
    './mcp': available('packages/plugins/opencode/src/activate.ts'),
    './notifications': deferred('A maintained public plugin or example invokes the notification service through its canonical author entrypoint.'),
    './providers': available('packages/plugins/openai-compat/src/voice/speech.ts'),
    './protocol': available('packages/plugins/channels/src/manifest.ts'),
    './contributions': available('packages/plugins/channels/src/manifest.ts'),
    './resources': available('packages/plugins/gemini/src/agent/promptAssets/descriptors.ts'),
    './reviews': available('packages/plugins/review-deepsec/src/agent/reviews/findings.ts'),
    './scm': available('packages/plugins/scm-gitlab/src/pullRequests/gitlabCliAdapter.ts'),
    './scm/backend': available('packages/plugins/scm-git/src/capabilities.ts'),
    './scm/hosting': available('packages/plugins/scm-gitlab/src/pullRequests/gitlabCliAdapter.ts'),
    './secrets': available('packages/plugins/elevenlabs/src/protocol/voice/index.ts'),
    './sessions': available('packages/plugins/gemini/src/agent/acp/toolNames.ts'),
    './sessions/external': available('packages/plugins/antigravity/src/agent/cliPrint/observation.ts'),
    './sessions/file-stores': available('packages/plugins/antigravity/src/agent/cliPrint/conversationStore.ts'),
    './sessions/subagents': available('packages/plugins/cursor/src/agent/acp/extensions/handlers.ts'),
    './sessions/work-state': available('packages/plugins/cursor/src/agent/acp/workState/normalize.ts'),
    './settings': available('packages/plugins/antigravity/src/agentSettings/definition.ts'),
    './storage': available('packages/plugins/claude/src/agent/runtime/terminal/unified/terminalOriginLocalIds.ts'),
    './testing': available('packages/plugins/channels/src/activate.test.ts'),
    './ui': available('packages/plugins/inspector/src/ui/renderSurface.tsx'),
    './ui/build': available('packages/plugins/inspector/happier-plugin-ui.config.mjs'),
    './ui/client': available('packages/plugin-sdk/examples/public-authoring/ui/reviewPanel.web.tsx'),
    './voice': available('packages/plugins/openai-compat/src/voice/speech.ts'),
    './voice/client': available('packages/plugins/openai/src/ui/voice/protocol.ts'),
    './voice/speech': available('packages/plugins/openai-compat/src/voice/speech.ts'),
    './webhooks': available('packages/plugins/scm-github/src/webhookAction.ts'),
  }),
});
