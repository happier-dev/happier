import { describe, expect, it, vi } from 'vitest';

import {
  decideAuthenticatedPluginInstallReview,
  readPluginInstallReviewRequiredEnvelope,
} from './authenticatedInstallReview';
import {
  decryptLegacyBase64,
  encryptLegacyBase64,
} from '../messageCrypto';
import {
  decryptDataKeyBase64,
  encryptDataKeyBase64,
} from '../rpcCrypto';

function socket() {
  return {
    connect: vi.fn(),
    close: vi.fn(),
    isConnected: vi.fn(() => true),
    rpcCall: vi.fn(),
  };
}

const completeReview = {
  pluginId: 'acme.plugin',
  displayName: 'Acme Plugin',
  version: '1.0.0',
  packageIdentity: { name: '@acme/plugin', version: '1.0.0' },
  publisherIdentity: { status: 'unverified', id: 'acme', displayName: 'Acme' },
  source: {
    kind: 'npm',
    locator: 'https://registry.example.test/acme-plugin.tgz',
    integrity: 'sha512-candidate',
  },
  updateChannel: {
    kind: 'npm',
    packageName: '@acme/plugin',
    registryOrigin: 'https://registry.example.test',
    marketplaceSource: {
      id: 'marketplace:curated',
      kind: 'curated',
      sourceUrl: 'https://marketplace.example.test/catalog.json',
    },
  },
  signature: { status: 'verified', keyId: 'registry-key-1' },
  provenance: { status: 'retrievedUnverified', predicateTypes: ['https://slsa.dev/provenance/v1'] },
  curation: {
    status: 'approved',
    sourceId: 'marketplace:curated',
    reviewedAt: '2026-07-24T00:00:00.000Z',
  },
  executableRealms: ['daemon'],
  contributions: [{ family: 'actions', count: 1 }],
  requestInterceptors: [],
  uiArtifacts: { status: 'none', contributionIds: [] },
  requiredHostAccess: [{
    id: 'required-network',
    capability: 'network',
    reason: 'Connect to the Acme service',
    authorizationClass: 'cooperativeDisclosure',
    normalizedScope: { targets: [{ kind: 'fixedOrigin', origin: 'https://api.acme.test' }] },
  }],
  optionalHostAccess: [],
  rawCredentialAccess: [{
    accessMode: 'raw',
    contribution: { pluginId: 'acme.voice', localId: 'conversation' },
    credentialSlot: {
      id: 'voice_auth',
      title: 'Voice credential',
      purpose: 'voice.client-auth',
    },
    sourceClass: { kind: 'savedSecret', secretKinds: ['apiKey'] },
    realm: 'web',
    phase: 'connection',
    request: {
      kind: 'httpHeaders',
      origin: 'https://voice.example.test',
      headerNames: ['authorization'],
    },
  }],
  compatibility: { happier: '^0.2.0', runtimeApiVersion: 1 },
  updatePolicy: 'automatic',
} as const;

function reviewRequiredEnvelope(review: unknown) {
  return {
    ok: false as const,
    kind: 'plugins_install' as const,
    error: {
      code: 'review_required',
      message: 'Review required',
      pendingChangeId: 'pending-1',
      review,
    },
  };
}

describe('decideAuthenticatedPluginInstallReview', () => {
  it('reads the CLI review_required facts without treating them as install authority', () => {
    expect(readPluginInstallReviewRequiredEnvelope(reviewRequiredEnvelope(completeReview))).toEqual({
      pendingChangeId: 'pending-1',
      review: completeReview,
    });
  });

  it('retains strict request-interceptor review facts', () => {
    const requestInterceptor = {
      id: 'protect-api',
      origins: ['https://accounts.example.test', 'https://api.example.test'],
      methods: ['GET', 'POST'],
      priority: 25,
    } as const;
    const review = {
      ...completeReview,
      requestInterceptors: [requestInterceptor],
    } as const;

    expect(readPluginInstallReviewRequiredEnvelope(reviewRequiredEnvelope(review))).toEqual({
      pendingChangeId: 'pending-1',
      review,
    });

    const invalidRequestInterceptors = [
      [{ ...requestInterceptor, unexpected: true }],
      [{ ...requestInterceptor, id: 'Protect-API' }],
      [{ ...requestInterceptor, origins: ['ftp://api.example.test'] }],
      [{ ...requestInterceptor, methods: ['TRACE'] }],
      [{ ...requestInterceptor, priority: 25.5 }],
    ];
    for (const requestInterceptors of invalidRequestInterceptors) {
      expect(() => readPluginInstallReviewRequiredEnvelope(reviewRequiredEnvelope({
        ...completeReview,
        requestInterceptors,
      }))).toThrow(/malformed review_required facts \(review\.requestInterceptors: invalid\)/);
    }
  });

  it('rejects raw credential selection or secret material that is not a review fact', () => {
    expect(() => readPluginInstallReviewRequiredEnvelope(reviewRequiredEnvelope({
      ...completeReview,
      rawCredentialAccess: [{
        ...completeReview.rawCredentialAccess[0],
        accountId: 'selected-account-1',
      }],
    }))).toThrow(/malformed review_required facts \(review\.rawCredentialAccess: invalid\)/);
    expect(() => readPluginInstallReviewRequiredEnvelope(reviewRequiredEnvelope({
      ...completeReview,
      rawCredentialAccess: [{
        ...completeReview.rawCredentialAccess[0],
        request: {
          ...completeReview.rawCredentialAccess[0].request,
          secretValue: 'not-a-review-fact',
        },
      }],
    }))).toThrow(/malformed review_required facts \(review\.rawCredentialAccess: invalid\)/);
  });

  it('retains bounded newer-version compatibility facts without treating them as an install decision', () => {
    const review = {
      ...completeReview,
      compatibility: {
        ...completeReview.compatibility,
        blockedNewerVersions: [{
          version: '1.1.0',
          diagnostics: [{
            code: 'plugin_manifest_semantic_invalid',
            message: 'Plugin manifest requires happier >=9999.0.0',
          }],
        }],
      },
    } as const;

    expect(readPluginInstallReviewRequiredEnvelope(reviewRequiredEnvelope(review))).toEqual({
      pendingChangeId: 'pending-1',
      review,
    });
    expect(() => readPluginInstallReviewRequiredEnvelope(reviewRequiredEnvelope({
      ...review,
      compatibility: {
        ...review.compatibility,
        blockedNewerVersions: Array.from({ length: 33 }, () => review.compatibility.blockedNewerVersions[0]),
      },
    }))).toThrow(/malformed review_required facts \(review\.compatibility: invalid\)/);
  });

  it('accepts the bounded daemon-entry compatibility diagnostic emitted before download', () => {
    const review = {
      ...completeReview,
      compatibility: {
        ...completeReview.compatibility,
        blockedNewerVersions: [{
          version: '1.1.0',
          diagnostics: [{
            code: 'plugin_manifest_semantic_invalid',
            message: 'Plugin daemon entry uses an unsupported extension',
          }],
        }],
      },
    } as const;

    expect(readPluginInstallReviewRequiredEnvelope(reviewRequiredEnvelope(review))).toEqual({
      pendingChangeId: 'pending-1',
      review,
    });
  });

  it('accepts the bounded generated UI artifact compatibility diagnostic emitted before download', () => {
    const review = {
      ...completeReview,
      compatibility: {
        ...completeReview.compatibility,
        blockedNewerVersions: [{
          version: '1.1.0',
          diagnostics: [{
            code: 'plugin_compatibility_projection_invalid',
            message: 'Generated UI artifact compatibility check failed: generated_ui_host_api_mismatch.',
          }],
        }],
      },
    } as const;

    expect(readPluginInstallReviewRequiredEnvelope(reviewRequiredEnvelope(review))).toEqual({
      pendingChangeId: 'pending-1',
      review,
    });
  });

  it('accepts the bounded incompatible-engine compatibility diagnostic emitted before download', () => {
    const review = {
      ...completeReview,
      compatibility: {
        ...completeReview.compatibility,
        blockedNewerVersions: [{
          version: '1.1.0',
          diagnostics: [{
            code: 'plugin_manifest_semantic_invalid',
            message: 'Plugin manifest requires a compatible Happier CLI version',
          }],
        }],
      },
    } as const;

    expect(readPluginInstallReviewRequiredEnvelope(reviewRequiredEnvelope(review))).toEqual({
      pendingChangeId: 'pending-1',
      review,
    });
  });

  it('accepts the bounded selected-engine compatibility declaration', () => {
    const review = {
      ...completeReview,
      compatibility: {
        ...completeReview.compatibility,
        happier: 'Declared compatible Happier CLI range',
      },
    } as const;

    expect(readPluginInstallReviewRequiredEnvelope(reviewRequiredEnvelope(review))).toEqual({
      pendingChangeId: 'pending-1',
      review,
    });
  });

  it('accepts an optional absent engine without inventing a host floor', () => {
    const review = {
      ...completeReview,
      compatibility: { runtimeApiVersion: 1 },
    } as const;

    expect(readPluginInstallReviewRequiredEnvelope(reviewRequiredEnvelope(review))).toEqual({
      pendingChangeId: 'pending-1',
      review,
    });
  });

  it('keeps archive/npm acquisition integrity while rejecting retired review digests and path integrity', () => {
    const pathReview = {
      ...completeReview,
      packageIdentity: { name: null, version: '1.0.0' },
      publisherIdentity: { status: 'unavailable' },
      source: { kind: 'path', locator: '/tmp/acme-plugin' },
      updateChannel: { kind: 'path', locator: '/tmp/acme-plugin', development: true },
      signature: { status: 'notProvided' },
      curation: { status: 'notApplicable' },
      updatePolicy: 'manual',
    } as const;
    const archiveReview = {
      ...pathReview,
      source: {
        kind: 'archive',
        locator: 'file:///tmp/acme-plugin.tar.gz',
        integrity: 'sha512-archive-candidate',
      },
      updateChannel: { kind: 'archive', locator: 'file:///tmp/acme-plugin.tar.gz' },
    } as const;

    expect(readPluginInstallReviewRequiredEnvelope(reviewRequiredEnvelope(pathReview))).toEqual({
      pendingChangeId: 'pending-1',
      review: pathReview,
    });
    expect(readPluginInstallReviewRequiredEnvelope(reviewRequiredEnvelope(archiveReview))).toEqual({
      pendingChangeId: 'pending-1',
      review: archiveReview,
    });
    expect(() => readPluginInstallReviewRequiredEnvelope(reviewRequiredEnvelope({
      ...completeReview,
      integrity: { retired: true },
    }))).toThrow(/malformed review_required facts \(review: unexpected_field\)/);
    expect(() => readPluginInstallReviewRequiredEnvelope(reviewRequiredEnvelope({
      ...pathReview,
      source: { ...pathReview.source, integrity: 'sha512-fabricated-local' },
    }))).toThrow(/malformed review_required facts \(review\.source: invalid\)/);
  });

  it('rejects an incomplete review before it can reach the decision helper', () => {
    const { signature: _missing, ...incompleteReview } = completeReview;
    expect(() => readPluginInstallReviewRequiredEnvelope({
      ok: false,
      kind: 'plugins_install',
      error: {
        code: 'review_required',
        message: 'Review required',
        pendingChangeId: 'pending-1',
        review: incompleteReview,
      },
    })).toThrow(/malformed review_required facts \(review\.signature: invalid\)/);
  });

  it('accepts the production review schema npm registry profile identity', () => {
    const review = {
      ...completeReview,
      updateChannel: {
        ...completeReview.updateChannel,
        registryProfileId: 'registry-private',
      },
    } as const;
    expect(readPluginInstallReviewRequiredEnvelope({
      ok: false,
      kind: 'plugins_install',
      error: {
        code: 'review_required',
        message: 'Review required',
        pendingChangeId: 'pending-1',
        review,
      },
    })).toEqual({
      pendingChangeId: 'pending-1',
      review,
    });
  });

  it('waits for the exact private legacy handler before confirmation and sends one decision', async () => {
    const reviewSocket = socket();
    const legacySecret = Uint8Array.from(Buffer.alloc(32, 1));
    reviewSocket.rpcCall
      .mockResolvedValueOnce({
        ok: false,
        errorCode: 'RPC_METHOD_NOT_AVAILABLE',
      })
      .mockResolvedValueOnce({
        ok: true,
        result: encryptLegacyBase64({
          ok: false,
          errorCode: 'invalid_request',
          error: 'invalid_request',
        }, legacySecret),
      });
    const events: string[] = [];
    const callLegacy = vi.fn(async () => {
      events.push('send');
      return { kind: 'committed' as const, pluginId: 'acme.plugin' };
    });
    const callDataKey = vi.fn();

    await expect(decideAuthenticatedPluginInstallReview({
      cliHomeDir: '/candidate/home',
      serverUrl: 'http://127.0.0.1:3000',
      pendingChangeId: 'pending-1',
      optionalSelections: [{ accessId: 'optional-secrets', selected: true }],
      confirmPresentUser: async () => {
        events.push('confirm');
        return true;
      },
      deps: {
        readAccessKey: vi.fn(async () => ({
          token: 'token-1',
          secret: Buffer.from(legacySecret).toString('base64'),
        })),
        readMachineId: vi.fn(async () => 'machine-1'),
        createUserSocket: vi.fn(() => reviewSocket),
        waitForConnected: vi.fn(async () => undefined),
        callLegacy,
        callDataKey,
        createInteractionId: () => 'interaction-1',
        nowMs: () => 42,
      },
    })).resolves.toMatchObject({ kind: 'committed', pluginId: 'acme.plugin' });

    expect(events).toEqual(['confirm', 'send']);
    expect(reviewSocket.rpcCall).toHaveBeenCalledTimes(2);
    expect(reviewSocket.rpcCall).toHaveBeenCalledWith(
      'machine-1:daemon.plugins.install.review.decide',
      expect.any(String),
      expect.any(Number),
    );
    for (const [, encryptedProbe] of reviewSocket.rpcCall.mock.calls) {
      expect(decryptLegacyBase64(encryptedProbe, legacySecret)).toEqual({});
    }
    expect(callLegacy).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      method: 'daemon.plugins.install.review.decide',
      timeoutMs: 5 * 60_000,
      payload: expect.objectContaining({
        pendingChangeId: 'pending-1',
        decision: 'installAndTrust',
        actorEvidence: {
          kind: 'authenticatedLocalUser',
          interactionId: 'interaction-1',
          occurredAtMs: 42,
        },
        optionalSelections: [{ accessId: 'optional-secrets', selected: true }],
      }),
    }));
    expect(callLegacy).toHaveBeenCalledOnce();
    expect(callDataKey).not.toHaveBeenCalled();
    expect(reviewSocket.close).toHaveBeenCalledOnce();
  });

  it('uses the authenticated data-key authority after malformed readiness probes with zero decision effect', async () => {
    const reviewSocket = socket();
    const machineKey = Uint8Array.from(Buffer.alloc(32, 3));
    reviewSocket.rpcCall
      .mockResolvedValueOnce({
        ok: false,
        errorCode: 'RPC_METHOD_NOT_AVAILABLE',
      })
      .mockResolvedValueOnce({
        ok: true,
        result: encryptDataKeyBase64({
          ok: false,
          errorCode: 'invalid_request',
          error: 'invalid_request',
        }, machineKey),
      });
    const callDataKey = vi.fn(async () => ({
      kind: 'committed' as const,
      pluginId: 'acme.plugin',
    }));

    await expect(decideAuthenticatedPluginInstallReview({
      cliHomeDir: '/candidate/home',
      serverUrl: 'http://127.0.0.1:3000',
      pendingChangeId: 'pending-1',
      optionalSelections: [],
      confirmPresentUser: async () => true,
      deps: {
        readAccessKey: vi.fn(async () => ({
          token: 'token-1',
          encryption: {
            publicKey: Buffer.alloc(32, 2).toString('base64'),
            machineKey: Buffer.from(machineKey).toString('base64'),
          },
        })),
        readMachineId: vi.fn(async () => 'machine-1'),
        createUserSocket: vi.fn(() => reviewSocket),
        waitForConnected: vi.fn(async () => undefined),
        callLegacy: vi.fn(),
        callDataKey,
        createInteractionId: () => 'interaction-1',
        nowMs: () => 42,
      },
    })).resolves.toMatchObject({
      kind: 'committed',
      pluginId: 'acme.plugin',
    });

    expect(reviewSocket.rpcCall).toHaveBeenCalledTimes(2);
    for (const [, encryptedProbe] of reviewSocket.rpcCall.mock.calls) {
      expect(decryptDataKeyBase64(encryptedProbe, machineKey)).toEqual({});
    }
    expect(callDataKey).toHaveBeenCalledOnce();
    expect(callDataKey).toHaveBeenCalledWith(expect.objectContaining({
      timeoutMs: 5 * 60_000,
      payload: expect.objectContaining({
        pendingChangeId: 'pending-1',
        decision: 'installAndTrust',
      }),
    }));
    expect(reviewSocket.close).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: 'non-unavailable outer error',
      result: {
        ok: false as const,
        errorCode: 'SERVER_REQUIRED',
      },
      expected: /SERVER_REQUIRED/,
      readinessTimeoutMs: 20_000,
    },
    {
      name: 'wrong decrypted handler shape',
      result: {
        ok: true as const,
        result: {
          ok: false,
          errorCode: 'invalid_request',
        },
      },
      expected: /invalid handler response/,
      readinessTimeoutMs: 20_000,
    },
    {
      name: 'unavailable timeout',
      result: {
        ok: false as const,
        errorCode: 'RPC_METHOD_NOT_AVAILABLE',
      },
      expected: /Timed out waiting/,
      readinessTimeoutMs: 20,
    },
  ])('fails closed on $name before confirmation or a decision effect', async (failureCase) => {
    const machineKey = Uint8Array.from(Buffer.alloc(32, 3));
    const reviewSocket = socket();
    const confirmPresentUser = vi.fn(async () => true);
    const callDataKey = vi.fn();

    await expect(decideAuthenticatedPluginInstallReview({
      cliHomeDir: '/candidate/home',
      serverUrl: 'http://127.0.0.1:3000',
      pendingChangeId: 'pending-1',
      optionalSelections: [],
      confirmPresentUser,
      deps: {
        readAccessKey: vi.fn(async () => ({
          token: 'token-1',
          encryption: {
            publicKey: Buffer.alloc(32, 2).toString('base64'),
            machineKey: Buffer.from(machineKey).toString('base64'),
          },
        })),
        readMachineId: vi.fn(async () => 'machine-1'),
        createUserSocket: vi.fn(() => reviewSocket),
        waitForConnected: vi.fn(async () => undefined),
        probeDataKey: vi.fn(async () => failureCase.result),
        callLegacy: vi.fn(),
        callDataKey,
        readinessTimeoutMs: failureCase.readinessTimeoutMs,
      },
    })).rejects.toThrow(failureCase.expected);

    expect(confirmPresentUser).not.toHaveBeenCalled();
    expect(callDataKey).not.toHaveBeenCalled();
    expect(reviewSocket.close).toHaveBeenCalledOnce();
  });

  it('fails closed when the socket disconnects after readiness and before the decision', async () => {
    const reviewSocket = socket();
    const legacySecret = Uint8Array.from(Buffer.alloc(32, 1));
    reviewSocket.rpcCall.mockResolvedValueOnce({
      ok: true,
      result: encryptLegacyBase64({
        ok: false,
        errorCode: 'invalid_request',
        error: 'invalid_request',
      }, legacySecret),
    });
    const callLegacy = vi.fn();

    await expect(decideAuthenticatedPluginInstallReview({
      cliHomeDir: '/candidate/home',
      serverUrl: 'http://127.0.0.1:3000',
      pendingChangeId: 'pending-1',
      optionalSelections: [],
      confirmPresentUser: async () => {
        reviewSocket.isConnected.mockReturnValue(false);
        return true;
      },
      deps: {
        readAccessKey: vi.fn(async () => ({
          token: 'token-1',
          secret: Buffer.from(legacySecret).toString('base64'),
        })),
        readMachineId: vi.fn(async () => 'machine-1'),
        createUserSocket: vi.fn(() => reviewSocket),
        waitForConnected: vi.fn(async () => undefined),
        callLegacy,
        callDataKey: vi.fn(),
      },
    })).rejects.toThrow(/authority changed/);

    expect(reviewSocket.rpcCall).toHaveBeenCalledOnce();
    expect(callLegacy).not.toHaveBeenCalled();
    expect(reviewSocket.close).toHaveBeenCalledOnce();
  });

  it('does not replay a decision when the exact route disappears after readiness', async () => {
    const reviewSocket = socket();
    const legacySecret = Uint8Array.from(Buffer.alloc(32, 1));
    reviewSocket.rpcCall
      .mockResolvedValueOnce({
        ok: true,
        result: encryptLegacyBase64({
          ok: false,
          errorCode: 'invalid_request',
          error: 'invalid_request',
        }, legacySecret),
      })
      .mockResolvedValueOnce({
        ok: false,
        errorCode: 'RPC_METHOD_NOT_AVAILABLE',
      });

    await expect(decideAuthenticatedPluginInstallReview({
      cliHomeDir: '/candidate/home',
      serverUrl: 'http://127.0.0.1:3000',
      pendingChangeId: 'pending-1',
      optionalSelections: [],
      confirmPresentUser: async () => true,
      deps: {
        readAccessKey: vi.fn(async () => ({
          token: 'token-1',
          secret: Buffer.from(legacySecret).toString('base64'),
        })),
        readMachineId: vi.fn(async () => 'machine-1'),
        createUserSocket: vi.fn(() => reviewSocket),
        waitForConnected: vi.fn(async () => undefined),
        createInteractionId: () => 'interaction-1',
        nowMs: () => 42,
      },
    })).rejects.toThrow(/RPC_METHOD_NOT_AVAILABLE/);

    expect(reviewSocket.rpcCall).toHaveBeenCalledTimes(2);
    expect(decryptLegacyBase64(reviewSocket.rpcCall.mock.calls[0]?.[1], legacySecret)).toEqual({});
    expect(decryptLegacyBase64(reviewSocket.rpcCall.mock.calls[1]?.[1], legacySecret)).toEqual({
      v: 1,
      pendingChangeId: 'pending-1',
      decision: 'installAndTrust',
      actorEvidence: {
        kind: 'authenticatedLocalUser',
        interactionId: 'interaction-1',
        occurredAtMs: 42,
      },
      optionalSelections: [],
    });
    expect(reviewSocket.close).toHaveBeenCalledOnce();
  });

  it('reports bounded socket connectivity evidence when the decision acknowledgement times out', async () => {
    const reviewSocket = socket() as ReturnType<typeof socket> & {
      getConnectivityState: ReturnType<typeof vi.fn>;
    };
    const legacySecret = Uint8Array.from(Buffer.alloc(32, 1));
    reviewSocket.rpcCall.mockResolvedValueOnce({
      ok: true,
      result: encryptLegacyBase64({
        ok: false,
        errorCode: 'invalid_request',
        error: 'invalid_request',
      }, legacySecret),
    });
    reviewSocket.getConnectivityState = vi.fn()
      .mockReturnValueOnce({
        connected: true,
        totalTransitionCount: 1,
        transitions: [{
          sequence: 1,
          kind: 'connect',
          at: 90,
        }],
      })
      .mockReturnValueOnce({
        connected: true,
        totalTransitionCount: 3,
        transitions: [{
          sequence: 1,
          kind: 'connect',
          at: 90,
        }, {
          sequence: 2,
          kind: 'disconnect',
          at: 120,
          reason: 'transport close',
        }, {
          sequence: 3,
          kind: 'connect',
          at: 140,
        }],
      });
    const nowMs = vi.fn()
      .mockReturnValueOnce(42)
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(200);

    await expect(decideAuthenticatedPluginInstallReview({
      cliHomeDir: '/candidate/home',
      serverUrl: 'http://127.0.0.1:3000',
      pendingChangeId: 'pending-1',
      optionalSelections: [],
      confirmPresentUser: async () => true,
      deps: {
        readAccessKey: vi.fn(async () => ({
          token: 'token-1',
          secret: Buffer.from(legacySecret).toString('base64'),
        })),
        readMachineId: vi.fn(async () => 'machine-1'),
        createUserSocket: vi.fn(() => reviewSocket),
        waitForConnected: vi.fn(async () => undefined),
        callLegacy: vi.fn(async () => {
          throw new Error('operation has timed out');
        }),
        callDataKey: vi.fn(),
        createInteractionId: () => 'interaction-1',
        nowMs,
      },
    })).rejects.toMatchObject({
      code: 'authenticated_plugin_install_review_timeout',
      diagnostic: {
        pendingChangeId: 'pending-1',
        machineId: 'machine-1',
        rpcStartedAtMs: 100,
        rpcTimedOutAtMs: 200,
        connectedBefore: true,
        connectedAfter: true,
        transitionCountDuringRpc: 2,
        omittedTransitionCountDuringRpc: 0,
        transitionsDuringRpc: [{
          sequence: 2,
          kind: 'disconnect',
          at: 120,
          reason: 'transport close',
        }, {
          sequence: 3,
          kind: 'connect',
          at: 140,
        }],
      },
    });

    expect(reviewSocket.close).toHaveBeenCalledOnce();
  });

  it('classifies the Socket.IO timeout envelope as an acknowledgement timeout', async () => {
    const reviewSocket = socket();
    const legacySecret = Uint8Array.from(Buffer.alloc(32, 1));
    reviewSocket.rpcCall
      .mockResolvedValueOnce({
        ok: true,
        result: encryptLegacyBase64({
          ok: false,
          errorCode: 'invalid_request',
          error: 'invalid_request',
        }, legacySecret),
      })
      .mockResolvedValueOnce({
        ok: false,
        error: 'operation has timed out',
      });
    const nowMs = vi.fn()
      .mockReturnValueOnce(42)
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(200);

    await expect(decideAuthenticatedPluginInstallReview({
      cliHomeDir: '/candidate/home',
      serverUrl: 'http://127.0.0.1:3000',
      pendingChangeId: 'pending-1',
      optionalSelections: [],
      confirmPresentUser: async () => true,
      deps: {
        readAccessKey: vi.fn(async () => ({
          token: 'token-1',
          secret: Buffer.from(legacySecret).toString('base64'),
        })),
        readMachineId: vi.fn(async () => 'machine-1'),
        createUserSocket: vi.fn(() => reviewSocket),
        waitForConnected: vi.fn(async () => undefined),
        createInteractionId: () => 'interaction-1',
        nowMs,
      },
    })).rejects.toMatchObject({
      code: 'authenticated_plugin_install_review_timeout',
      diagnostic: {
        pendingChangeId: 'pending-1',
        machineId: 'machine-1',
        rpcStartedAtMs: 100,
        rpcTimedOutAtMs: 200,
        connectedBefore: true,
        connectedAfter: true,
        transitionCountDuringRpc: 0,
        omittedTransitionCountDuringRpc: 0,
        transitionsDuringRpc: [],
      },
    });

    expect(reviewSocket.rpcCall).toHaveBeenCalledTimes(2);
    expect(reviewSocket.close).toHaveBeenCalledOnce();
  });

  it('fails closed before data-key RPC when the authenticated authority changes', async () => {
    const reviewSocket = socket();
    const machineKey = Uint8Array.from(Buffer.alloc(32, 3));
    reviewSocket.rpcCall.mockResolvedValueOnce({
      ok: true,
      result: encryptDataKeyBase64({
        ok: false,
        errorCode: 'invalid_request',
        error: 'invalid_request',
      }, machineKey),
    });
    const callDataKey = vi.fn();
    const readAccessKey = vi.fn()
      .mockResolvedValueOnce({
        token: 'token-1',
        encryption: {
          publicKey: Buffer.alloc(32, 2).toString('base64'),
          machineKey: Buffer.from(machineKey).toString('base64'),
        },
      })
      .mockResolvedValueOnce({
        token: 'token-2',
        encryption: {
          publicKey: Buffer.alloc(32, 2).toString('base64'),
          machineKey: Buffer.from(machineKey).toString('base64'),
        },
      });

    await expect(decideAuthenticatedPluginInstallReview({
      cliHomeDir: '/candidate/home',
      serverUrl: 'http://127.0.0.1:3000',
      pendingChangeId: 'pending-1',
      optionalSelections: [],
      confirmPresentUser: async () => true,
      deps: {
        readAccessKey,
        readMachineId: vi.fn(async () => 'machine-1'),
        createUserSocket: vi.fn(() => reviewSocket),
        waitForConnected: vi.fn(async () => undefined),
        callLegacy: vi.fn(),
        callDataKey,
      },
    })).rejects.toThrow(/authority changed/);

    expect(callDataKey).not.toHaveBeenCalled();
    expect(reviewSocket.close).toHaveBeenCalledOnce();
  });
});
