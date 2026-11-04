import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManagedMachineAcquisitionDriver } from './acquire';
import { applyManagedNativeCredentialPolicy, composeManagedNativeCredentials } from './nativeCredentialComposer';
import { createNativeCredentialComposerFixture as fixture } from './nativeCredentialComposer.testkit';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('current managed native credential composition', () => {
  it.each([false, true])('refuses Account-owned native credential application before material or native IO (empty census: %s)', async empty => {
    const f = await fixture();
    try {
      const input = { ...f.input, machine: { ...f.input.machine, controller: undefined },
        ...(empty ? { bindings: [], desiredBindingKeys: [] } : {}) };
      expect(await applyManagedNativeCredentialPolicy(input)).toMatchObject({ kind: 'refused', code: 'provider_authorization_changed' });
      expect(f.calls).toEqual([]);
      expect(f.material).toEqual([]);
      expect(axios.get).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  });
  it.each([false, true])('runs the ordinary installed controller driver through real source custody (report unavailable: %s)', async reportUnavailable => {
    const f = await fixture();
    try {
      f.setReportUnavailable(reportUnavailable);
      const driver = createManagedMachineAcquisitionDriver({ ...f.driverInput, prepareTeamCredentialNativeSource: f.input.prepareSource });
      const result = await driver.execute('machines.managed.credentials.install', f.input.request, f.options);
      expect(result).toEqual(reportUnavailable ? { kind: 'unknown', code: 'action_outcome_unknown' }
        : { kind: 'confirmed', binding: f.binding.safeFacet });
      expect(f.binding.submission).toEqual(reportUnavailable ? { requestId: f.options.requestId, operation: 'install' } : undefined);
      expect(f.binding.installation).toBe(reportUnavailable ? 'prepared' : 'confirmed');
      expect(f.native.effects()).toBe(1);
      expect(f.material).toEqual([{ bindingKey: 'binding-a', result: { ok: true, headers: { authorization: 'Bearer native-source-secret' } } }]);
      expect(await f.handles[0]!.readRenderedHeaders()).toMatchObject({ ok: false });
    } finally { await f.cleanup(); }
  });

  it('applies the complete admitted resource through the managed role and closes source custody after IO', async () => {
    const f = await fixture();
    try {
      expect(await composeManagedNativeCredentials(f.input)).toEqual({ kind: 'confirmed', binding: f.binding.safeFacet });
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]?.[0]).toBe('nativeCredentialApply');
      expect(f.calls[0]?.[1]).toMatchObject({ resource: f.input.machine.resource,
        baseline: { kind: 'allow-all' }, bindings: [{ bindingKey: 'binding-a', destination: 'https://example.test/v1',
          requests: [{ path: '/v1/responses', methods: ['POST'] }, { path: '/v1/models', methods: ['GET'] }],
          placeholder: { header: 'authorization', value: 'Bearer random-placeholder-a' },
          attributionHeaders: [{ name: 'x-happier-attribution', value: '["member-account","session-a"]' }] }],
        ownedBindings: [{ bindingKey: 'binding-a' }] });
      expect(f.material).toEqual([{ bindingKey: 'binding-a', result: { ok: true, headers: { authorization: 'Bearer native-source-secret' } } }]);
      expect(f.handles).toHaveLength(1);
      expect(await f.handles[0]!.readRenderedHeaders()).toMatchObject({ ok: false });
    } finally { await f.cleanup(); }
  });

  it.each(['custodian', 'binding', 'ticket', 'endpoint', 'desired'] as const)('refuses %s authority before native IO', async invalid => {
    const f = await fixture();
    try {
      const binding = structuredClone(f.binding);
      if (invalid === 'custodian') binding.custodianAccountId = 'foreign-custodian';
      if (invalid === 'binding') binding.safeFacet.bindingKey = 'other-binding';
      if (invalid === 'ticket') binding.delivery.providerAuthorizationTicket.grantFingerprint = 'different-grant';
      if (invalid === 'endpoint') binding.delivery.endpoint.normalizedUrl = 'https://other.test/v1';
      expect(await composeManagedNativeCredentials({ ...f.input, bindings: [binding],
        desiredBindingKeys: invalid === 'desired' ? ['unowned-binding'] : f.input.desiredBindingKeys })).toMatchObject({
        kind: 'refused', code: 'provider_authorization_changed',
      });
      expect(f.calls).toEqual([]);
      expect(f.material).toEqual([]);
      expect(axios.get).not.toHaveBeenCalled();
      for (const handle of f.handles) expect(await handle.readRenderedHeaders()).toMatchObject({ ok: false });
    } finally { await f.cleanup(); }
  });

  it('settles earlier uncertainty by replacing the complete policy while preserving the current sibling', async () => {
    const f = await fixture();
    try {
      const sibling = structuredClone(f.binding);
      sibling.sessionId = 'session-b';
      sibling.installation = 'confirmed';
      sibling.safeFacet = { ...sibling.safeFacet, bindingKey: 'binding-b', placeholderRef: 'placeholder-ref-b' };
      sibling.delivery.safeFacet = sibling.safeFacet;
      sibling.delivery.placeholder = 'random-placeholder-b';
      const retiring = { ...f.binding, installation: 'unknown' as const };
      expect(await composeManagedNativeCredentials({ ...f.input, request: { ...f.input.request, operation: 'release' },
        bindings: [retiring, sibling], desiredBindingKeys: [sibling.safeFacet.bindingKey] })).toEqual({ kind: 'confirmed', binding: f.binding.safeFacet });
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]?.[1]).toMatchObject({ resource: f.input.machine.resource,
        bindings: [{ bindingKey: 'binding-b', placeholder: { value: 'Bearer random-placeholder-b' } }],
        ownedBindings: [{ bindingKey: 'binding-b' }] });
      expect(f.material).toEqual([{ bindingKey: 'binding-b', result: { ok: true, headers: { authorization: 'Bearer native-source-secret' } } }]);
      expect(f.handles).toHaveLength(1);
      expect(await f.handles[0]!.readRenderedHeaders()).toMatchObject({ ok: false });
    } finally { await f.cleanup(); }
  });

  it('removes the last binding with an owned empty baseline without reopening the retiring source', async () => {
    const f = await fixture();
    try {
      f.binding.installation = 'confirmed';
      expect(await composeManagedNativeCredentials({ ...f.input, request: { ...f.input.request, operation: 'release' }, desiredBindingKeys: [] }))
        .toEqual({ kind: 'confirmed', binding: f.binding.safeFacet });
      expect(f.calls[0]?.[1]).toMatchObject({ baseline: { kind: 'allow-all' }, bindings: [], ownedBindings: [] });
      expect(f.material).toEqual([]);
      expect(f.handles).toEqual([]);
    } finally { await f.cleanup(); }
  });

  it('removes withdrawn owned peers using Home desired selection without materializing their sources', async () => {
    const f = await fixture();
    try {
      f.binding.installation = 'confirmed';
      const peer = structuredClone(f.binding);
      peer.sessionId = 'withdrawn-peer';
      peer.safeFacet = { ...peer.safeFacet, bindingKey: 'withdrawn-peer-binding', placeholderRef: 'withdrawn-peer-placeholder' };
      peer.delivery.safeFacet = peer.safeFacet;
      const input = { ...f.input, request: { ...f.input.request, operation: 'release' as const },
        bindings: [f.binding, peer], desiredBindingKeys: [] };
      const sourceReads = f.source.sourceReads;
      expect(await composeManagedNativeCredentials(input)).toEqual({ kind: 'confirmed', binding: f.binding.safeFacet });
      expect(f.calls[0]?.[1]).toMatchObject({ bindings: [], ownedBindings: [] });
      expect(f.material).toEqual([]);
      expect(f.handles).toEqual([]);
      expect(f.source.sourceReads).toBe(sourceReads);
    } finally { await f.cleanup(); }
  });

  it('keeps source Home reads proportional to the number of admitted bindings', async () => {
    const observe = async (count: 1 | 2) => {
      const f = await fixture();
      try {
        const sibling = structuredClone(f.binding);
        sibling.sessionId = 'session-b';
        sibling.installation = 'confirmed';
        sibling.safeFacet = { ...sibling.safeFacet, bindingKey: 'binding-b', placeholderRef: 'placeholder-ref-b' };
        sibling.delivery.safeFacet = sibling.safeFacet;
        sibling.delivery.placeholder = 'random-placeholder-b';
        const before = f.source.sourceReads;
        expect(await composeManagedNativeCredentials({ ...f.input,
          bindings: count === 1 ? [f.binding] : [f.binding, sibling],
          desiredBindingKeys: count === 1 ? [f.binding.safeFacet.bindingKey] : [f.binding.safeFacet.bindingKey, sibling.safeFacet.bindingKey] })).toMatchObject({ kind: 'confirmed' });
        return f.source.sourceReads - before;
      } finally { await f.cleanup(); }
    };
    expect(await observe(2)).toBe(2 * await observe(1));
  });

  it.each(['source-withdrawal', 'failure', 'cancellation'] as const)('reports the actual post-IO %s outcome and awaits source cleanup', async outcome => {
    const f = await fixture();
    try {
      const abort = new AbortController();
      f.setVendorEffect(async () => {
        if (outcome === 'source-withdrawal') f.source.setResource(null);
        if (outcome === 'cancellation') abort.abort();
        if (outcome === 'failure') throw new Error('native-source-secret');
      });
      const result = await composeManagedNativeCredentials({ ...f.input, signal: abort.signal });
      expect(result).toEqual(outcome === 'source-withdrawal' ? { kind: 'confirmed', binding: f.binding.safeFacet }
        : { kind: 'unknown', code: 'action_outcome_unknown' });
      expect(JSON.stringify(result)).not.toContain('native-source-secret');
      expect(f.calls).toHaveLength(1);
      expect(await f.handles[0]!.readRenderedHeaders()).toMatchObject({ ok: false });
    } finally { await f.cleanup(); }
  });
});
