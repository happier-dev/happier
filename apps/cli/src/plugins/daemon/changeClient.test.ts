import { describe, expect, it, vi } from 'vitest';

vi.mock('@/daemon/controlClient', () => ({
  decideDaemonPluginChange: vi.fn(),
  requestDaemonPluginChange: vi.fn(),
}));
vi.mock('@/daemon/ensureDaemon', () => ({ ensureDaemonRunningForSessionCommand: vi.fn() }));
vi.mock('@/terminal/prompts/promptConfirmYesNo', () => ({ promptConfirmYesNo: vi.fn() }));

import { createPluginInstallationReviewFixture } from '@/plugins/testkit/pluginInstallationReviewFixture';
import { formatPluginInstallationReviewForTerminal, requestUserPluginChange } from './changeClient';

const completeReview = createPluginInstallationReviewFixture;

describe('requestUserPluginChange', () => {
  it('renders every review class, including the curator reason, in the terminal decision', () => {
    const output = formatPluginInstallationReviewForTerminal(completeReview({
      packageIdentity: { name: '@acme/example', version: '1.0.0' },
      publisherIdentity: { status: 'unverified', id: 'acme', displayName: 'Acme' },
      source: { kind: 'npm', locator: 'https://registry.example.test/acme-example.tgz', integrity: 'sha512-exact' },
      updateChannel: {
        kind: 'npm',
        packageName: '@acme/example',
        registryOrigin: 'https://registry.example.test',
        registryProfileId: 'registry_private',
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
        reason: 'Reviewed for the curated channel',
      },
      contributions: [{ family: 'actions', count: 1 }],
      updatePolicy: 'automatic',
    }));
    expect(output).toContain('Identity:');
    expect(output).toContain('Verification signals:');
    expect(output).toContain('Reviewed for the curated channel');
    expect(output).toContain('registry profile registry_private');
    expect(output).toContain('Contributions: actions (1)');
    expect(output).toContain('Required disclosures and cooperative services:');
    expect(output).toContain('Optional host-owned resources');
    expect(output).toContain('Compatibility and updates:');
  });
  it('returns typed unavailability when the canonical daemon cannot be started', async () => {
    const requestChange = vi.fn();

    await expect(requestUserPluginChange({
      request: { kind: 'installPath', locator: '/tmp/example', development: false },
      approval: 'prompt',
    }, {
      ensureDaemon: async () => {
        throw new Error('daemon start failed');
      },
      requestChange,
    })).resolves.toEqual({ kind: 'unavailable', code: 'daemon_unavailable' });

    expect(requestChange).not.toHaveBeenCalled();
  });

  it('cancels before contacting the daemon when the command is aborted during startup', async () => {
    const controller = new AbortController();
    let finishDaemonStartup!: () => void;
    const ensureDaemon = vi.fn(async () => await new Promise<void>((resolve) => {
      finishDaemonStartup = resolve;
    }));
    const requestChange = vi.fn(async () => ({
      kind: 'unavailable' as const,
      code: 'daemon_unavailable' as const,
    }));

    const pending = requestUserPluginChange({
      request: { kind: 'installPath', locator: '/tmp/example', development: true },
      approval: 'prompt',
      signal: controller.signal,
    }, {
      ensureDaemon,
      requestChange,
    });
    await vi.waitFor(() => expect(ensureDaemon).toHaveBeenCalledTimes(1));
    controller.abort();

    try {
      await expect(Promise.race([
        pending,
        new Promise<'timed-out'>((resolveTimeout) => {
          setTimeout(() => resolveTimeout('timed-out'), 250);
        }),
      ])).resolves.toEqual({ kind: 'cancelled' });
      expect(requestChange).not.toHaveBeenCalled();
    } finally {
      finishDaemonStartup();
      await pending;
    }
  });

  it('starts the daemon and applies the one displayed Install & Trust decision', async () => {
    const ensureDaemon = vi.fn(async () => undefined);
    const decideChange = vi.fn(async () => ({
      kind: 'committed' as const,
      pluginId: 'acme.example',
      desiredGeneration: 'generation-1',
      appliedGeneration: 'generation-1',
      pendingSurfaces: [],
    }));
    const confirm = vi.fn(async (_message: string) => true);

    await expect(requestUserPluginChange({
      request: { kind: 'installPath', locator: '/tmp/example', development: false },
      approval: 'prompt',
    }, {
      ensureDaemon,
      confirm,
      requestChange: async () => ({
        kind: 'reviewRequired',
        pendingChangeId: 'pending-1',
        review: completeReview({
          source: { kind: 'path', locator: '/tmp/example', integrity: 'sha256-review-digest' },
          updateChannel: { kind: 'path', locator: '/tmp/example', development: false },
          executableRealms: ['daemon', 'reactNative'],
          requiredHostAccess: [
            {
              id: 'network',
              capability: 'network',
              reason: 'Reach the package service',
              authorizationClass: 'cooperativeDisclosure',
              normalizedScope: { targets: [{ kind: 'fixedOrigin', origin: 'https://packages.example.test' }] },
            },
          ],
          optionalHostAccess: [],
        }),
      }),
      decideChange,
      createInteractionId: () => 'interaction-1',
      nowMs: () => 1,
    })).resolves.toEqual(expect.objectContaining({ kind: 'committed' }));

    expect(ensureDaemon).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Install & Trust'));
    const reviewPrompt = String(confirm.mock.calls[0]?.[0]);
    for (const reviewedFact of [
      '/tmp/example',
      'Source integrity: Provided',
      'daemon',
      'reactNative',
      'network',
      'Reach the package service',
    ]) {
      expect(reviewPrompt).toContain(reviewedFact);
    }
    expect(decideChange).toHaveBeenCalledWith(expect.objectContaining({
      pendingChangeId: 'pending-1',
      decision: 'installAndTrust',
      actorEvidence: expect.objectContaining({ interactionId: 'interaction-1' }),
      optionalSelections: [],
    }));
  });

  it('asks once per optional host resource after package approval and sends every selection decision', async () => {
    const confirm = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const decideChange = vi.fn(async () => ({ kind: 'cancelled' as const }));

    await requestUserPluginChange({
      request: { kind: 'installPath', locator: '/tmp/example', development: false },
      approval: 'prompt',
    }, {
      ensureDaemon: async () => undefined,
      confirm,
      requestChange: async () => ({
        kind: 'reviewRequired',
        pendingChangeId: 'pending-1',
        review: completeReview({
          source: { kind: 'path', locator: '/tmp/example' },
          updateChannel: { kind: 'path', locator: '/tmp/example', development: false },
          executableRealms: ['daemon'],
          requiredHostAccess: [],
          optionalHostAccess: [
            { id: 'project-sessions', capability: 'sessions', reason: 'Work with selected sessions', authorizationClass: 'hostResourceSelection', normalizedScope: { access: ['read'] } },
            { id: 'account', capability: 'connectedAccounts', reason: 'Use a selected account', authorizationClass: 'hostResourceSelection', normalizedScope: { serviceRefs: [{ pluginId: 'acme.example', localId: 'service' }], operations: ['use'] } },
          ],
        }),
      }),
      decideChange,
      createInteractionId: () => 'interaction-1',
      nowMs: () => 1,
    });

    expect(confirm).toHaveBeenCalledTimes(3);
    expect(confirm.mock.calls[0]?.[0]).toContain('Install & Trust');
    for (const reviewedFact of [
      'project-sessions',
      'sessions',
      'Work with selected sessions',
      'account',
      'connectedAccounts',
      'Use a selected account',
    ]) {
      expect(confirm.mock.calls[0]?.[0]).toContain(reviewedFact);
    }
    expect(confirm.mock.calls[1]?.[0]).toContain('Work with selected sessions');
    expect(confirm.mock.calls[2]?.[0]).toContain('Use a selected account');
    expect(decideChange).toHaveBeenCalledWith(expect.objectContaining({
      decision: 'installAndTrust',
      optionalSelections: [
        { accessId: 'project-sessions', selected: true },
        { accessId: 'account', selected: false },
      ],
    }));
  });

  it('does not ask optional resource questions after cancelling package trust', async () => {
    const confirm = vi.fn(async () => false);
    const decideChange = vi.fn(async () => ({ kind: 'cancelled' as const }));

    await requestUserPluginChange({
      request: { kind: 'installPath', locator: '/tmp/example', development: false },
      approval: 'prompt',
    }, {
      ensureDaemon: async () => undefined,
      confirm,
      requestChange: async () => ({
        kind: 'reviewRequired',
        pendingChangeId: 'pending-1',
        review: completeReview({
          source: { kind: 'path', locator: '/tmp/example' },
          updateChannel: { kind: 'path', locator: '/tmp/example', development: false },
          executableRealms: ['daemon'],
          requiredHostAccess: [],
          optionalHostAccess: [
            { id: 'project-sessions', capability: 'sessions', reason: 'Work with selected sessions', authorizationClass: 'hostResourceSelection', normalizedScope: { access: ['read'] } },
          ],
        }),
      }),
      decideChange,
    });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(decideChange).toHaveBeenCalledWith({ pendingChangeId: 'pending-1', decision: 'cancel' });
  });

  it('does not let the command signal suppress an explicit trust cancellation', async () => {
    const controller = new AbortController();
    const decideChange = vi.fn(async () => ({ kind: 'cancelled' as const }));

    await expect(requestUserPluginChange({
      request: { kind: 'installPath', locator: '/tmp/example', development: true },
      approval: 'prompt',
      signal: controller.signal,
    }, {
      ensureDaemon: async () => undefined,
      confirm: async () => false,
      requestChange: async () => ({
        kind: 'reviewRequired',
        pendingChangeId: 'pending-1',
        review: completeReview({
          source: { kind: 'path', locator: '/tmp/example' },
          updateChannel: { kind: 'path', locator: '/tmp/example', development: true },
          executableRealms: ['daemon'],
          requiredHostAccess: [],
          optionalHostAccess: [],
        }),
      }),
      decideChange,
    })).resolves.toEqual({ kind: 'cancelled' });

    expect(decideChange).toHaveBeenCalledWith({
      pendingChangeId: 'pending-1',
      decision: 'cancel',
    });
  });

  it('cancels daemon custody when the command is aborted during trust review', async () => {
    const controller = new AbortController();
    const decideChange = vi.fn(async () => ({ kind: 'cancelled' as const }));
    const confirm = vi.fn(async (
      _message: string,
      options?: Readonly<{ signal?: AbortSignal }>,
    ) => await new Promise<boolean>((resolve) => {
      controller.signal.addEventListener('abort', () => resolve(false), { once: true });
      expect(options?.signal).toBe(controller.signal);
    }));

    const pending = requestUserPluginChange({
      request: { kind: 'installPath', locator: '/tmp/example', development: true },
      approval: 'prompt',
      signal: controller.signal,
    }, {
      ensureDaemon: async () => undefined,
      confirm,
      requestChange: async () => ({
        kind: 'reviewRequired',
        pendingChangeId: 'pending-1',
        review: completeReview({
          source: { kind: 'path', locator: '/tmp/example' },
          updateChannel: { kind: 'path', locator: '/tmp/example', development: true },
          executableRealms: ['daemon'],
          requiredHostAccess: [],
          optionalHostAccess: [],
        }),
      }),
      decideChange,
    });
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(pending).resolves.toEqual({ kind: 'cancelled' });
    expect(decideChange).toHaveBeenCalledWith({
      pendingChangeId: 'pending-1',
      decision: 'cancel',
    });
  });

  it('cancels daemon custody exactly once when the terminal trust prompt is interrupted', async () => {
    const interrupted = new Error('Terminal prompt aborted');
    interrupted.name = 'AbortError';
    const decideChange = vi.fn(async () => ({ kind: 'cancelled' as const }));

    await expect(requestUserPluginChange({
      request: { kind: 'installPath', locator: '/tmp/example', development: true },
      approval: 'prompt',
    }, {
      ensureDaemon: async () => undefined,
      confirm: async () => {
        throw interrupted;
      },
      requestChange: async () => ({
        kind: 'reviewRequired',
        pendingChangeId: 'pending-1',
        review: completeReview({
          source: { kind: 'path', locator: '/tmp/example' },
          updateChannel: { kind: 'path', locator: '/tmp/example', development: true },
          executableRealms: ['daemon'],
          requiredHostAccess: [],
          optionalHostAccess: [],
        }),
      }),
      decideChange,
    })).resolves.toEqual({ kind: 'cancelled' });

    expect(decideChange).toHaveBeenCalledTimes(1);
    expect(decideChange).toHaveBeenCalledWith({
      pendingChangeId: 'pending-1',
      decision: 'cancel',
    });
  });

  it('does not let a direct pre-review flag approve unseen package facts', async () => {
    const confirm = vi.fn(async (_message: string) => true);
    const decideChange = vi.fn(async () => ({ kind: 'cancelled' as const }));

    await requestUserPluginChange({
      request: { kind: 'installPath', locator: '/tmp/example', development: false },
      // @ts-expect-error Caller-selected preapproval is intentionally not part of the user-change API.
      approval: 'approved',
    }, {
      ensureDaemon: async () => undefined,
      confirm,
      requestChange: async () => ({
        kind: 'reviewRequired',
        pendingChangeId: 'pending-1',
        review: completeReview({
          source: { kind: 'path', locator: '/tmp/example' },
          updateChannel: { kind: 'path', locator: '/tmp/example', development: false },
          executableRealms: ['daemon'],
          requiredHostAccess: [],
          optionalHostAccess: [
            { id: 'project-sessions', capability: 'sessions', reason: 'Work with selected sessions', authorizationClass: 'hostResourceSelection', normalizedScope: { access: ['read'] } },
          ],
        }),
      }),
      decideChange,
    });

    expect(confirm.mock.calls[0]?.[0]).toContain('Install & Trust');
    expect(confirm.mock.calls[0]?.[0]).toContain('/tmp/example');
    expect(confirm.mock.calls[0]?.[0]).toContain('project-sessions');
    expect(decideChange).toHaveBeenCalledWith(expect.objectContaining({
      decision: 'installAndTrust',
      optionalSelections: [{ accessId: 'project-sessions', selected: true }],
    }));
  });

  it('issues present-user evidence only after terminal confirmation', async () => {
    const requestChange = vi.fn(async () => ({
      kind: 'reviewRequired' as const,
      pendingChangeId: 'pending-curated',
      review: completeReview({
        version: '1.2.3',
        packageIdentity: { name: '@acme/example', version: '1.2.3' },
        source: { kind: 'npm', locator: '@acme/example@1.2.3' },
        executableRealms: ['daemon' as const],
        requiredHostAccess: [],
        optionalHostAccess: [],
      }),
    }));
    const decideChange = vi.fn(async () => ({
      kind: 'committed' as const,
      pluginId: 'acme.example',
      desiredGeneration: 'generation-1',
      appliedGeneration: 'generation-1',
      pendingSurfaces: [],
    }));

    await expect(requestUserPluginChange({
      request: {
        kind: 'installNpm',
        packageName: '@acme/example',
        selector: '1.2.3',
        registryOrigin: 'https://registry.npmjs.org',
        expectedMarketplaceListing: {
          source: { id: 'marketplace:curated', kind: 'curated', sourceUrl: 'https://marketplace.example.test/catalog.json' },
          pluginId: 'acme.example',
          publisher: { id: 'acme', displayName: 'Acme' },
          packageName: '@acme/example',
          registryOrigin: 'https://registry.npmjs.org',
          version: '1.2.3',
          integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
          manifestDigest: `sha256:${'a'.repeat(64)}`,
          review: { status: 'approved', reviewedAt: '2026-07-21T00:00:00.000Z' },
          updatePolicy: 'automatic',
        },
      },
      approval: 'prompt',
    }, {
      ensureDaemon: async () => undefined,
      confirm: async () => true,
      requestChange,
      decideChange,
      createInteractionId: () => 'marketplace-install',
      nowMs: () => 20,
    })).resolves.toEqual(expect.objectContaining({ kind: 'committed' }));

    expect(requestChange).toHaveBeenCalledWith(expect.objectContaining({
      expectedMarketplaceListing: expect.not.objectContaining({
        actorEvidence: expect.anything(),
      }),
    }));
    expect(decideChange).toHaveBeenCalledWith(expect.objectContaining({
      pendingChangeId: 'pending-curated',
      decision: 'installAndTrust',
      actorEvidence: {
        kind: 'authenticatedLocalUser',
        interactionId: 'marketplace-install',
        occurredAtMs: 20,
      },
    }));
  });

  it('returns a curated review without carrying caller evidence in headless mode', async () => {
    const requestChange = vi.fn(async () => ({
      kind: 'reviewRequired' as const,
      pendingChangeId: 'pending-curated',
      review: completeReview({
        version: '1.2.3',
        packageIdentity: { name: '@acme/example', version: '1.2.3' },
        source: { kind: 'npm', locator: '@acme/example@1.2.3' },
        executableRealms: ['daemon' as const],
        requiredHostAccess: [],
        optionalHostAccess: [],
      }),
    }));
    const decideChange = vi.fn();

    await expect(requestUserPluginChange({
      request: {
        kind: 'installNpm',
        packageName: '@acme/example',
        selector: '1.2.3',
        registryOrigin: 'https://registry.npmjs.org',
        expectedMarketplaceListing: {
          source: { id: 'marketplace:curated', kind: 'curated', sourceUrl: 'https://marketplace.example.test/catalog.json' },
          pluginId: 'acme.example',
          publisher: { id: 'acme', displayName: 'Acme' },
          packageName: '@acme/example',
          registryOrigin: 'https://registry.npmjs.org',
          version: '1.2.3',
          integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
          manifestDigest: `sha256:${'a'.repeat(64)}`,
          review: { status: 'approved', reviewedAt: '2026-07-21T00:00:00.000Z' },
          updatePolicy: 'automatic',
        },
      },
      approval: 'none',
    }, {
      ensureDaemon: async () => undefined,
      requestChange,
      decideChange,
    })).resolves.toMatchObject({ kind: 'reviewRequired', pendingChangeId: 'pending-curated' });

    expect(requestChange).toHaveBeenCalledWith(expect.objectContaining({
      expectedMarketplaceListing: expect.not.objectContaining({ actorEvidence: expect.anything() }),
    }));
    expect(decideChange).not.toHaveBeenCalled();
  });

  it('returns reviewRequired without fabricating approval in headless mode', async () => {
    const decideChange = vi.fn();
    await expect(requestUserPluginChange({
      request: { kind: 'installPath', locator: '/tmp/example', development: false },
      approval: 'none',
    }, {
      ensureDaemon: async () => undefined,
      requestChange: async () => ({
        kind: 'reviewRequired',
        pendingChangeId: 'pending-1',
        review: completeReview({
          source: { kind: 'path', locator: '/tmp/example' },
          updateChannel: { kind: 'path', locator: '/tmp/example', development: false },
          executableRealms: [],
          requiredHostAccess: [],
          optionalHostAccess: [],
        }),
      }),
      decideChange,
    })).resolves.toEqual(expect.objectContaining({ kind: 'reviewRequired' }));
    expect(decideChange).not.toHaveBeenCalled();
  });

  it('does not prompt or create a decision for already-authorized mutations', async () => {
    const confirm = vi.fn();
    const decideChange = vi.fn();
    await expect(requestUserPluginChange({
      request: { kind: 'disable', pluginId: 'acme.example' },
      approval: 'prompt',
    }, {
      ensureDaemon: async () => undefined,
      confirm,
      requestChange: async () => ({
        kind: 'committed',
        pluginId: 'acme.example',
        desiredGeneration: 'generation-1',
        appliedGeneration: 'generation-1',
        pendingSurfaces: [],
      }),
      decideChange,
    })).resolves.toEqual(expect.objectContaining({ kind: 'committed' }));
    expect(confirm).not.toHaveBeenCalled();
    expect(decideChange).not.toHaveBeenCalled();
  });

  it('reports outcomeUnknown when the approval response is lost after the daemon may have applied it', async () => {
    await expect(requestUserPluginChange({
      request: { kind: 'installPath', locator: '/tmp/example', development: false },
      approval: 'prompt',
    }, {
      ensureDaemon: async () => undefined,
      confirm: async () => true,
      requestChange: async () => ({
        kind: 'reviewRequired',
        pendingChangeId: 'pending-1',
        review: completeReview({
          source: { kind: 'path', locator: '/tmp/example' },
          updateChannel: { kind: 'path', locator: '/tmp/example', development: false },
          executableRealms: ['daemon'],
          requiredHostAccess: [],
          optionalHostAccess: [],
        }),
      }),
      decideChange: async () => ({ kind: 'unavailable', code: 'daemon_unavailable' }),
    })).resolves.toEqual({ kind: 'outcomeUnknown', pluginId: 'acme.example' });
  });

  it('reports outcomeUnknown when an already-authorized state mutation loses its response', async () => {
    await expect(requestUserPluginChange({
      request: { kind: 'disable', pluginId: 'acme.example' },
      approval: 'prompt',
    }, {
      ensureDaemon: async () => undefined,
      requestChange: async () => ({ kind: 'unavailable', code: 'daemon_unavailable' }),
    })).resolves.toEqual({ kind: 'outcomeUnknown', pluginId: 'acme.example' });
  });

  it('preserves known pre-commit daemon unavailability instead of reporting an ambiguous outcome', async () => {
    await expect(requestUserPluginChange({
      request: { kind: 'disable', pluginId: 'acme.example' },
      approval: 'prompt',
    }, {
      ensureDaemon: async () => undefined,
      requestChange: async () => ({
        kind: 'unavailable',
        code: 'pending_confirmation_capacity',
      }),
    })).resolves.toEqual({
      kind: 'unavailable',
      code: 'pending_confirmation_capacity',
    });
  });

  it('preserves a known pre-commit unavailable decision after approval', async () => {
    await expect(requestUserPluginChange({
      request: { kind: 'installPath', locator: '/tmp/example', development: false },
      approval: 'prompt',
    }, {
      ensureDaemon: async () => undefined,
      confirm: async () => true,
      requestChange: async () => ({
        kind: 'reviewRequired',
        pendingChangeId: 'pending-1',
        review: completeReview({
          source: { kind: 'path', locator: '/tmp/example' },
          updateChannel: { kind: 'path', locator: '/tmp/example', development: false },
          executableRealms: ['daemon'],
          requiredHostAccess: [],
          optionalHostAccess: [],
        }),
      }),
      decideChange: async () => ({
        kind: 'unavailable',
        code: 'daemon_shutting_down',
      }),
    })).resolves.toEqual({
      kind: 'unavailable',
      code: 'daemon_shutting_down',
    });
  });
});
