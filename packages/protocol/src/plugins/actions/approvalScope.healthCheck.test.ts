import { describe, expect, it } from 'vitest';

import { projectPluginActionApprovalScopeV1 } from './approvalScope.js';
import { createHealthCheckSourceInstanceIdV1 } from '../../deployments/healthCheckSubjectV1.js';

const scope = {
  declaration: 'healthCheck' as const,
  pluginId: 'happier.machine.services',
  serverId: 'home',
};
const subject = { kind: 'environment', environmentId: 'production' } as const;
const check = (checkId: string) => ({
  checkId,
  kind: { pluginId: 'happier.machine.services', localId: 'tcp' },
  binding: { kind: 'healthCheck' },
  config: { host: '127.0.0.1', port: 8080 },
  periodMs: 300_000,
  consecutiveFailuresBeforeAlerting: 1,
});

describe('healthCheck approval scope operands', () => {
  it('admits a setup preview that names only its subject, with no saved check operand yet', () => {
    expect(
      projectPluginActionApprovalScopeV1({
        ...scope,
        input: { v: 1, mode: 'preview', subject },
      }),
    ).toEqual({ ok: true, subjects: [] });
  });

  it('binds a setup to each exact check it saves under the subject it was reviewed for', () => {
    const sourceInstanceId = createHealthCheckSourceInstanceIdV1(subject);
    expect(
      projectPluginActionApprovalScopeV1({
        ...scope,
        input: { v: 1, subject, checks: [check('tcp'), check('api')] },
      }),
    ).toEqual({
      ok: true,
      subjects: ['tcp', 'api'].map((checkId) => ({
        role: 'operand',
        subject: {
          kind: 'healthCheck',
          serverId: 'home',
          sourceInstanceId,
          checkId,
        },
      })),
    });
    const other = createHealthCheckSourceInstanceIdV1({
      kind: 'environment',
      environmentId: 'staging',
    });
    expect(other).not.toBe(sourceInstanceId);
  });

  it('keeps requiring the exact saved check for an Action that targets one', () => {
    const sourceInstanceId = createHealthCheckSourceInstanceIdV1(subject);
    expect(
      projectPluginActionApprovalScopeV1({
        ...scope,
        input: {
          webhookEndpointId: 'endpoint',
          sourceInstanceId,
          checkId: 'tcp',
          operation: 'status',
        },
      }),
    ).toEqual({
      ok: true,
      subjects: [
        {
          role: 'operand',
          subject: {
            kind: 'healthCheck',
            serverId: 'home',
            sourceInstanceId,
            checkId: 'tcp',
          },
        },
      ],
    });
    for (const input of [
      { webhookEndpointId: 'endpoint', operation: 'status' },
      { sourceInstanceId, operation: 'status' },
      { v: 1, subject: { kind: 'environment' } },
      { v: 1, subject, checks: [{ periodMs: 1 }] },
    ]) {
      expect(projectPluginActionApprovalScopeV1({ ...scope, input })).toEqual({
        ok: false,
        code: 'invalid_subject_identity',
      });
    }
  });
});
