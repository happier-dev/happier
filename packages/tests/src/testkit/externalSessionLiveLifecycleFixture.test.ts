import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  ExternalAgentObservationResourceDescriptorV1Schema,
  ExternalAgentObservationResourceGroupingV1Schema,
  ingestPluginManifestV2,
  type ExternalAgentObservationSnapshotV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import {
  applyTrustedLocalPluginFixture,
  buildPreAttestedExternalSessionLiveEnv,
  countExternalSessionLiveFollowerReadEvents,
  countExternalSessionLiveLifecycleEvents,
  countExternalSessionLiveObserverLifecycleEvents,
  countExternalSessionLiveRefreshRequestEvents,
  ensureLinkedPassiveExternalSession,
  hasUnmatchedExternalSessionLiveObserverStarts,
  hasExpectedAdvancedExternalSessionLivePulseEvidence,
  readExternalSessionLiveLifecycleMarkerEvents,
  readExternalSessionLiveObservationSnapshotFromMetadata,
  reloadTrustedLocalPluginFixture,
  writeInstrumentedExternalSessionLivePlugin,
} from './externalSessionLiveLifecycleFixture';

describe('external-session live lifecycle fixture', () => {
  it('uses existing source-entrypoint and skip-build controls without changing caller overrides', () => {
    expect(buildPreAttestedExternalSessionLiveEnv({
      HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'plaintext_only',
    })).toEqual({
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
      HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
      HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: 'symlink',
      HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1',
      HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
      HAPPIER_E2E_PROVIDER_SKIP_SERVER_GENERATE: '1',
      HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'plaintext_only',
    });

    expect(buildPreAttestedExternalSessionLiveEnv({
      HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: 'copy',
    }).HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE).toBe('copy');
  });

  it('links and persists background follow through canonical machine RPC methods', async () => {
    const call = vi.fn(async (method: string) => {
      if (method.endsWith(RPC_METHODS.DAEMON_EXTERNAL_SESSION_LINK_ENSURE)) {
        return { ok: true, result: { ok: true, created: true, sessionId: 'session-live-1' } };
      }
      if (method.endsWith(RPC_METHODS.DAEMON_EXTERNAL_SESSION_BACKGROUND_FOLLOW_SET)) {
        return { ok: true, result: { ok: true, enabled: true } };
      }
      throw new Error(`Unexpected RPC method: ${method}`);
    });

    await expect(ensureLinkedPassiveExternalSession({
      machineId: 'machine-live-1',
      agentId: 'fixture-agent',
      remoteSessionId: 'remote-live-1',
      source: { kind: 'fixtureLive' },
      call,
    })).resolves.toEqual({ sessionId: 'session-live-1', created: true });

    expect(call.mock.calls.map(([method]) => method)).toEqual([
      `machine-live-1:${RPC_METHODS.DAEMON_EXTERNAL_SESSION_LINK_ENSURE}`,
      `machine-live-1:${RPC_METHODS.DAEMON_EXTERNAL_SESSION_BACKGROUND_FOLLOW_SET}`,
    ]);
  });

  it('reports observer, follower, and refresh counts from test-only markers', () => {
    expect(countExternalSessionLiveLifecycleEvents({
      markerEvents: [
        { kind: 'observer_started', generation: 'one' },
        { kind: 'follower_read', generation: 'one' },
        { kind: 'refresh_requested', generation: 'one' },
        { kind: 'observer_disposed', generation: 'one' },
        { kind: 'observer_started', generation: 'two' },
      ],
    })).toEqual({
      observersStarted: 2,
      observersDisposed: 1,
      followerReads: 1,
      refreshRequests: 1,
    });
  });

  it('distinguishes a replacement daemon observer from a late old-daemon marker', () => {
    const originalDaemonPid = 101;
    const replacementDaemonPid = 202;
    const beforeReplacement = [{
      kind: 'observer_started',
      generation: 'one',
      daemonPid: originalDaemonPid,
      resourceKey: 'fixture-live-resource',
      requestedLinkKeys: ['fixture-live-link:remote-one'],
      observerInstanceId: '101:1',
    }] as const;
    const afterLateOriginalDaemonMarker = [
      ...beforeReplacement,
      {
        kind: 'observer_started',
        generation: 'one',
        daemonPid: originalDaemonPid,
        resourceKey: 'fixture-live-resource',
        requestedLinkKeys: ['fixture-live-link:remote-two'],
        observerInstanceId: '101:2',
      },
    ] as const;

    expect(countExternalSessionLiveLifecycleEvents({
      markerEvents: afterLateOriginalDaemonMarker,
    }).observersStarted).not.toBe(countExternalSessionLiveLifecycleEvents({
      markerEvents: beforeReplacement,
    }).observersStarted);
    expect(countExternalSessionLiveObserverLifecycleEvents({
      markerEvents: afterLateOriginalDaemonMarker,
      daemonPid: replacementDaemonPid,
      resourceKey: 'fixture-live-resource',
    }).observersStarted).toBe(0);
  });

  it('pairs replacement cleanup by observer instance despite an unpaired old-daemon start', () => {
    const markerEvents = [
      {
        kind: 'observer_started',
        generation: 'current',
        daemonPid: 101,
        resourceKey: 'fixture-live-resource',
        requestedLinkKeys: ['fixture-live-link:durable'],
        observerInstanceId: '101:1',
      },
      {
        kind: 'observer_started',
        generation: 'current',
        daemonPid: 202,
        resourceKey: 'fixture-live-resource',
        requestedLinkKeys: ['fixture-live-link:durable'],
        observerInstanceId: '202:1',
      },
      {
        kind: 'observer_disposed',
        generation: 'current',
        daemonPid: 202,
        resourceKey: 'fixture-live-resource',
        requestedLinkKeys: ['fixture-live-link:durable'],
        observerInstanceId: '202:1',
      },
    ] as const;
    const aggregateCounts = countExternalSessionLiveLifecycleEvents({
      markerEvents,
    });

    expect(
      aggregateCounts.observersDisposed >= aggregateCounts.observersStarted,
    ).toBe(false);
    expect(countExternalSessionLiveObserverLifecycleEvents({
      markerEvents,
      daemonPid: 202,
      resourceKey: 'fixture-live-resource',
      observerInstanceId: '202:1',
    })).toEqual({
      observersStarted: 1,
      observersDisposed: 1,
    });
    expect(hasUnmatchedExternalSessionLiveObserverStarts({
      markerEvents,
      daemonPid: 202,
      resourceKey: 'fixture-live-resource',
      requestedLinkKey: 'fixture-live-link:durable',
    })).toBe(false);
    expect(hasUnmatchedExternalSessionLiveObserverStarts({
      markerEvents: [
        ...markerEvents,
        {
          kind: 'observer_started',
          generation: 'current',
          daemonPid: 202,
          resourceKey: 'fixture-live-resource',
          requestedLinkKeys: ['fixture-live-link:durable'],
          observerInstanceId: '202:2',
        },
      ],
      daemonPid: 202,
      resourceKey: 'fixture-live-resource',
      requestedLinkKey: 'fixture-live-link:durable',
    })).toBe(true);
    expect(hasUnmatchedExternalSessionLiveObserverStarts({
      markerEvents,
      daemonPid: 101,
      resourceKey: 'fixture-live-resource',
      requestedLinkKey: 'fixture-live-link:durable',
    })).toBe(true);
  });

  it('filters follower reads and refresh requests by daemon and exact link identity', () => {
    const markerEvents = [
      { kind: 'follower_read', generation: 'legacy' },
      {
        kind: 'follower_read',
        generation: 'current',
        daemonPid: 101,
        remoteSessionId: 'durable',
      },
      {
        kind: 'follower_read',
        generation: 'current',
        daemonPid: 202,
        remoteSessionId: 'durable',
      },
      {
        kind: 'follower_read',
        generation: 'current',
        daemonPid: 202,
        remoteSessionId: 'ephemeral',
      },
      { kind: 'refresh_requested', generation: 'legacy' },
      {
        kind: 'refresh_requested',
        generation: 'current',
        daemonPid: 101,
        linkKey: 'fixture-live-link:durable',
      },
      {
        kind: 'refresh_requested',
        generation: 'current',
        daemonPid: 202,
        linkKey: 'fixture-live-link:durable',
      },
      {
        kind: 'refresh_requested',
        generation: 'current',
        daemonPid: 202,
        linkKey: 'fixture-live-link:ephemeral',
      },
    ] as const;

    expect(countExternalSessionLiveLifecycleEvents({
      markerEvents,
    })).toEqual(expect.objectContaining({
      followerReads: 4,
      refreshRequests: 4,
    }));
    expect(countExternalSessionLiveFollowerReadEvents({
      markerEvents,
      daemonPid: 202,
      remoteSessionId: 'durable',
    })).toBe(1);
    expect(countExternalSessionLiveRefreshRequestEvents({
      markerEvents,
      daemonPid: 202,
      linkKey: 'fixture-live-link:durable',
    })).toBe(1);
  });

  it('reads both legacy and PID-correlated observer marker records', async () => {
    const markerRoot = await mkdtemp(
      join(tmpdir(), 'happier-external-live-markers-'),
    );
    const markerPath = join(markerRoot, 'lifecycle.jsonl');
    try {
      await writeFile(markerPath, [
        JSON.stringify({
          kind: 'observer_started',
          generation: 'legacy',
        }),
        JSON.stringify({
          kind: 'observer_disposed',
          generation: 'current',
          daemonPid: 202,
          resourceKey: 'fixture-live-resource',
          requestedLinkKeys: ['fixture-live-link:remote-one'],
          observerInstanceId: '202:1',
        }),
        JSON.stringify({
          kind: 'follower_read',
          generation: 'legacy',
        }),
        JSON.stringify({
          kind: 'follower_read',
          generation: 'current',
          daemonPid: 202,
          remoteSessionId: 'remote-one',
        }),
        JSON.stringify({
          kind: 'refresh_requested',
          generation: 'legacy',
        }),
        JSON.stringify({
          kind: 'refresh_requested',
          generation: 'current',
          daemonPid: 202,
          linkKey: 'fixture-live-link:remote-one',
        }),
        '',
      ].join('\n'), 'utf8');

      await expect(
        readExternalSessionLiveLifecycleMarkerEvents(markerPath),
      ).resolves.toEqual([
        {
          kind: 'observer_started',
          generation: 'legacy',
        },
        {
          kind: 'observer_disposed',
          generation: 'current',
          daemonPid: 202,
          resourceKey: 'fixture-live-resource',
          requestedLinkKeys: ['fixture-live-link:remote-one'],
          observerInstanceId: '202:1',
        },
        {
          kind: 'follower_read',
          generation: 'legacy',
        },
        {
          kind: 'follower_read',
          generation: 'current',
          daemonPid: 202,
          remoteSessionId: 'remote-one',
        },
        {
          kind: 'refresh_requested',
          generation: 'legacy',
        },
        {
          kind: 'refresh_requested',
          generation: 'current',
          daemonPid: 202,
          linkKey: 'fixture-live-link:remote-one',
        },
      ]);
    } finally {
      await rm(markerRoot, { recursive: true, force: true });
    }
  });

  it('rejects generation pulse markers when the exact decrypted observation did not advance', () => {
    const before = {
      v: 1,
      qualifiedLinkIdentity: {
        v: 1,
        agent: {
          pluginId: 'acme.external-session-live',
          localId: 'fixture-agent',
        },
        source: {
          kind: 'fixtureLive',
          contractVersion: 1,
        },
      },
      linkGeneration: 'link-generation-1',
      status: 'working',
      observedAtMs: 1_000,
      expiresAtMs: 31_000,
    } satisfies ExternalAgentObservationSnapshotV1;

    const advanced = {
      ...before,
      observedAtMs: 2_000,
      expiresAtMs: 32_000,
    } satisfies ExternalAgentObservationSnapshotV1;
    const hasPulseEvidence = (
      after: ExternalAgentObservationSnapshotV1 | null,
    ): boolean => hasExpectedAdvancedExternalSessionLivePulseEvidence({
      markerEvents: [
        { kind: 'observer_started', generation: 'generation-two' },
        { kind: 'follower_read', generation: 'generation-two' },
        { kind: 'refresh_requested', generation: 'generation-two' },
        {
          kind: 'observation_emitted',
          generation: 'generation-two',
          observedAtMs: 2_000,
          status: 'working',
        },
      ],
      generation: 'generation-two',
      minimumCounts: {
        observersStarted: 1,
        followerReads: 1,
        refreshRequests: 1,
      },
      expectedIdentity: {
        pluginId: 'acme.external-session-live',
        agentId: 'fixture-agent',
        sourceKind: 'fixtureLive',
      },
      expectedStatus: 'working',
      before,
      after,
    });

    expect(hasPulseEvidence(before)).toBe(false);
    expect(hasPulseEvidence(advanced)).toBe(true);
    expect(hasPulseEvidence({
      ...advanced,
      linkGeneration: 'link-generation-2',
    })).toBe(false);
    expect(hasPulseEvidence({
      ...advanced,
      qualifiedLinkIdentity: {
        ...advanced.qualifiedLinkIdentity,
        agent: {
          ...advanced.qualifiedLinkIdentity.agent,
          pluginId: 'acme.other-plugin',
        },
      },
    })).toBe(false);
    expect(hasPulseEvidence({
      ...advanced,
      status: 'waiting',
    })).toBe(false);
    expect(hasExpectedAdvancedExternalSessionLivePulseEvidence({
      markerEvents: [
        { kind: 'observer_started', generation: 'generation-two' },
        { kind: 'follower_read', generation: 'generation-two' },
        { kind: 'refresh_requested', generation: 'generation-two' },
        {
          kind: 'observation_emitted',
          generation: 'generation-two',
          observedAtMs: 1_999,
          status: 'working',
        },
      ],
      generation: 'generation-two',
      minimumCounts: {
        observersStarted: 1,
        followerReads: 1,
        refreshRequests: 1,
      },
      expectedIdentity: {
        pluginId: 'acme.external-session-live',
        agentId: 'fixture-agent',
        sourceKind: 'fixtureLive',
      },
      expectedStatus: 'working',
      before,
      after: advanced,
    })).toBe(false);
  });

  it('does not treat a generic session update as an External Agent observation publication', () => {
    expect(readExternalSessionLiveObservationSnapshotFromMetadata({
      t: 'update-session',
      id: 'session-live-1',
      metadata: {
        version: 2,
        value: 'opaque-ciphertext',
      },
    })).toBeNull();
  });

  it('installs with explicit local-user review and reloads through daemon plugin change routes', async () => {
    const postJson = vi.fn(async (request: Readonly<{
      path: string;
      body: Readonly<Record<string, unknown>>;
    }>) => {
      if (request.path === '/plugins/change/request' && postJson.mock.calls.length === 1) {
        return {
          status: 200,
          data: {
            kind: 'reviewRequired',
            pendingChangeId: 'pending-live-plugin',
          },
        };
      }
      return {
        status: 200,
        data: {
          kind: 'committed',
          pluginId: 'acme.external-session-live',
          generation: 2,
        },
      };
    });

    await expect(applyTrustedLocalPluginFixture({
      daemonPort: 32123,
      controlToken: 'control-live',
      pluginRoot: '/tmp/external-session-live-plugin',
      pluginId: 'acme.external-session-live',
      interactionId: 'install-live-plugin',
      postJson,
    })).resolves.toMatchObject({ kind: 'committed' });

    await expect(reloadTrustedLocalPluginFixture({
      daemonPort: 32123,
      controlToken: 'control-live',
      pluginRoot: '/tmp/external-session-live-plugin',
      pluginId: 'acme.external-session-live',
      changedPaths: ['daemon.mjs'],
      postJson,
    })).resolves.toMatchObject({ kind: 'committed' });

    expect(postJson.mock.calls.map(([request]) => ({
      path: request.path,
      body: request.body,
    }))).toEqual([
      {
        path: '/plugins/change/request',
        body: {
          kind: 'installPath',
          locator: '/tmp/external-session-live-plugin',
          development: true,
        },
      },
      {
        path: '/plugins/change/decide',
        body: {
          pendingChangeId: 'pending-live-plugin',
          decision: 'installAndTrust',
          actorEvidence: {
            kind: 'authenticatedLocalUser',
            interactionId: 'install-live-plugin',
            occurredAtMs: expect.any(Number),
          },
          optionalSelections: [],
        },
      },
      {
        path: '/plugins/change/request',
        body: {
          kind: 'development',
          pluginId: 'acme.external-session-live',
          sourceRootPath: '/tmp/external-session-live-plugin',
          changedPaths: ['daemon.mjs'],
        },
      },
    ]);
  });

  it('preserves daemon decision diagnostics when reviewed installation fails', async () => {
    const postJson = vi.fn(async (request: Readonly<{
      path: string;
    }>) => request.path === '/plugins/change/request'
      ? {
          status: 200,
          data: {
            kind: 'reviewRequired',
            pendingChangeId: 'pending-live-plugin',
          },
        }
      : {
          status: 200,
          data: {
            kind: 'failed',
            code: 'plugin_install_failed',
            message: 'candidate activation failed',
          },
        });

    await expect(applyTrustedLocalPluginFixture({
      daemonPort: 32123,
      controlToken: 'control-live',
      pluginRoot: '/tmp/external-session-live-plugin',
      pluginId: 'acme.external-session-live',
      interactionId: 'install-live-plugin',
      postJson,
    })).rejects.toThrow(
      'Local plugin installation decision did not commit '
      + '(status=200, kind=failed, code=plugin_install_failed, '
      + 'message=candidate activation failed)',
    );
  });

  it('writes one concrete observation/follow fixture whose only instrumentation is a test marker file', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-external-live-plugin-'));
    try {
      await writeInstrumentedExternalSessionLivePlugin({
        pluginRoot,
        pluginId: 'acme.external-session-live',
        agentId: 'fixture-agent',
        generation: 'generation-one',
        observationStatus: 'waiting',
        markerPath: join(pluginRoot, 'lifecycle.jsonl'),
      });

      const manifest = JSON.parse(
        await readFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), 'utf8'),
      ) as Readonly<Record<string, unknown>>;
      const packageJson = JSON.parse(
        await readFile(join(pluginRoot, 'package.json'), 'utf8'),
      ) as Readonly<Record<string, unknown>>;
      const pnpmLock = await readFile(join(pluginRoot, 'pnpm-lock.yaml'), 'utf8');
      const daemonModule = await readFile(join(pluginRoot, 'daemon.mjs'), 'utf8');
      const ingested = ingestPluginManifestV2(manifest);

      expect(manifest).toMatchObject({
        schemaVersion: 2,
        id: 'acme.external-session-live',
        contributes: {
          agents: [{ id: 'fixture-agent' }],
          actions: [{ id: 'pulse' }],
        },
      });
      expect(ingested).toMatchObject({ ok: true });
      expect(packageJson).toMatchObject({
        name: 'acme.external-session-live',
        private: true,
        type: 'module',
      });
      expect(pnpmLock).toContain('lockfileVersion:');
      expect(daemonModule).toContain('registerExternalSessionObservation("fixture-agent"');
      expect(daemonModule).toContain('registerExternalSessions("fixture-agent"');
      expect(daemonModule).toContain("api.actions.register('pulse'");
      expect(daemonModule).toContain('"generation-one"');
      expect(daemonModule).toContain('"waiting"');
      expect(daemonModule).toContain('"late_emission_attempted"');
      expect(daemonModule).toContain('"reconcile_requested"');
      expect(daemonModule).not.toContain('api.onDispose');
      expect(daemonModule).toContain('return () => {');
    } finally {
      await rm(pluginRoot, { recursive: true, force: true });
    }
  });

  it('publishes generation-specific observations and can attempt one fenced retired emission', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-external-live-plugin-'));
    try {
      await writeInstrumentedExternalSessionLivePlugin({
        pluginRoot,
        pluginId: 'acme.external-session-live',
        agentId: 'fixture-agent',
        generation: 'generation-one',
        observationStatus: 'waiting',
        markerPath: join(pluginRoot, 'lifecycle.jsonl'),
      });

      type ObservationBatch = Readonly<{
        items: readonly Readonly<{
          linkKey: string;
          facts: readonly Readonly<{
            observedAtMs: number;
            value: string;
          }>[];
        }>[];
      }>;
      type ObservationContribution = Readonly<{
        describeResource(request: Readonly<{
          remoteSessionId: string;
        }>): Readonly<{
          resourceKey: string;
          linkKey: string;
        }>;
        reconcileResource(request: Readonly<{
          purpose: 'resource_descriptors';
          links: readonly Readonly<{
            linkedSource: Readonly<{ remoteSessionId: string }>;
          }>[];
        }>): Promise<Readonly<{
          outcomes: readonly Readonly<{ descriptor: unknown }>[];
        }>>;
        observeResource(request: Readonly<{
          resourceKey: string;
          emit(batch: ObservationBatch): void;
          requestTranscriptRefresh(linkKey: string): void;
        }>): Readonly<{ dispose(): void }>;
      }>;
      type PulseAction = (
        input: Readonly<{
          emit?: boolean;
          refresh?: boolean;
          emitRetired?: boolean;
        }>,
      ) => Promise<unknown>;
      type ExternalSessionsContribution = Readonly<{
        readAfterTranscript(request: Readonly<{
          cursor: string;
          remoteSessionId: string;
        }>): unknown | Promise<unknown>;
      }>;
      type GeneratedPluginModule = Readonly<{
        activate(api: Readonly<{
          agents: Readonly<{
            registerExternalSessions(
              agentId: string,
              contribution: ExternalSessionsContribution,
            ): void;
            registerExternalSessionObservation(
              agentId: string,
              contribution: ObservationContribution,
            ): void;
          }>;
          actions: Readonly<{
            register(actionId: string, action: PulseAction): void;
          }>;
        }>): () => void;
      }>;

      const generatedModule = await import(
        `${pathToFileURL(join(pluginRoot, 'daemon.mjs')).href}?fixture=${Date.now()}`
      ) as GeneratedPluginModule;
      let externalSessionsContribution:
        ExternalSessionsContribution | null = null;
      let observationContribution: ObservationContribution | null = null;
      let pulseAction: PulseAction | null = null;
      const cleanup = generatedModule.activate({
        agents: {
          registerExternalSessions(agentId, contribution) {
            expect(agentId).toBe('fixture-agent');
            externalSessionsContribution = contribution;
          },
          registerExternalSessionObservation(agentId, contribution) {
            expect(agentId).toBe('fixture-agent');
            observationContribution = contribution;
          },
        },
        actions: {
          register(actionId, action) {
            expect(actionId).toBe('pulse');
            pulseAction = action;
          },
        },
      });
      const registeredObservation =
        observationContribution as ObservationContribution | null;
      const registeredExternalSessions =
        externalSessionsContribution as ExternalSessionsContribution | null;
      const registeredPulseAction = pulseAction as PulseAction | null;
      if (
        !registeredExternalSessions
        || !registeredObservation
        || !registeredPulseAction
      ) {
        throw new Error('Generated live fixture did not register its observation and pulse owners');
      }

      const emitted: ObservationBatch[] = [];
      const refreshed: string[] = [];
      const describeRequest = {
        remoteSessionId: 'fixture-live-remote',
      };
      const grouping = ExternalAgentObservationResourceGroupingV1Schema.parse(
        registeredObservation.describeResource(describeRequest),
      );
      const reconciledDescriptors =
        await registeredObservation.reconcileResource({
          purpose: 'resource_descriptors',
          links: [{ linkedSource: describeRequest }],
        });
      expect(
        ExternalAgentObservationResourceDescriptorV1Schema.parse(
          reconciledDescriptors.outcomes[0]?.descriptor,
        ),
      ).toEqual({
        ...grouping,
        changeObservation: 'observe_resource',
      });

      vi.useFakeTimers();
      try {
        vi.setSystemTime(1_000);
        const observer = registeredObservation.observeResource({
          resourceKey: grouping.resourceKey,
          emit: (batch) => emitted.push(batch),
          requestTranscriptRefresh: (linkKey) => refreshed.push(linkKey),
        });
        expect(emitted).toHaveLength(1);
        expect(emitted[0]?.items[0]).toMatchObject({
          linkKey: grouping.linkKey,
          facts: [{
            observedAtMs: 1_000,
            value: 'waiting',
          }],
        });
        await registeredExternalSessions.readAfterTranscript({
          cursor: 'fixture-live-tail',
          remoteSessionId: 'fixture-live-remote',
        });

        vi.setSystemTime(2_000);
        await registeredPulseAction({ emit: true, refresh: true });
        expect(emitted).toHaveLength(2);
        expect(emitted[1]?.items[0]).toMatchObject({
          linkKey: grouping.linkKey,
          facts: [{
            observedAtMs: 2_000,
            value: 'waiting',
          }],
        });
        expect(refreshed).toEqual([grouping.linkKey]);

        observer.dispose();
        cleanup();

        await writeInstrumentedExternalSessionLivePlugin({
          pluginRoot,
          pluginId: 'acme.external-session-live',
          agentId: 'fixture-agent',
          generation: 'generation-two',
          observationStatus: 'working',
          markerPath: join(pluginRoot, 'lifecycle.jsonl'),
        });
        const replacementModule = await import(
          `${pathToFileURL(join(pluginRoot, 'daemon.mjs')).href}?fixture=${Date.now()}-replacement`
        ) as GeneratedPluginModule;
        let replacementObservation: ObservationContribution | null = null;
        let replacementPulse: PulseAction | null = null;
        const replacementCleanup = replacementModule.activate({
          agents: {
            registerExternalSessions() {},
            registerExternalSessionObservation(_agentId, contribution) {
              replacementObservation = contribution;
            },
          },
          actions: {
            register(_actionId, action) {
              replacementPulse = action;
            },
          },
        });
        const registeredReplacementObservation =
          replacementObservation as ObservationContribution | null;
        const registeredReplacementPulse = replacementPulse as PulseAction | null;
        if (!registeredReplacementObservation || !registeredReplacementPulse) {
          throw new Error('Replacement live fixture did not register its observation and pulse owners');
        }
        const replacementDescriptor = (
          registeredReplacementObservation as ObservationContribution & Readonly<{
            describeResource(request: typeof describeRequest): Readonly<{ linkKey: string }>;
          }>
        ).describeResource(describeRequest);
        const replacementEmitted: ObservationBatch[] = [];

        vi.setSystemTime(3_000);
        const replacementObserver = registeredReplacementObservation.observeResource({
          resourceKey: 'fixture-live-resource',
          emit: (batch) => replacementEmitted.push(batch),
          requestTranscriptRefresh() {},
        });
        expect(replacementEmitted[0]?.items[0]).toMatchObject({
          linkKey: replacementDescriptor.linkKey,
          facts: [{
            observedAtMs: 3_000,
            value: 'working',
          }],
        });

        vi.setSystemTime(4_000);
        await registeredReplacementPulse({
          emit: true,
          refresh: false,
          emitRetired: true,
        });
        expect(replacementEmitted[1]?.items[0]).toMatchObject({
          facts: [{
            observedAtMs: 4_000,
            value: 'working',
          }],
        });
        expect(emitted[2]?.items[0]).toMatchObject({
          facts: [{
            observedAtMs: 64_000,
            value: 'waiting',
          }],
        });
        const lifecycleMarkers =
          await readExternalSessionLiveLifecycleMarkerEvents(
            join(pluginRoot, 'lifecycle.jsonl'),
          );
        expect(lifecycleMarkers).toEqual(expect.arrayContaining([
          {
            kind: 'follower_read',
            generation: 'generation-one',
            daemonPid: process.pid,
            remoteSessionId: 'fixture-live-remote',
          },
          {
            kind: 'refresh_requested',
            generation: 'generation-one',
            daemonPid: process.pid,
            linkKey: grouping.linkKey,
          },
          {
            kind: 'observation_emitted',
            generation: 'generation-two',
            observedAtMs: 4_000,
            status: 'working',
          },
          {
            kind: 'late_emission_attempted',
            generation: 'generation-one',
            observedAtMs: 64_000,
            status: 'waiting',
          },
        ]));
        const originalObserverStarted = lifecycleMarkers.find(
          (event) => event.kind === 'observer_started'
            && event.generation === 'generation-one',
        );
        const originalObserverDisposed = lifecycleMarkers.find(
          (event) => event.kind === 'observer_disposed'
            && event.generation === 'generation-one',
        );
        expect(originalObserverStarted).toEqual(expect.objectContaining({
          daemonPid: process.pid,
          resourceKey: grouping.resourceKey,
          requestedLinkKeys: [grouping.linkKey],
          observerInstanceId: expect.any(String),
        }));
        expect(originalObserverDisposed).toEqual({
          ...originalObserverStarted,
          kind: 'observer_disposed',
        });

        replacementObserver.dispose();
        replacementCleanup();
      } finally {
        vi.useRealTimers();
      }
    } finally {
      await rm(pluginRoot, { recursive: true, force: true });
    }
  });
});
