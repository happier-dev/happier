import { describe, expect, it, vi } from 'vitest';

import { applyRefreshedConnectedServiceAuthToTargets } from './applyRefreshedConnectedServiceAuthToTargets';

type Target = Parameters<typeof applyRefreshedConnectedServiceAuthToTargets>[0]['event']['affectedTargets'][number];

function target(sessionId: string, pid: number, profileId = 'Claude2'): Target {
  return {
    sessionId,
    pid,
    agentId: 'claude',
    runtimeIdentityKey: `runtime-${sessionId}`,
    selectionsByServiceId: new Map([['claude-subscription', { kind: 'profile', serviceId: 'claude-subscription', profileId }]]),
  } as unknown as Target;
}

function event(targets: Target[]) {
  return {
    binding: { serviceId: 'claude-subscription', profileId: 'Claude2' },
    affectedTargets: targets,
    credentialRevision: null,
    trigger: 'refresh_triggered_restart',
  } as Parameters<typeof applyRefreshedConnectedServiceAuthToTargets>[0]['event'];
}

describe('applyRefreshedConnectedServiceAuthToTargets', () => {
  it('reports the runtimes whose credential was hot applied', async () => {
    const applyAuth = vi.fn().mockResolvedValue({ ok: true, action: 'hot_applied' });

    const result = await applyRefreshedConnectedServiceAuthToTargets({ event: event([target('s1', 1)]), applyAuth });

    expect([...result.appliedRuntimeIdentityKeys]).toEqual(['runtime-s1']);
  });

  it('does not treat a session that needs a restart as a failure, and still handles the others', async () => {
    // A live session that cannot take the credential by hot apply must not abort the whole update:
    // an abort skips the provider's restart policy and makes the machine sync retry every few
    // seconds for as long as the session stays live (observed: ~16,000 retries in one day).
    const applyAuth = vi.fn()
      .mockResolvedValueOnce({ ok: false, errorCode: 'hot_apply_restart_required' })
      .mockResolvedValueOnce({ ok: true, action: 'hot_applied' });

    const result = await applyRefreshedConnectedServiceAuthToTargets({
      event: event([target('needs-restart', 1), target('hot-applies', 2)]),
      applyAuth,
    });

    expect(applyAuth).toHaveBeenCalledTimes(2);
    expect([...result.appliedRuntimeIdentityKeys]).toEqual(['runtime-hot-applies']);
  });

  it('passes the adapter restart instruction for the exact target while settling an adopted sibling', async () => {
    const restartTarget = target('needs-restart', 1);
    const applyAuth = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        errorCode: 'hot_apply_failed',
        diagnostics: {
          serviceResultsByServiceId: {
            'claude-subscription': { status: 'failed', errorCode: 'hot_apply_restart_required' },
          },
        },
      })
      .mockResolvedValueOnce({ ok: true, action: 'hot_applied' });

    const result = await applyRefreshedConnectedServiceAuthToTargets({
      event: event([restartTarget, target('hot-applies', 2)]),
      applyAuth,
    });

    expect(result.restartTargets).toEqual([{ target: restartTarget, reason: 'adapter_restart_required' }]);
    expect([...result.appliedRuntimeIdentityKeys]).toEqual(['runtime-hot-applies']);
  });

  it('hands metadata-only application to the restart policy and skips unchanged targets', async () => {
    const metadataOnly = target('metadata-only', 1);
    const applyAuth = vi.fn()
      .mockResolvedValueOnce({ ok: true, action: 'metadata_updated' })
      .mockResolvedValueOnce({ ok: true, action: 'unchanged' });

    await expect(applyRefreshedConnectedServiceAuthToTargets({
      event: event([metadataOnly, target('unchanged', 2)]),
      applyAuth,
    })).resolves.toEqual({
      appliedRuntimeIdentityKeys: new Set(),
      restartTargets: [{ target: metadataOnly, reason: 'lifecycle_policy' }],
    });
  });

  it('keeps tolerating a restart that execution policy disallows', async () => {
    const applyAuth = vi.fn().mockResolvedValue({ ok: false, errorCode: 'restart_disallowed_by_execution_policy' });

    await expect(applyRefreshedConnectedServiceAuthToTargets({ event: event([target('s1', 1)]), applyAuth }))
      .resolves.toEqual({
        appliedRuntimeIdentityKeys: new Set(),
        restartTargets: [{ target: target('s1', 1), reason: 'lifecycle_policy' }],
      });
  });

  it('still fails on a genuine application failure so it is retried', async () => {
    const applyAuth = vi.fn().mockResolvedValue({ ok: false, errorCode: 'hot_apply_failed' });

    await expect(applyRefreshedConnectedServiceAuthToTargets({ event: event([target('s1', 1)]), applyAuth }))
      .rejects.toThrow('connected_service_refreshed_auth_application_failed:hot_apply_failed');
  });

  it('skips sessions on a different profile and sessions without an id', async () => {
    const applyAuth = vi.fn().mockResolvedValue({ ok: true, action: 'hot_applied' });

    const result = await applyRefreshedConnectedServiceAuthToTargets({
      event: event([target('other-profile', 1, 'Claude1'), target('', 2)]),
      applyAuth,
    });

    expect(applyAuth).not.toHaveBeenCalled();
    expect(result.appliedRuntimeIdentityKeys.size).toBe(0);
  });
});
