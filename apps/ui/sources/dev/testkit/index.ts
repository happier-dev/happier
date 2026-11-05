// The barrel is imported for its first render by suites that render nothing
// agent-shaped, so it must stay free of modules that value-import runtime
// singletons. `fixtures/agentCatalogFixtures` is one such fixture: it
// reaches `@/sync/domains/scope/activeServerAccountScope` through
// `agentCatalogProjection` -> `registryUiBehavior` -> `agentUiBehaviorProjection`,
// which captures an ambient active-Home snapshot at module evaluation and made
// unrelated Teams/ops suites render against the real sync runtime. Import that
// fixture from '@/dev/testkit/fixtures/agentCatalogFixtures' directly.
// Home and Provider harnesses also reach the live server/runtime owners; import
// them from their own `harness/homeGovernanceHarness` and
// `harness/providerSettingsHarness` paths only in suites that need those owners.
// The Machine Administration selection mock also imports the real target
// state owner, which reaches Home features/HTTP through display-name lookup.
// Import it from `mocks/machineAdministrationTargetSelection` after transport
// installation when the suite also uses Home boundaries.
// Registry UI mocks derive ids from the real bundled plugin catalog. Their
// consumers already use `mocks/registryUiBehavior`; keep that graph off this root.
// Storage mocks parse real Settings, which loads the Agent/Voice catalogs.
// Keep them and the specialized ChatList boundary behind `mocks/storage` and
// `harness/chatListHarness` so unrelated render/hook tests stay light.
//
// Rule: re-export fixtures, mocks and render helpers here only when their
// transitive value imports stay free of runtime singletons and transports.
// Runtime-bearing helpers stay behind their own deep paths.
export * from './cleanup/standardCleanup';
export * from './fixtures/featureFixtures';
export * from './fixtures/actionExecutorBoundary';
export * from './fixtures/accountEncryptionCurrentness';
export * from './fixtures/releasedServerV021Compatibility';
export * from './fixtures/localServices';
export * from './fixtures/machineFixtures';
export * from './fixtures/permissionFixtures';
export * from './fixtures/projectAccountRows';
export * from './fixtures/pluginProviderDaemonProjection';
export * from './fixtures/pluginImageFixtures';
export * from './fixtures/reviewComments';
export * from "../../../../../packages/session-core/src/testkit/sessionAgentTransitionFixtures.js";
export * from './fixtures/sessionFixtures';
export * from './fixtures/sessionDraftFixtures';
export * from './fixtures/sessionWorkflowActivityFixtures';
export * from './fixtures/themeFixtures';
export * from './fixtures/transcriptFixtures';
export * from './harness/browserStorageLockBoundary';
export * from './harness/browserClipboardBoundary';
export * from './harness/sidechainTranscriptListHarness';
export * from './harness/popoverHarness';
export * from './fixtures/homeGovernanceFixtures';
export * from './fixtures/teamFixtures';
export * from './harness/approvalInbox';
export * from './harness/rootLayoutTestkit';
export * from './harness/serverScopedContextHarness';
export * from './harness/settingsViewHarness';
export * from './harness/socketHarness';
export * from './harness/toolCallsGroupHarness';
export * from './harness/toolViewHarness';
export * from './harness/toolViewTestHelpers';
export * from './hooks/createDeferred';
export * from './hooks/waitForTestEvent';
export * from './hooks/flushHookEffects';
export * from './hooks/renderHook';
export * from './performance/counts';
export * from './performance/timerCensus';
export * from './mocks/agentInput';
export * from './mocks/accountEncryptionMode';
export * from './mocks/icons';
export * from './mocks/virtualizedList';
export * from './mocks/legendList';
export * from './mocks/gestureHandler';
export * from './mocks/modal';
export * from './mocks/mainAppTabState';
export * from './mocks/reactNative';
export * from './mocks/router';
export * from './mocks/reactNavigation';
export * from './mocks/serverProfiles';
export * from './mocks/serverFetch';
export * from './mocks/sessionMachineReachability';
export * from './mocks/serverAccountRequestContext';
export * from './mocks/sync';
export * from './mocks/persistence';
export * from './mocks/popover';
export * from './mocks/capabilities';
export * from './mocks/syncOps';
export * from './mocks/serverScopedRpc';
export * from './mocks/text';
export * from './mocks/tokenStorage';
export * from './mocks/toolSectionView';
export * from './mocks/unistyles';
export * from './render/renderScreen';
export * from './render/renderInCollectionLayout';
export * from './render/collectRenderedTestIds';
export * from './render/renderWithAppProviders';
export * from './sessionTranscriptSource';
