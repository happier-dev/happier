import { describe, expect, it, vi } from 'vitest';

import { getActionSpec } from './actionSpecs.js';
import {
  ExternalSessionOperationStatusInputV1Schema,
} from '../sessions/external/operationActionSchemasV1.js';

vi.mock('../sessions/external/operationActionsV1.js', () => {
  throw new Error(
    'ActionSpec registry initialized the mixed External Sessions operation owner',
  );
});

vi.mock('../machines/peer/mediation/stream/index.js', () => {
  throw new Error(
    'ActionSpec registry initialized the mixed live-stream transport barrel',
  );
});

describe('ActionSpec registry portability', () => {
  it('initializes without evaluating mixed socket, persistence, or transport owners', () => {
    const spec = getActionSpec('sessions.external.operation.status.get');
    expect(spec.id).toBe('sessions.external.operation.status.get');
    expect(spec.inputSchema).toBe(ExternalSessionOperationStatusInputV1Schema);
  });
});
