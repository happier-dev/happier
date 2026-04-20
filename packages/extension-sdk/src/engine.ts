import type { ExtensionContextV1 } from './context';
import type { ProviderMessageMetaEnricher, RuntimeBindings, RuntimeFacets } from '@happier-dev/agents';

// NOTE: This is intentionally minimal in V1. The runtime lane owns the concrete
// executable surface shapes (terminal runtime, direct sessions, handoff, etc.).
//
// The purpose of this contract is to:
// - make executable backend wiring explicit (no `apps/cli` imports from extensions)
// - provide a single engine object that can carry optional runtime-family surfaces
export type BackendEngineV1 = Readonly<{
    // Transitional: the current runtime lane consumes bindings through EngineAdapter/RuntimeBindings.
    // This keeps extracted backends from importing host internals while RU-07a converges on the
    // neutral execution surface contract.
    bindings?: RuntimeBindings<unknown, unknown, unknown, unknown>;
    facets?: RuntimeFacets;
    messageMeta?: ProviderMessageMetaEnricher;

    // These are optional because different backends support different runtime families.
    // Concrete types will be filled in by RU-07a once the neutral execution surface is fixed.
    terminalRuntimeSurface?: unknown;
    directSessionSurface?: unknown;
    attachSurface?: unknown;
    sessionHandoffSurface?: unknown;
}>;

export type RegisterBackendEngineV1 = Readonly<{
    backendId: string;
    create: (ctx: ExtensionContextV1) => BackendEngineV1 | Promise<BackendEngineV1>;
}>;
