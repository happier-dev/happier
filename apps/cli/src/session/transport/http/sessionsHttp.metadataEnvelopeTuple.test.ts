import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  patchSessionMetadata,
  patchSessionMetadataEnvelopeTuple,
} from './sessionsHttp';

const request = {
  token: 'token-1',
  sessionId: 'session/one',
  patch: {
    mode: 'owner_inactive_model_intent' as const,
    metadataLayoutVersion: 1 as const,
    sessionExpectation: {
      kind: 'inactive_model_intent' as const,
    },
    expectedOwnerMetadataCiphertext: 'owner-before-ciphertext',
    sharedMetadata: {
      ciphertext: 'shared-ciphertext',
      expectedVersion: 3,
    },
    ownerMetadata: {
      ciphertext: 'owner-ciphertext',
    },
    agentState: {
      ciphertext: 'agent-state-ciphertext',
      expectedVersion: 5,
    },
  },
};

describe('patchSessionMetadataEnvelopeTuple', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends the strict conditioned-owner tuple through the existing PATCH route', async () => {
    const patch = vi.spyOn(axios, 'patch').mockResolvedValueOnce({
      status: 200,
      data: {
        success: true,
        metadataLayoutVersion: 1,
        sharedMetadata: { version: 4 },
        agentState: { version: 6 },
      },
    } as never);

    await expect(
      patchSessionMetadataEnvelopeTuple(request),
    ).resolves.toEqual({
      success: true,
      metadataLayoutVersion: 1,
      sharedMetadata: { version: 4 },
      agentState: { version: 6 },
    });
    expect(patch).toHaveBeenCalledWith(
      expect.stringContaining('/v2/sessions/session%2Fone'),
      request.patch,
      expect.objectContaining({
        validateStatus: expect.any(Function),
      }),
    );
  });

  it('returns only the flat recipient-safe version vector from strict HTTP 409', async () => {
    vi.spyOn(axios, 'patch').mockResolvedValueOnce({
      status: 409,
      data: {
        code: 'session_metadata_version_conflict',
        metadataLayoutVersion: 1,
        sharedMetadata: { version: 7 },
        agentState: { version: 9 },
      },
    } as never);

    await expect(
      patchSessionMetadataEnvelopeTuple(request),
    ).resolves.toEqual({
      success: false,
      error: 'session_metadata_version_conflict',
      metadataLayoutVersion: 1,
      sharedMetadata: { version: 7 },
      agentState: { version: 9 },
    });
  });

  it('returns a typed active conflict from the strict HTTP 409', async () => {
    vi.spyOn(axios, 'patch').mockResolvedValueOnce({
      status: 409,
      data: {
        code: 'session_active',
      },
    } as never);

    await expect(
      patchSessionMetadataEnvelopeTuple(request),
    ).resolves.toEqual({
      success: false,
      error: 'session_active',
    });
  });

  it('sends the strict owner-migration DTO and surfaces the canonical typed refusal', async () => {
    const patch = vi.spyOn(axios, 'patch').mockResolvedValueOnce({
      status: 409,
      data: {
        error: 'Session metadata privacy upgrade required',
        code: 'metadata_privacy_upgrade_required',
      },
    } as never);
    const migrationRequest = {
      token: 'token-1',
      sessionId: 'session/one',
      patch: {
        mode: 'owner_migration' as const,
        expectedAccountEncryptionMode: 'e2ee' as const,
        expectedAccountContentPublicKeyFingerprint:
          `content-public-key-sha256:${'a'.repeat(64)}`,
        source: {
          metadataLayoutVersion: 0 as const,
          metadata: {
            version: 7,
            ciphertext: 'metadata-exact-source',
          },
          ownerMetadata: null,
          agentState: {
            version: 9,
            ciphertext: null,
          },
        },
        target: {
          metadataLayoutVersion: 1 as const,
          sharedMetadata: { ciphertext: 'shared-target' },
          ownerMetadata: {
            ciphertext:
              'oQoBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGDb9gtt8Xqs3gDuzJU/wWRuslcRY3OZA==',
          },
          agentState: { ciphertext: null },
        },
      },
    };

    await expect(
      patchSessionMetadataEnvelopeTuple(migrationRequest),
    ).rejects.toMatchObject({
      code: 'metadata_privacy_upgrade_required',
      retryable: false,
    });
    expect(patch).toHaveBeenCalledWith(
      expect.stringContaining('/v2/sessions/session%2Fone'),
      migrationRequest.patch,
      expect.any(Object),
    );
  });

  it.each([
    {
      name: 'positive success',
      status: 200,
      data: {
        success: true,
        metadataLayoutVersion: 1,
        sharedMetadata: { version: 8 },
        agentState: { version: 10 },
      },
    },
    {
      name: 'migration conflict',
      status: 409,
      data: {
        code: 'session_metadata_version_conflict',
        metadataLayoutVersion: 1,
        sharedMetadata: { version: 8 },
        agentState: { version: 10 },
      },
    },
    {
      name: 'privacy refusal with a private extra',
      status: 409,
      data: {
        error: 'Session metadata privacy upgrade required',
        code: 'metadata_privacy_upgrade_required',
        privateOwnerField: 'must-not-be-accepted',
      },
    },
    {
      name: 'privacy refusal missing its canonical error',
      status: 409,
      data: {
        code: 'metadata_privacy_upgrade_required',
      },
    },
  ])('does not accept $name as an owner-migration result', async ({
    status,
    data,
  }) => {
    vi.spyOn(axios, 'patch').mockResolvedValueOnce({
      status,
      data,
    } as never);

    await expect(patchSessionMetadataEnvelopeTuple({
      token: 'token-1',
      sessionId: 'session/one',
      patch: {
        mode: 'owner_migration',
        expectedAccountEncryptionMode: 'e2ee',
        expectedAccountContentPublicKeyFingerprint:
          `content-public-key-sha256:${'a'.repeat(64)}`,
        source: {
          metadataLayoutVersion: 0,
          metadata: {
            version: 7,
            ciphertext: 'metadata-exact-source',
          },
          ownerMetadata: null,
          agentState: {
            version: 9,
            ciphertext: null,
          },
        },
        target: {
          metadataLayoutVersion: 1,
          sharedMetadata: { ciphertext: 'shared-target' },
          ownerMetadata: {
            ciphertext:
              'oQoBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGDb9gtt8Xqs3gDuzJU/wWRuslcRY3OZA==',
          },
          agentState: { ciphertext: null },
        },
      },
    })).rejects.toThrow(
      'Unexpected /v2/sessions/session/one owner-migration refusal response shape',
    );
  });

  it('maps the immutable v0.2.1 empty-body 400 to a typed nonretryable upgrade error', async () => {
    vi.spyOn(axios, 'patch').mockResolvedValueOnce({
      status: 400,
      data: {
        error: 'Invalid parameters',
      },
    } as never);

    await expect(
      patchSessionMetadataEnvelopeTuple(request),
    ).rejects.toMatchObject({
      code: 'metadata_privacy_upgrade_required',
      retryable: false,
    });
  });
});

describe('patchSessionMetadata', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends the inactive-model-intent expectation on a layout-zero metadata patch', async () => {
    const patch = vi.spyOn(axios, 'patch').mockResolvedValueOnce({
      status: 200,
      data: {
        success: true,
        metadata: { version: 4 },
      },
    } as never);

    await expect(patchSessionMetadata({
      token: 'token-1',
      sessionId: 'session/one',
      ciphertext: 'legacy-model-intent',
      expectedVersion: 3,
      sessionExpectation: {
        kind: 'inactive_model_intent',
      },
    })).resolves.toEqual({
      success: true,
      version: 4,
    });
    expect(patch).toHaveBeenCalledWith(
      expect.stringContaining('/v2/sessions/session%2Fone'),
      {
        inactiveModelIntent: {
          metadata: {
            ciphertext: 'legacy-model-intent',
            expectedVersion: 3,
          },
          sessionExpectation: {
            kind: 'inactive_model_intent',
          },
        },
      },
      expect.objectContaining({
        validateStatus: expect.any(Function),
      }),
    );
  });

  it('returns a typed active conflict from the strict HTTP 409', async () => {
    vi.spyOn(axios, 'patch').mockResolvedValueOnce({
      status: 409,
      data: {
        code: 'session_active',
      },
    } as never);

    await expect(patchSessionMetadata({
      token: 'token-1',
      sessionId: 'session/one',
      ciphertext: 'legacy-model-intent',
      expectedVersion: 3,
      sessionExpectation: {
        kind: 'inactive_model_intent',
      },
    })).resolves.toEqual({
      success: false,
      error: 'session_active',
    });
  });

  it.each([
    {
      name: 'private success field',
      data: {
        success: true,
        metadata: {
          version: 4,
          value: 'must-not-appear-on-success',
        },
      },
    },
    {
      name: 'unknown version-conflict field',
      data: {
        success: false,
        error: 'version-mismatch',
        metadata: {
          version: 4,
          value: 'current-owner-ciphertext',
        },
        agentState: {
          version: 7,
          value: 'must-not-appear',
        },
      },
    },
  ])('rejects conditioned responses with a $name', async ({ data }) => {
    vi.spyOn(axios, 'patch').mockResolvedValueOnce({
      status: 200,
      data,
    } as never);

    await expect(patchSessionMetadata({
      token: 'token-1',
      sessionId: 'session/one',
      ciphertext: 'legacy-model-intent',
      expectedVersion: 3,
      sessionExpectation: {
        kind: 'inactive_model_intent',
      },
    })).rejects.toThrow(
      'conditioned patch response shape',
    );
  });

  it('fails closed when a predecessor strips the novel conditioned branch and returns 400', async () => {
    vi.spyOn(axios, 'patch').mockResolvedValueOnce({
      status: 400,
      data: {
        error: 'Invalid parameters',
      },
    } as never);

    await expect(patchSessionMetadata({
      token: 'token-1',
      sessionId: 'session/one',
      ciphertext: 'legacy-model-intent',
      expectedVersion: 3,
      sessionExpectation: {
        kind: 'inactive_model_intent',
      },
    })).rejects.toMatchObject({
      code: 'metadata_privacy_upgrade_required',
      retryable: false,
    });
  });
});
