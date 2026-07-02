import type { PluginContextV1 } from './context';
import type { RuntimeCoreV1 } from './runtime/session';
import type {
    AttachSurfaceV1,
    CheckpointSurfaceV1,
    ExternalSessionSurfaceV1,
    ForkSurfaceV1,
    HandoffSurfaceV1,
    ProviderMessageMetaEnricher,
    RuntimeFacets,
    TerminalRuntimeSurfaceV1,
} from '@happier-dev/agents';

// NOTE: This is intentionally minimal in V1. The runtime lane owns the concrete
// executable surface shapes (terminal runtime, direct sessions, handoff, etc.).
//
// The purpose of this contract is to:
// - make executable backend wiring explicit (no `apps/cli` imports from plugins)
// - provide a single engine object that can carry optional runtime-family surfaces
export type BackendEngineV1 = Readonly<{
    runtimeCore?: RuntimeCoreV1;
    facets?: RuntimeFacets;
    messageMeta?: ProviderMessageMetaEnricher;

    // Executable backend surface bindings. Manifest `surfaceHandlers[]` remains the
    // static support/projection source of truth; the host publishes these bindings
    // only for declared operations.
    terminalRuntimeSurface?: TerminalRuntimeSurfaceV1;
    externalSessionSurface?: ExternalSessionSurfaceV1;
    attachSurface?: AttachSurfaceV1;
    handoffSurface?: HandoffSurfaceV1;
    forkSurface?: ForkSurfaceV1;
    checkpointSurface?: CheckpointSurfaceV1;
}>;

export type RegisterBackendEngineV1 = Readonly<{
    backendId: string;
    create: (ctx: PluginContextV1) => BackendEngineV1 | Promise<BackendEngineV1>;
}>;
