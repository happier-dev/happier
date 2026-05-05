import type { PluginContextV1 } from './context';
import type {
    AttachSurfaceV1,
    ExternalSessionSurfaceV1,
    ProviderMessageMetaEnricher,
    RuntimeCore,
    RuntimeFacets,
    SessionHandoffSurfaceV1,
    TerminalRuntimeSurfaceV1,
} from '@happier-dev/agents';

// NOTE: This is intentionally minimal in V1. The runtime lane owns the concrete
// executable surface shapes (terminal runtime, direct sessions, handoff, etc.).
//
// The purpose of this contract is to:
// - make executable backend wiring explicit (no `apps/cli` imports from plugins)
// - provide a single engine object that can carry optional runtime-family surfaces
export type BackendEngineV1 = Readonly<{
    runtimeCore?: RuntimeCore<unknown, unknown, unknown, unknown>;
    facets?: RuntimeFacets;
    messageMeta?: ProviderMessageMetaEnricher;

    // A.6 declares these as typed substrate only. The current host runtime fails closed
    // if a plugin returns them until the owning runtime-surface packets wire execution.
    terminalRuntimeSurface?: TerminalRuntimeSurfaceV1;
    externalSessionSurface?: ExternalSessionSurfaceV1;
    attachSurface?: AttachSurfaceV1;
    sessionHandoffSurface?: SessionHandoffSurfaceV1;
}>;

export type RegisterBackendEngineV1 = Readonly<{
    backendId: string;
    create: (ctx: PluginContextV1) => BackendEngineV1 | Promise<BackendEngineV1>;
}>;
