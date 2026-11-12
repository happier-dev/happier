import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit';

import { HappyError } from '@/utils/errors/errors';

import { deploymentPartialRecoveryTab, runDeploymentAction, useDeploymentChangePress } from './deploymentActionOutcome';
import { DeploymentTemplateInstantiationPartialV1Schema } from '@happier-dev/protocol/deployments/deploymentTemplateInstantiationV1';

afterEach(standardCleanup);

it('refreshes a successful save while preserving unavailable preview enrollment as a followup', async () => {
  const refreshed = vi.fn();
  const followup = { status: 'unavailable' as const, errorCode: 'credential_unavailable' };
  const hook = await renderHook(() => useDeploymentChangePress(null, refreshed));
  try {
    let saved: boolean | undefined;
    await act(async () => { saved = await hook.getCurrent().press(async () => ({ ok: true, previewEnrollment: followup })); });
    expect(saved).toBe(true);
    expect(refreshed).toHaveBeenCalledTimes(1);
    expect(hook.getCurrent().outcome).toBeNull();
    expect(hook.getCurrent().followup).toEqual(followup);
    await act(async () => { await hook.getCurrent().press(async () => ({ ok: true, previewEnrollment: { status: 'enrolled' } })); });
    expect(hook.getCurrent().followup).toBeNull();
  } finally { await hook.unmount(); }
});

describe('deployment press outcome', () => {
  it('opens managed data recovery at Overview when the failed link identifies its data role', () => {
    const progress = DeploymentTemplateInstantiationPartialV1Schema.parse({
      kind: 'partial', phase: 'target', errorCode: 'credential_unavailable', savedSecrets: [], environmentId: 'copied', revision: 1,
      continuation: { actionId: 'deployments.targets.link', input: {
        serverId: 'home', environmentId: 'copied', expectedRevision: 1, requestKey: 'link-created-data',
        targetId: 'database', targetKind: 'database', role: 'data', machines: [],
        source: { kind: 'plugin', contribution: { pluginId: 'example.data', localId: 'database' } },
        provider: {
          credentialPrincipal: { kind: 'account', accountId: 'owner',
            purpose: { consumer: { pluginId: 'example.data', localId: 'provision' }, purpose: 'manage' },
            target: { kind: 'account', account: { service: { pluginId: 'example.data', localId: 'account' }, accountId: 'selected' } } },
          providerIdentity: { providerAccountId: 'selected', providerResourceId: 'created', providerEnvironment: 'new' },
          providerEnvironment: { kind: 'custom', id: 'new' },
        },
      } },
    });
    expect(deploymentPartialRecoveryTab(progress)).toBe('overview');
    expect(deploymentPartialRecoveryTab({ ...progress, continuation: undefined })).toBe('settings');
  });

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
