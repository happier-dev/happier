import { describe, expect, it } from 'vitest';

import { HappyError } from '@/utils/errors/errors';

import { runDeploymentAction } from './deploymentActionOutcome';

describe('deployment press outcome', () => {
  it('keeps Domain recovery facts for returned and thrown failures outside template creation', async () => {
    const details = { environmentId: 'environment-a', domainId: 'domain-a', step: 'native_execution',
      requiredFact: 'domainIngress', remedy: 'Restore the ingress controller and retry Stop and remove.' };
    const failureCause = { phase: 'deployments.domains.remove', errorClass: 'Error' as const,
      errorCode: 'ECONNREFUSED', httpStatus: null };
    for (const thrown of [false, true]) {
      const outcome = await runDeploymentAction(async () => {
        if (thrown) throw new HappyError('Domain retirement failed', false, {
          code: 'deployment_domain_native_unavailable', details, failureCause,
        });
        return { ok: false, error: 'deployment_domain_native_unavailable', details, failureCause };
      });
      expect(outcome).toMatchObject({ kind: 'refused', code: 'deployment_domain_native_unavailable',
        failure: { errorCode: 'deployment_domain_native_unavailable', details, failureCause } });
    }
  });

  it('turns a held review into the approval the person still has to open, not a refusal', async () => {
    const held = new HappyError('approval_request_created', false, {
      code: 'approval_request_created',
      details: {
        kind: 'approval_request_created',
        artifactId: 'approval-a',
        actionId: 'deployments.deploy',
      },
    });
    expect(
      await runDeploymentAction(async () => {
        throw held;
      }),
    ).toEqual({ kind: 'approval', artifactId: 'approval-a' });
  });

  it('opens the receipt that is already running instead of reporting a conflict', async () => {
    expect(
      await runDeploymentAction(async () => ({
        ok: false,
        error: 'deployment_in_progress',
        deploymentId: 'running-a',
      })),
    ).toEqual({ kind: 'receipt', deploymentId: 'running-a' });
    expect(
      await runDeploymentAction(async () => ({
        ok: true,
        deploymentId: 'new-a',
      })),
    ).toEqual({ kind: 'receipt', deploymentId: 'new-a' });
    expect(
      await runDeploymentAction(async () => ({ ok: true, kind: 'pending' })),
    ).toEqual({ kind: 'started' });
  });

  it('names the refusals a person answers differently: no access, Machine away, target not supported', async () => {
    expect(
      await runDeploymentAction(async () => ({
        ok: false,
        error: 'deployment_access_denied',
      })),
    ).toMatchObject({ kind: 'refused', reason: 'permission' });
    expect(
      await runDeploymentAction(async () => ({
        ok: false,
        error: 'machine_unavailable',
      })),
    ).toMatchObject({ kind: 'refused', reason: 'machine' });
    expect(
      await runDeploymentAction(async () => {
        throw Object.assign(new Error('unsupported'), { code: 'unsupported' });
      }),
    ).toEqual({ kind: 'refused', reason: 'unsupported', code: 'unsupported' });
    expect(
      await runDeploymentAction(async () => ({
        ok: false,
        error: 'deployment_conflict',
      })),
    ).toEqual({
      kind: 'refused',
      reason: 'other',
      code: 'deployment_conflict',
    });
  });
});
