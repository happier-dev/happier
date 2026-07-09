import type { AgentRuntimeV1 } from '../engine.js';
import { createAcpBackendEngine } from './acpSubstrate.js';
import type { AcpBackendSpecV1 } from './types.js';

export function defineAcpBackend(spec: AcpBackendSpecV1): AgentRuntimeV1 {
    return createAcpBackendEngine(spec);
}
