import { describe, expect, it } from 'vitest';

import {
  BackendSurfaceDeclarationV1Schema,
  BackendSurfaceKindV1Schema,
  BackendSurfaceOperationCatalogV1,
  isSupportedBackendSurfaceOperationV1,
} from './backendSurfaceDeclarationV1.js';

describe('BackendSurfaceDeclarationV1Schema', () => {
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
