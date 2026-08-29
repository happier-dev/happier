import { join, resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/daemon/controlClient', () => ({
  decideDaemonPluginChange: vi.fn(),
  requestDaemonPluginChange: vi.fn(),
}));
vi.mock('@/daemon/ensureDaemon', () => ({ ensureDaemonRunningForSessionCommand: vi.fn() }));
vi.mock('@/terminal/prompts/promptConfirmYesNo', () => ({ promptConfirmYesNo: vi.fn() }));

import { createPluginInstallationReviewFixture } from '@/plugins/testkit/pluginInstallationReviewFixture';
import type { PluginInstallationReview } from './changeContract';
import {
  decideUserPluginChange,
  formatPluginInstallationReviewForTerminal,
  readUserPluginChangeStatus,
  requestUserPluginChange,
} from './changeClient';

const completeReview = createPluginInstallationReviewFixture;
const absoluteFixturePath = resolve('/tmp/example-plugin-source');

describe('requestUserPluginChange', () => {
  it('rejoins a pending change by status only, without re-requesting or deciding it', async () => {
    const ensureDaemon = vi.fn(async () => undefined);
    const readStatus = vi.fn(async () => ({
      kind: 'reviewRequired' as const,
      pendingChangeId: 'pending-1',
      review: completeReview(),
    }));

    await expect(readUserPluginChangeStatus({ pendingChangeId: 'pending-1' }, {
      ensureDaemon,
      readStatus,
    })).resolves.toMatchObject({
      kind: 'reviewRequired',
      pendingChangeId: 'pending-1',
    });

    expect(ensureDaemon).toHaveBeenCalledTimes(1);
    expect(readStatus).toHaveBeenCalledWith({ pendingChangeId: 'pending-1' });
  });

  it('continues one pending source-root review through explicit decisions without creating another request', async () => {
    const ensureDaemon = vi.fn(async () => undefined);
    const sourceRootReview = {
      kind: 'sourceRootReviewRequired' as const,
      pendingChangeId: 'pending-1',
      review: { source: { kind: 'path' as const, locator: '/tmp/example' } },
    };
    const packageReview = {
      kind: 'reviewRequired' as const,
      pendingChangeId: 'pending-1',
      review: completeReview({
        source: { kind: 'path', locator: '/tmp/example' },
        updateChannel: { kind: 'path', locator: '/tmp/example', development: true },
      }),
    };
    const readStatus = vi.fn()
      .mockResolvedValueOnce(sourceRootReview)
      .mockResolvedValueOnce(packageReview);
    const decideChange = vi.fn()
      .mockResolvedValueOnce(packageReview)
      .mockResolvedValueOnce({
        kind: 'committed' as const,
        pluginId: 'acme.example',
        desiredGeneration: 'generation-1',
        appliedGeneration: 'generation-1',
        pendingSurfaces: [],
      });

    await expect(decideUserPluginChange({
      pendingChangeId: 'pending-1',
      decision: 'approve',
    }, {
      ensureDaemon,
      readStatus,
      decideChange,
      createInteractionId: () => 'interaction-1',
      nowMs: () => 1,
    })).resolves.toEqual(packageReview);

    await expect(decideUserPluginChange({
      pendingChangeId: 'pending-1',
      decision: 'approve',
    }, {
      ensureDaemon,
      readStatus,
      decideChange,
      createInteractionId: () => 'interaction-2',
      nowMs: () => 2,
    })).resolves.toEqual({
      kind: 'committed',
      pluginId: 'acme.example',
      desiredGeneration: 'generation-1',
      appliedGeneration: 'generation-1',
      pendingSurfaces: [],
    });

    expect(readStatus).toHaveBeenNthCalledWith(1, { pendingChangeId: 'pending-1' });
    expect(readStatus).toHaveBeenNthCalledWith(2, { pendingChangeId: 'pending-1' });
    expect(decideChange).toHaveBeenNthCalledWith(1, {
      pendingChangeId: 'pending-1',
      decision: 'trustSourceRoot',
      actorEvidence: {
        kind: 'authenticatedLocalUser',
        interactionId: 'interaction-1',
        occurredAtMs: 1,
      },
    });
    expect(decideChange).toHaveBeenNthCalledWith(2, {
      pendingChangeId: 'pending-1',
      decision: 'installAndTrust',
      actorEvidence: {
        kind: 'authenticatedLocalUser',
        interactionId: 'interaction-2',
        occurredAtMs: 2,
      },
      optionalSelections: [],
    });
    expect(ensureDaemon).toHaveBeenCalledTimes(2);
  });

  it('rejects a pending review through the daemon owner without fabricating user evidence', async () => {
    const readStatus = vi.fn(async () => ({
      kind: 'reviewRequired' as const,
      pendingChangeId: 'pending-1',
      review: completeReview(),
    }));
    const decideChange = vi.fn(async () => ({ kind: 'cancelled' as const }));

    await expect(decideUserPluginChange({
      pendingChangeId: 'pending-1',
      decision: 'reject',
    }, {
      ensureDaemon: async () => undefined,
      readStatus,
      decideChange,
    })).resolves.toEqual({ kind: 'cancelled' });

    expect(decideChange).toHaveBeenCalledWith({
      pendingChangeId: 'pending-1',
      decision: 'cancel',
    });
  });

  it('renders every review class, including the curator reason, in the terminal decision', () => {
    const output = formatPluginInstallationReviewForTerminal(completeReview({
      packageIdentity: { name: '@acme/example', version: '1.0.0' },
      publisherIdentity: { status: 'unverified', id: 'acme', displayName: 'Acme' },
      source: { kind: 'npm', locator: 'https://registry.example.test/acme-example.tgz', integrity: 'sha512-exact', integrityBasis: 'expected' },
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
      compatibility: {
        happier: '^0.2.0',
        runtimeApiVersion: 1,
        blockedNewerVersions: [{
          version: '1.2.5',
          diagnostics: [{
            code: 'plugin_manifest_semantic_invalid',
            message: 'Plugin manifest requires happier >=9999.0.0',
          }],
        }],
      },
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
    expect(output).toContain('Newer versions blocked before download:');
    expect(output).toContain('1.2.5 [plugin_manifest_semantic_invalid]: Plugin manifest requires happier >=9999.0.0');
  });

  it('discloses each request interceptor policy before trust', () => {
    const output = formatPluginInstallationReviewForTerminal({
      ...completeReview(),
      requestInterceptors: [{
        id: 'protect-api',
        origins: ['https://api.example.test', 'https://accounts.example.test'],
        methods: ['GET', 'POST'],
        priority: 25,
      }],
    });

    expect(output).toContain('Request interceptor policies:');
    expect(output).toContain('protect-api');
    expect(output).toContain('https://api.example.test, https://accounts.example.test');
    expect(output).toContain('GET, POST');
    expect(output).toContain('priority 25');
  });

  it('renders an absent optional engine without inventing a host floor', () => {
    const output = formatPluginInstallationReviewForTerminal(completeReview({
      compatibility: { runtimeApiVersion: 1 },
    }));

    expect(output).toContain('- Happier: Not provided');
    expect(output).not.toContain('undefined');
  });

  it('discloses raw Voice credential receipt and copy capability without adding it to mediated-only reviews', () => {
    const rawReview: PluginInstallationReview = {
      ...completeReview(),
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
    };

    const rawOutput = formatPluginInstallationReviewForTerminal(rawReview);
    const mediatedOutput = formatPluginInstallationReviewForTerminal(completeReview());

    expect(rawOutput).toContain('Raw Voice credential access:');
    expect(rawOutput).toContain('acme.voice/conversation');
    expect(rawOutput).toContain('Plugin code in the web realm receives the selected credential directly and can use or copy it.');
    expect(rawOutput).toContain('https://voice.example.test');
    expect(mediatedOutput).not.toContain('Raw Voice credential access:');
    expect(mediatedOutput).not.toContain('can use or copy it');
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

  it('resolves client-relative plugin path locators before they cross the daemon boundary', async () => {
    type SentRequest = Parameters<typeof requestUserPluginChange>[0]['request'];
    const send = async (request: SentRequest): Promise<SentRequest | null> => {
      let sent: SentRequest | null = null;
      await requestUserPluginChange({ request, approval: 'none' }, {
        ensureDaemon: async () => undefined,
        requestChange: async (received) => {
          sent = received;
          return { kind: 'failed', code: 'unused' };
        },
      });
      return sent;
    };

    expect(await send({ kind: 'installPath', locator: '.', development: true })).toEqual({
      kind: 'installPath',
      locator: process.cwd(),
      development: true,
    });
    expect(await send({ kind: 'installPath', locator: './nested/plugin', development: false })).toEqual({
      kind: 'installPath',
      locator: join(process.cwd(), 'nested', 'plugin'),
      development: false,
    });
    expect(await send({
      kind: 'development',
      pluginId: 'acme.example',
      sourceRootPath: './nested/plugin',
    })).toEqual({
      kind: 'development',
      pluginId: 'acme.example',
      sourceRootPath: join(process.cwd(), 'nested', 'plugin'),
    });
    expect(await send({ kind: 'installPath', locator: absoluteFixturePath, development: true })).toEqual({
      kind: 'installPath',
      locator: absoluteFixturePath,
      development: true,
    });
    expect(await send({ kind: 'installNpm', packageName: '@acme/example' })).toEqual({
      kind: 'installNpm',
      packageName: '@acme/example',
    });
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
      source: { kind: 'path', locator: '/tmp/example' },
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
      'Source integrity: None',
      'Manifest, contributions, and UI artifact declarations: validated in the staged candidate',
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

  it('continues an explicit noninteractive trust decision only through the exact development source review', async () => {
    const sourceRootReview = {
      kind: 'sourceRootReviewRequired' as const,
      pendingChangeId: 'pending-1',
      review: { source: { kind: 'path' as const, locator: absoluteFixturePath } },
    };
    const packageReview = {
      kind: 'reviewRequired' as const,
      pendingChangeId: 'pending-1',
      review: completeReview({
        pluginId: 'acme.example',
        source: { kind: 'path', locator: absoluteFixturePath },
        updateChannel: { kind: 'path', locator: absoluteFixturePath, development: true },
        executableRealms: [],
        requiredHostAccess: [],
        optionalHostAccess: [],
      }),
    };
    const requestChange = vi.fn(async () => sourceRootReview);
    const decideChange = vi.fn()
      .mockResolvedValueOnce(packageReview)
      .mockResolvedValueOnce({
        kind: 'committed' as const,
        pluginId: 'acme.example',
        desiredGeneration: 'generation-1',
        appliedGeneration: 'generation-1',
        pendingSurfaces: [],
      });
    const confirm = vi.fn(async () => {
      throw new Error('An explicit noninteractive trust decision must not prompt.');
    });

    await expect(requestUserPluginChange({
      request: { kind: 'installPath', locator: absoluteFixturePath, development: true },
      approval: 'explicitNonInteractiveTrust',
    }, {
      ensureDaemon: async () => undefined,
      requestChange,
      decideChange,
      confirm,
      createInteractionId: () => 'explicit-cli-trust-1',
      nowMs: () => 1,
    })).resolves.toEqual({
      kind: 'committed',
      pluginId: 'acme.example',
      desiredGeneration: 'generation-1',
      appliedGeneration: 'generation-1',
      pendingSurfaces: [],
    });

    expect(confirm).not.toHaveBeenCalled();
    expect(decideChange).toHaveBeenNthCalledWith(1, {
      pendingChangeId: 'pending-1',
      decision: 'trustSourceRoot',
      actorEvidence: {
        kind: 'authenticatedLocalUser',
        interactionId: 'explicit-cli-trust-1',
        occurredAtMs: 1,
        provenance: {
          kind: 'explicitCliTrustFlag',
          command: 'plugins install',
          flag: '--trust',
          source: { kind: 'path', locator: absoluteFixturePath },
        },
      },
    });
    expect(decideChange).toHaveBeenNthCalledWith(2, {
      pendingChangeId: 'pending-1',
      decision: 'installAndTrust',
      actorEvidence: {
        kind: 'authenticatedLocalUser',
        interactionId: 'explicit-cli-trust-1',
        occurredAtMs: 1,
        provenance: {
          kind: 'explicitCliTrustFlag',
          command: 'plugins install',
          flag: '--trust',
          source: { kind: 'path', locator: absoluteFixturePath },
          pluginId: 'acme.example',
        },
      },
      optionalSelections: [],
    });
  });

  it('fails closed and cancels when an explicit trust review does not name the requested development source', async () => {
    const decideChange = vi.fn(async () => ({ kind: 'cancelled' as const }));
    const confirm = vi.fn(async () => true);

    await expect(requestUserPluginChange({
      request: { kind: 'installPath', locator: absoluteFixturePath, development: true },
      approval: 'explicitNonInteractiveTrust',
    }, {
      ensureDaemon: async () => undefined,
      requestChange: async () => ({
        kind: 'sourceRootReviewRequired',
        pendingChangeId: 'pending-1',
        review: { source: { kind: 'path', locator: '/tmp/a-different-plugin-source' } },
      }),
      decideChange,
      confirm,
    })).resolves.toMatchObject({
      kind: 'failed',
      code: 'plugin_explicit_trust_target_mismatch',
    });

    expect(confirm).not.toHaveBeenCalled();
    expect(decideChange).toHaveBeenCalledWith({
      pendingChangeId: 'pending-1',
      decision: 'cancel',
    });
  });

  it('fails closed when the post-source approval review changes the explicit development source', async () => {
    const decideChange = vi.fn()
      .mockResolvedValueOnce({
        kind: 'reviewRequired' as const,
        pendingChangeId: 'pending-1',
        review: completeReview({
          source: { kind: 'path', locator: '/tmp/a-different-plugin-source' },
          updateChannel: { kind: 'path', locator: '/tmp/a-different-plugin-source', development: true },
          executableRealms: [],
          requiredHostAccess: [],
          optionalHostAccess: [],
        }),
      })
      .mockResolvedValueOnce({ kind: 'cancelled' as const });
    const confirm = vi.fn(async () => true);

    await expect(requestUserPluginChange({
      request: { kind: 'installPath', locator: absoluteFixturePath, development: true },
      approval: 'explicitNonInteractiveTrust',
    }, {
      ensureDaemon: async () => undefined,
      requestChange: async () => ({
        kind: 'sourceRootReviewRequired',
        pendingChangeId: 'pending-1',
        review: { source: { kind: 'path', locator: absoluteFixturePath } },
      }),
      decideChange,
      confirm,
      createInteractionId: () => 'explicit-cli-trust-1',
      nowMs: () => 1,
    })).resolves.toMatchObject({
      kind: 'failed',
      code: 'plugin_explicit_trust_target_mismatch',
    });

    expect(confirm).not.toHaveBeenCalled();
    expect(decideChange).toHaveBeenNthCalledWith(2, {
      pendingChangeId: 'pending-1',
      decision: 'cancel',
    });
  });

  it('rejects an explicit noninteractive trust decision outside an exact local development install', async () => {
    const ensureDaemon = vi.fn(async () => undefined);
    const requestChange = vi.fn();

    await expect(requestUserPluginChange({
      request: { kind: 'installPath', locator: absoluteFixturePath, development: false },
      approval: 'explicitNonInteractiveTrust',
    }, {
      ensureDaemon,
      requestChange,
    })).resolves.toMatchObject({
      kind: 'failed',
      code: 'plugin_explicit_trust_requires_development_path',
    });

    expect(ensureDaemon).not.toHaveBeenCalled();
    expect(requestChange).not.toHaveBeenCalled();
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
