import { describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';
import { resolveInactiveConnectedServiceSessionForAuthSwitch } from './resolveInactiveConnectedServiceSessionForAuthSwitch';

const connectedServices = {
  v: 1,
  bindingsByServiceId: {
    anthropic: {
      source: 'connected',
      selection: 'profile',
      profileId: 'old-profile',
    },
  },
} as const;

const materializationIdentity = {
  v: 1,
  id: 'csm_inactive_e2ee_1',
  createdAtMs: 123,
} as const;

function credentials(): Credentials {
  return {
    token: 'token-1',
    encryption: { type: 'legacy', secret: new Uint8Array(32) },
  };
}

describe('resolveInactiveConnectedServiceSessionForAuthSwitch', () => {
  it('resolves decrypted E2EE metadata through the canonical attach context', async () => {
    const resolveAttachContext = vi.fn(async () => ({
      ok: true as const,
      attachPayload: {
        v: 2 as const,
        encryptionMode: 'e2ee' as const,
        encryptionKeyBase64: 'a2V5',
        encryptionVariant: 'legacy' as const,
      },
      vendorResumeId: 'vendor-1',
      sessionPath: '/tmp/repo',
      deliveredUserMessageSeq: null,
      metadata: {
        agentId: 'claude',
        path: '/tmp/repo',
        connectedServices,
        connectedServiceMaterializationIdentityV1: materializationIdentity,
        piSessionFile: '/tmp/repo/.pi/session.jsonl',
      },
    }));

    const resolved = await resolveInactiveConnectedServiceSessionForAuthSwitch({
      credentials: credentials(),
      sessionId: 'sess_inactive',
      agentId: 'claude',
      resolveAttachContext,
    });

    // The inactive-switch continuity path needs more than identity/bindings to PROVE a shared-state
    // resume is reachable: it must reconstruct the target materialized root (deterministic from the
    // identity) and run the source-aware reachability probe, which needs the session cwd and the
    // persisted session-file hint. Without these the switch fail-closes a genuinely-resumable session.
    expect(resolved).toMatchObject({
      agentId: 'claude',
      connectedServices,
      connectedServiceMaterializationIdentityV1: materializationIdentity,
      vendorResumeId: 'vendor-1',
      cwd: '/tmp/repo',
    });
    // The raw metadata is surfaced so the provider-agnostic catalog helper can derive the persisted
    // session-file hint at the call site (the SAME seam the tracked spawn path uses).
    expect(resolved?.metadata).toMatchObject({ piSessionFile: '/tmp/repo/.pi/session.jsonl' });

    expect(resolveAttachContext).toHaveBeenCalledWith(expect.objectContaining({
      token: 'token-1',
      sessionId: 'sess_inactive',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      credentials: credentials(),
    }));
  });

  it('falls back to the requested agent when decrypted metadata has no agent marker', async () => {
    const resolveAttachContext = vi.fn(async () => ({
      ok: true as const,
      attachPayload: {
        v: 2 as const,
        encryptionMode: 'e2ee' as const,
        encryptionKeyBase64: 'a2V5',
        encryptionVariant: 'legacy' as const,
      },
      vendorResumeId: 'vendor-1',
      sessionPath: '/tmp/repo',
      deliveredUserMessageSeq: null,
      metadata: {
        connectedServices,
        connectedServiceMaterializationIdentityV1: materializationIdentity,
      },
    }));

    await expect(resolveInactiveConnectedServiceSessionForAuthSwitch({
      credentials: credentials(),
      sessionId: 'sess_inactive_codex',
      agentId: 'codex',
      resolveAttachContext,
    })).resolves.toMatchObject({
      agentId: 'codex',
      connectedServices,
      vendorResumeId: 'vendor-1',
    });
  });

  it('derives the vendor resume id from the inferred persisted agent metadata', async () => {
    const piSessionFile = '/tmp/repo/.pi/sessions/--tmp-repo--/pi-session-1.jsonl';
    const resolveAttachContext = vi.fn(async () => ({
      ok: true as const,
      attachPayload: {
        v: 2 as const,
        encryptionMode: 'e2ee' as const,
        encryptionKeyBase64: 'a2V5',
        encryptionVariant: 'legacy' as const,
      },
      vendorResumeId: null,
      sessionPath: '/tmp/repo',
      deliveredUserMessageSeq: null,
      metadata: {
        agentId: 'pi',
        path: '/tmp/repo',
        connectedServices,
        connectedServiceMaterializationIdentityV1: materializationIdentity,
        agentRuntimeDescriptorV1: {
          v: 1,
          providerId: 'pi',
          provider: {
            resumeStrategy: 'sessionFileAbsolutePreferred',
            vendorSessionId: 'pi-session-1',
            sessionFile: piSessionFile,
          },
        },
        piSessionFile,
      },
    }));

    await expect(resolveInactiveConnectedServiceSessionForAuthSwitch({
      credentials: credentials(),
      sessionId: 'sess_inactive_pi',
      agentId: 'codex',
      resolveAttachContext,
    })).resolves.toMatchObject({
      agentId: 'pi',
      vendorResumeId: piSessionFile,
      cwd: '/tmp/repo',
    });
  });
});
