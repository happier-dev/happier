// Internal usage-shape re-export facade.
//
// These usage types were originally hand-declared here by the AgentRuntime vertical,
// creating a split-brain with the stable, protocol-derived usage surface in
// `packages/plugin-sdk/src/usage.ts` (which re-exports the canonical
// `@happier-dev/protocol` usage schema — the ONE owner). Both public surfaces now
// derive from that single protocol schema (`packages/protocol/src/usage/*`), so no
// second definition of these shapes exists.
//
// Delete this internal facade once every source importer uses the public
// `@happier-dev/plugin-sdk` usage surface (or the canonical protocol owner)
// directly.
export type {
  SessionContextUsageSnapshotV1,
  UsageObservationCost,
  UsageObservationScope,
  UsageObservationTokens,
} from '@happier-dev/protocol';
