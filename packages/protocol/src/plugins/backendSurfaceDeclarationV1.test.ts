import { describe, expect, it } from 'vitest';

import {
  BackendSurfaceAvailabilityV1Schema,
  BackendSurfaceDeclarationV1Schema,
  BackendSurfaceKindV1Schema,
  BackendSurfaceOperationCatalogV1,
  isSupportedBackendSurfaceOperationV1,
} from './backendSurfaceDeclarationV1.js';

describe('BackendSurfaceDeclarationV1Schema', () => {
  it('preserves a bounded safe explanation for unavailable surface operations', () => {
    expect(BackendSurfaceAvailabilityV1Schema.parse({
      available: false,
      reasonCode: 'missing_metadata',
      safeMessage: 'Session metadata is missing a Provider session id.',
    })).toEqual({
      available: false,
      reasonCode: 'missing_metadata',
      safeMessage: 'Session metadata is missing a Provider session id.',
    });
    expect(BackendSurfaceAvailabilityV1Schema.safeParse({
      available: false,
      reasonCode: 'missing_metadata',
      safeMessage: 'x'.repeat(1_001),
    }).success).toBe(false);
  });

  it('rejects the retired external-session handler carrier while retaining the other handler families', () => {
    const declaration = (kind: string, operation: string) => ({
      surfaceApiVersion: 1,
      id: `backend.${kind}.${operation}`,
      kind,
      operation,
      support: 'supported',
      handler: {
        target: 'daemon',
        exportName: operation,
      },
    });

    expect(BackendSurfaceKindV1Schema.safeParse('externalSession').success).toBe(false);
    expect(BackendSurfaceDeclarationV1Schema.safeParse(
      declaration('externalSession', 'listCandidates'),
    ).success).toBe(false);
    expect('externalSession' in BackendSurfaceOperationCatalogV1).toBe(false);

    const retainedOperations = [
      ['terminalRuntime', 'launch'],
      ['attach', 'attach'],
      ['handoff', 'exportBundle'],
      ['fork', 'fork'],
      ['checkpoint', 'restore'],
    ] as const;

    for (const [kind, operation] of retainedOperations) {
      expect(BackendSurfaceDeclarationV1Schema.safeParse(declaration(kind, operation)).success).toBe(true);
      expect(isSupportedBackendSurfaceOperationV1({ kind, operation })).toBe(true);
    }
  });
});
