import type { BrowserAutomationRequesterRefV1 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { createBrowserAutomationOwnerRegistry } from './owners';

const view = { browserSessionId: 'browser_session_1', viewId: 'view_1' } as const;
const agentRef: BrowserAutomationRequesterRefV1 = { kind: 'agent', id: 'agent_1' };
const otherRef: BrowserAutomationRequesterRefV1 = { kind: 'agent', id: 'agent_2' };

describe('browser automation owner registry', () => {
  it('acquires a lease and exposes controller state with a bumped control epoch', () => {
    const registry = createBrowserAutomationOwnerRegistry({ now: () => 1_000 });

    const acquired = registry.acquireLease({
      ...view,
      holder: 'agent',
      requesterRef: agentRef,
      leaseTtlMs: 5_000,
    });

    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    expect(acquired.lease.leaseId).toBeTruthy();
    expect(acquired.lease.controlEpoch).toBe(1);
    expect(acquired.lease.expiresAtMs).toBe(6_000);

    const state = registry.getControllerState(view);
    expect(state.controller).toBe('agent');
    expect(state.controlEpoch).toBe(1);
    expect(state.activeLease?.leaseId).toBe(acquired.lease.leaseId);
  });

  it('refuses a second lease while one is active and held by a different requester', () => {
    const registry = createBrowserAutomationOwnerRegistry({ now: () => 1_000 });
    registry.acquireLease({ ...view, holder: 'agent', requesterRef: agentRef, leaseTtlMs: 5_000 });

    const conflict = registry.acquireLease({
      ...view,
      holder: 'agent',
      requesterRef: otherRef,
      leaseTtlMs: 5_000,
    });

    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;
    expect(conflict.errorCode).toBe('lease_conflict');
  });

  it('validates a lease against the bound requester and rejects mismatched identity', () => {
    const registry = createBrowserAutomationOwnerRegistry({ now: () => 1_000 });
    const acquired = registry.acquireLease({ ...view, holder: 'agent', requesterRef: agentRef, leaseTtlMs: 5_000 });
    if (!acquired.ok) throw new Error('expected lease');

    expect(
      registry.validateLease({ ...view, leaseId: acquired.lease.leaseId, requesterRef: agentRef }).ok,
    ).toBe(true);

    const mismatch = registry.validateLease({
      ...view,
      leaseId: acquired.lease.leaseId,
      requesterRef: otherRef,
    });
    expect(mismatch.ok).toBe(false);
    if (mismatch.ok) return;
    expect(mismatch.errorCode).toBe('owner_mismatch');
  });

  it('reports lease_expired once the lease TTL has elapsed', () => {
    let clock = 1_000;
    const registry = createBrowserAutomationOwnerRegistry({ now: () => clock });
    const acquired = registry.acquireLease({ ...view, holder: 'agent', requesterRef: agentRef, leaseTtlMs: 5_000 });
    if (!acquired.ok) throw new Error('expected lease');

    clock = 10_000;
    const validate = registry.validateLease({ ...view, leaseId: acquired.lease.leaseId, requesterRef: agentRef });
    expect(validate.ok).toBe(false);
    if (validate.ok) return;
    expect(validate.errorCode).toBe('lease_expired');
  });

  it('allows a fresh lease after the active lease is released', () => {
    const registry = createBrowserAutomationOwnerRegistry({ now: () => 1_000 });
    const first = registry.acquireLease({ ...view, holder: 'agent', requesterRef: agentRef, leaseTtlMs: 5_000 });
    if (!first.ok) throw new Error('expected lease');

    registry.releaseLease({ ...view, leaseId: first.lease.leaseId });

    const second = registry.acquireLease({ ...view, holder: 'agent', requesterRef: otherRef, leaseTtlMs: 5_000 });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // Releasing then re-acquiring bumps the control epoch so stale callers are rejected.
    expect(second.lease.controlEpoch).toBe(2);
  });

  it('rejects validation for an unknown lease id', () => {
    const registry = createBrowserAutomationOwnerRegistry({ now: () => 1_000 });
    const validate = registry.validateLease({ ...view, leaseId: 'lease_missing', requesterRef: agentRef });
    expect(validate.ok).toBe(false);
    if (validate.ok) return;
    expect(validate.errorCode).toBe('lease_required');
  });
});
