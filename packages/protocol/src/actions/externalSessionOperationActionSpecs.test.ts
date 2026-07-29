import { describe, expect, it } from 'vitest';

import { serializeActionSpec } from './actionCatalog.js';
import { getActionSpec } from './actionSpecs.js';

describe('external-session operation ActionSpecs', () => {
  it('advertises only public-safe operation references for every operation control', () => {
    const operationControlIds = [
      'sessions.external.operation.status.get',
      'sessions.external.operation.cancel',
      'sessions.external.operation.resume',
      'sessions.external.operation.retry',
      'sessions.external.operation.discard',
    ] as const;
    const expectedFields = [
      { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
      { path: 'operationId', title: 'Operation id', widget: 'text', required: true },
      { path: 'revision', title: 'Revision', widget: 'text', required: true },
    ] as const;
    const publicReference = {
      sessionId: 'session-1',
      operationId: 'operation-1',
      revision: 4,
    } as const;

    for (const actionId of operationControlIds) {
      const spec = getActionSpec(actionId);
      const fields = spec.inputHints?.fields;
      const advertisedFields = serializeActionSpec(spec).inputHints?.fields;

      expect(fields).toEqual(expectedFields);
      expect(advertisedFields).toEqual(expectedFields);
      expect(fields?.map((field) => field.path)).not.toContain('claim');
      expect(fields?.map((field) => field.path)).not.toContain('operationClaimId');
      expect(fields?.map((field) => field.path)).not.toContain('expectedRevision');
      expect(spec.inputSchema.parse(publicReference)).toEqual(publicReference);

      for (const privateField of ['claim', 'operationClaimId', 'expectedRevision'] as const) {
        expect(spec.inputSchema.safeParse({
          ...publicReference,
          [privateField]: 'private-authority',
        }).success).toBe(false);
      }
    }
  });
});
