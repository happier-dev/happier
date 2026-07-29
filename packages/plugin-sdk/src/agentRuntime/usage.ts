// DEPRECATED COMPATIBILITY FACADE (usage shape convergence — R5-A / DASHBOARD-VISION A-2).
//
// These usage types were originally hand-declared here by the AgentRuntime vertical,
// creating a split-brain with the stable, protocol-derived usage surface in
// `packages/plugin-sdk/src/usage.ts` (which re-exports the canonical
// `@happier-dev/protocol` usage schema — the ONE owner). Both public surfaces now
// derive from that single protocol schema (`packages/protocol/src/usage/*`), so no
// second definition of these shapes exists.
//
// This module is retained only as a re-export facade so existing importers of
// `@happier-dev/plugin-sdk/agent-runtime` keep resolving the same names.
//
// REMOVAL CONDITION: delete this facade once every first-party importer of the
// AgentRuntime usage types has been migrated to import them from the stable
// `@happier-dev/plugin-sdk` usage surface (or directly from `@happier-dev/protocol`),
// at which point the AgentRuntime index no longer needs to re-export from here.
export type {
  SessionContextUsageSnapshotV1,
  UsageObservationCost,
  UsageObservationScope,
  UsageObservationTokens,
} from '@happier-dev/protocol';
