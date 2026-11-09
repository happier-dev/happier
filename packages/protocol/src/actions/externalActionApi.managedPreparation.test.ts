import { describe, expect, it } from 'vitest';
import * as api from './externalActionApi.js';

describe('managed continuation and sealed deployment preparation', () => {
  it('accepts a controllerless continuation while validating supplied controller identity', () => {
    const continuation = { managedId: 'managed', creationRequestId: 'acquire', expectedIntentRevision: 0,
      acquireRequestEnvelopeDigest: 'a'.repeat(43) };
    expect(api.ExternalActionManagedContinuationV1Schema.parse(continuation)).toEqual(continuation);
    const controller = { machineId: 'controller', installationId: 'installation' };
    expect(api.ExternalActionManagedContinuationV1Schema.parse({ ...continuation, controller }))
      .toEqual({ ...continuation, controller });
    expect(api.ExternalActionManagedContinuationV1Schema.safeParse({ ...continuation,
      controller: { machineId: 'controller' } }).success).toBe(false);
    expect(api.ExternalActionManagedContinuationV1Schema.safeParse({ ...continuation,
      grant: { actions: { families: ['sessions'] } } }).success).toBe(false);
  });

  it('binds sealed preparation references to their declared deployment operation', () => {
    const admission = { operation: 'prepare' as const, source: { id: 'source', revision: 1 },
      workspace: { kind: 'workspace-ref' as const, id: 'workspace' } };
    const envelope = api.ExternalActionRequestEnvelopeSchema.parse({ v: 2, requestId: 'prepare',
      payload: { t: 'encrypted', c: 'sealed-private-deployment' }, deploymentPreparationAdmission: admission });
    const project = api.projectExternalActionDeploymentPreparationEnvelopeAdmissionV1;
    const plain = api.ExternalActionRequestEnvelopeSchema.parse({ v: 1, requestId: 'prepare-plain',
      input: { projectSourceId: 'source', sourceRevision: 1, workspace: admission.workspace } });
    expect(project({ actionId: 'deployments.prepare', envelope: plain })).toEqual(admission);
    expect(project({ actionId: 'deployments.prepare', envelope })).toEqual(admission);
    expect(() => project({ actionId: 'session.spawn_new', envelope })).toThrow(TypeError);
    const missing = api.ExternalActionRequestEnvelopeSchema.parse({ v: 2, requestId: 'missing',
      payload: { t: 'encrypted', c: 'sealed-private-deployment' } });
    expect(() => project({ actionId: 'deployments.prepare', envelope: missing })).toThrow(TypeError);
    expect(project({ actionId: 'session.spawn_new', envelope: missing })).toBeUndefined();
    expect(api.ExternalActionRequestEnvelopeSchema.safeParse({ ...envelope,
      deploymentPreparationAdmission: { ...admission, command: 'unreviewed' } }).success).toBe(false);
  });
});
