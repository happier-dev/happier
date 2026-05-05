import type { BackendEngineV1 } from '../engine';
import { createAcpBackendEngine } from './acpSubstrate.js';
import type { AcpBackendSpecV1 } from './types';

export function defineAcpBackend(spec: AcpBackendSpecV1): BackendEngineV1 {
    return createAcpBackendEngine(spec);
}
