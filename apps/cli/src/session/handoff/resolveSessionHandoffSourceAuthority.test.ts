import { describe, expect, it } from 'vitest';

import {
  createPlainSessionOwnerMetadataEnvelopeV1,
  createSessionOwnerMetadataV1,
  projectSessionSharedMetadataV1,
  resolveLinkedExternalSessionAuthorityV1,
  SESSION_METADATA_LAYOUT_VERSION_V1,
} from '@happier-dev/protocol';

import type { StoredCredentials } from '@/persistence';

import { resolveSessionHandoffSourceAuthority } from './resolveSessionHandoffSourceAuthority';

const credentials = { token: 'token-1' } as unknown as StoredCredentials;

const VALID_LINK = {
  v: 1 as const,
  agentId: 'codex',
  machineId: 'machine-source',
  remoteSessionId: 'remote-1',
  source: { kind: 'codexHome' as const, home: 'user' as const },
};

function layoutZeroSession(metadata: Record<string, unknown>) {
  return {
    machineId: 'machine-source',
    metadata: JSON.stringify(metadata),
    metadataLayoutVersion: 0,
    ownerMetadata: null,
    encryptionMode: 'plain',
  };
}

function resolve(rawSession: Record<string, unknown>) {
  return resolveSessionHandoffSourceAuthority({
    credentials,
    accountEncryptionMode: 'plain',
    rawSession,
  });
}

describe('resolveSessionHandoffSourceAuthority', () => {
  it('classifies a Session with no link as persisted and a valid link as direct', () => {
    expect(resolve(layoutZeroSession({ machineId: 'machine-source', path: '/repo', flavor: 'claude' })))
      .toEqual({ ok: true, sourceMachineId: 'machine-source', sessionStorageMode: 'persisted' });
    expect(resolve(layoutZeroSession({
      machineId: 'machine-source',
      path: '/repo',
      externalSessionV1: VALID_LINK,
    }))).toEqual({ ok: true, sourceMachineId: 'machine-source', sessionStorageMode: 'direct' });
  });

  /**
   * The handoff request stamps `sessionStorageMode` on the RPC that stops the
   * source and tells the target which storage to import into. A link that
   * cannot be resolved has no storage answer at all, and the nullable metadata
   * read this owner replaced reported it as `persisted` — the same value a
   * Session that was never linked produces.
   */
  it.each([
    [
      'a malformed canonical link',
      {
        externalSessionV1: {
          ...VALID_LINK,
          followStatusV1: { v: 1, status: 'not-a-status', updatedAtMs: 10 },
        },
      },
      'linked_session_invalid',
    ],
    [
      'dual rows requiring reconciliation',
      {
        externalSessionV1: VALID_LINK,
        directSessionV1: {
          v: 1,
          agentId: 'claude',
          machineId: 'machine-legacy',
          remoteSessionId: 'remote-legacy',
          source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
        },
      },
      'linked_session_reconciliation_required',
    ],
  ])('refuses %s instead of stamping a storage mode', (_label, link, errorCode) => {
    const authority = resolve(layoutZeroSession({
      machineId: 'machine-source',
      path: '/repo',
      ...link,
    }));

    expect(authority.ok).toBe(false);
    expect(authority).toMatchObject({ ok: false, errorCode });
  });

  /**
   * Under the split metadata layout the link is OWNER-only: the shared record
   * carries agent presentation and nothing else. Classifying storage from the
   * shared record therefore called a genuinely linked Session `persisted`, and
   * the target imported its transcript into the wrong storage.
   */
  it('reads an owner-only layout-1 link as direct, which the shared projection cannot see', () => {
    const metadata = {
      machineId: 'machine-source',
      path: '/repo',
      externalSessionV1: VALID_LINK,
    };
    const sharedMetadata = projectSessionSharedMetadataV1({ metadata });
    const ownerMetadata = createSessionOwnerMetadataV1({ metadata });
    expect(ownerMetadata.ok).toBe(true);
    if (!ownerMetadata.ok) return;

    // The hazard is real only if the shared record genuinely reads as persisted.
    expect(resolveLinkedExternalSessionAuthorityV1(sharedMetadata))
      .toEqual({ ok: true, transcriptStorage: 'persisted' });

    expect(resolve({
      machineId: 'machine-source',
      metadata: JSON.stringify(sharedMetadata),
      metadataLayoutVersion: SESSION_METADATA_LAYOUT_VERSION_V1,
      ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata.ownerMetadata),
      encryptionMode: 'plain',
    })).toEqual({ ok: true, sourceMachineId: 'machine-source', sessionStorageMode: 'direct' });
  });
});
