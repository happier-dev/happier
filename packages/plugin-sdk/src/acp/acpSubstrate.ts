import type { AgentRuntimeV1 } from '../engine.js';
import type { RuntimeCoreV1 } from '../runtime/session.js';
import type { AcpBackendSpecV1 } from './types.js';

declare const acpBackendMarkerSymbol: unique symbol;

export const ACP_BACKEND_MARKER: typeof acpBackendMarkerSymbol = Symbol.for(
    'happier.plugin-sdk.acp.backend.v1',
) as typeof acpBackendMarkerSymbol;

export type AcpMarkedAgentRuntimeV1 = AgentRuntimeV1 & Readonly<{
    [ACP_BACKEND_MARKER]: AcpBackendSpecV1;
}>;

const unsupportedRuntimeCore: RuntimeCoreV1 = Object.freeze({
    async createSessionRuntime(): Promise<never> {
        throw new Error('ACP backend engines must be normalized by the host ACP runtime definition substrate before use.');
    },
    createExecutionRunBackend(): never {
        throw new Error('ACP backend engines must be normalized by the host ACP runtime definition substrate before use.');
    },
});

export function createAcpBackendEngine(spec: AcpBackendSpecV1): AcpMarkedAgentRuntimeV1 {
    return Object.freeze({
        runtimeCore: unsupportedRuntimeCore,
        [ACP_BACKEND_MARKER]: spec,
    });
}

export function isAcpBackendEngine(engine: unknown): engine is AcpMarkedAgentRuntimeV1 {
    if (engine === null || typeof engine !== 'object') {
        return false;
    }

    return ACP_BACKEND_MARKER in engine;
}

export function readAcpBackendSpec(engine: unknown): AcpBackendSpecV1 | null {
    if (!isAcpBackendEngine(engine)) {
        return null;
    }
    return engine[ACP_BACKEND_MARKER];
}
