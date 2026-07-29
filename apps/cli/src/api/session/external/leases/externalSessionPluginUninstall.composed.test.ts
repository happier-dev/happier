import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExternalAgentObservationSnapshotV1 } from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDaemonPluginChangeService } from '@/plugins/daemon/changeService';
import { createDaemonPathPluginChangePreparer } from '@/plugins/daemon/pathChangePreparer';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createDaemonPluginRegistryRuntimeLifecycle } from '@/plugins/runtime/reload/registryRuntimeLifecycle';

import { createExternalSessionFollowLeaseManager } from './createExternalSessionFollowLeaseManager';
import { createExternalSessionObservationDaemonProjection } from './createExternalSessionObservationDaemonProjection';
import {
    resolveExternalSessionObservationLinkInput,
    type ExternalSessionObservationLinkInput,
    type ExternalSessionObservationLinkedSession,
} from './resolveExternalSessionObservationLinkInput';
import { startExternalSessionPassiveObservation } from './startExternalSessionPassiveObservation';

const PLUGIN_ID = 'acme.external-session-uninstall';
const AGENT_ID = 'external-session-uninstall-agent';
const SESSION_ID = 'linked-session';
const SOURCE = Object.freeze({
    kind: 'syntheticUninstallSource',
    scope: 'fixture',
});
const FIXTURE_STATE_KEY =
    '__happierExternalSessionPluginUninstallFixtureState';

type FixtureState = {
    observerAcquisitions: number;
    observerDisposals: number;
    followAcquisitions: number;
    followDisposals: number;
    resolveLinkedIdentityCalls: number;
    reconcilePurposes: string[];
    pageTranscriptCalls: number;
    readAfterTranscriptCalls: number;
    lastEmit: ((batch: unknown) => void) | null;
};

const roots: string[] = [];
let controllerOwnsRegistry = false;

afterEach(async () => {
    if (controllerOwnsRegistry) {
        controllerOwnsRegistry = false;
        await pluginReloadController.shutdown({ timeoutMs: 5_000 });
    }
    delete (globalThis as unknown as Record<string, unknown>)[FIXTURE_STATE_KEY];
    await Promise.all(
        roots.splice(0).map(async (root) =>
            await rm(root, { recursive: true, force: true })),
    );
});

async function materializeObservationPlugin(pluginRoot: string): Promise<void> {
    await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
    await writeFile(
        join(pluginRoot, '.happier-plugin', 'plugin.json'),
        JSON.stringify({
            schemaVersion: 2,
            id: PLUGIN_ID,
            version: '1.0.0',
            displayName: 'External Session uninstall fixture',
            engines: { happier: '^0.2.0' },
            runtime: { apiVersion: 1 },
            entrypoints: { daemon: './daemon.mjs' },
            hostAccess: { required: [], optional: [] },
            contributes: {
                agents: [{
                    id: AGENT_ID,
                    title: 'External Session uninstall Agent',
                    capabilities: { surfaces: ['externalSessions'] },
                    surfaces: {
                        externalSession: {
                            sources: [{
                                sourceKind: SOURCE.kind,
                                schema: {
                                    passthrough: false,
                                    fields: [
                                        {
                                            name: 'kind',
                                            kind: 'literal',
                                            value: SOURCE.kind,
                                        },
                                        {
                                            name: 'scope',
                                            kind: 'literal',
                                            value: SOURCE.scope,
                                        },
                                    ],
                                },
                                key: {
                                    segments: [
                                        {
                                            kind: 'literal',
                                            value: SOURCE.kind,
                                        },
                                        {
                                            kind: 'field',
                                            field: 'scope',
                                        },
                                    ],
                                },
                                instances: [{
                                    kind: 'default',
                                    constants: { scope: SOURCE.scope },
                                }],
                            }],
                        },
                    },
                }],
            },
        }),
        'utf8',
    );
    await writeFile(
        join(pluginRoot, 'daemon.mjs'),
        `
const state = globalThis[${JSON.stringify(FIXTURE_STATE_KEY)}];

export function activate(api) {
  api.agents.registerExternalSessions(${JSON.stringify(AGENT_ID)}, {
    async resolveSource(request) {
      return { ok: true, value: { source: request.source } };
    },
    async listCandidates() {
      return { ok: true, value: { candidates: [], nextCursor: null } };
    },
    async resolveLinkIdentity(request) {
      return {
        ok: true,
        value: {
          source: request.source,
          remoteSessionId: request.remoteSessionId,
          linkData: request.linkData ?? {},
        },
      };
    },
    async resolveLinkedIdentity(request) {
      state.resolveLinkedIdentityCalls += 1;
      return {
        ok: true,
        value: {
          source: request.source,
          remoteSessionId: request.remoteSessionId,
          linkData: request.linkData,
        },
      };
    },
    async pageTranscript() {
      state.pageTranscriptCalls += 1;
      return {
        ok: true,
        value: {
          items: [],
          nextCursor: null,
          tailCursor: null,
          hasMore: false,
        },
      };
    },
    async readAfterTranscript() {
      state.readAfterTranscriptCalls += 1;
      return { ok: true, value: { outcome: 'already_current' } };
    },
  });
  api.agents.registerExternalSessionObservation(${JSON.stringify(AGENT_ID)}, {
    describeResource(request) {
      return {
        resourceKey: 'fixture-resource',
        linkKey: 'fixture-link',
      };
    },
    observeResource(request) {
      state.observerAcquisitions += 1;
      state.lastEmit = request.emit;
      request.emit({
        items: [{
          linkKey: 'fixture-link',
          facts: [{
            kind: 'turn_phase',
            evidenceClass: 'agent_native',
            value: 'working',
            observedAtMs: Date.now() + state.observerAcquisitions,
            expiresAtMs: Date.now() + 60_000,
          }],
        }],
      });
      let disposed = false;
      return {
        dispose() {
          if (disposed) return;
          disposed = true;
          state.observerDisposals += 1;
        },
      };
    },
    async reconcileResource(request) {
      state.reconcilePurposes.push(request.purpose);
      return request.purpose === 'resource_descriptors'
        ? {
            purpose: request.purpose,
            outcomes: request.links.map(({ linkKey }) => ({
              kind: 'described',
              descriptor: {
                resourceKey: request.resourceKey,
                linkKey,
                changeObservation: 'observe_resource',
              },
            })),
          }
        : {
            purpose: request.purpose,
            outcomes: request.links.map(({ linkKey }) => ({
              linkKey,
              facts: [],
            })),
          };
    },
  });
}
`,
        'utf8',
    );
}

const linkedSession = Object.freeze({
    agentId: AGENT_ID,
    remoteSessionId: 'native-session',
    linkGeneration: '1000',
    source: SOURCE,
    metadata: {
        externalSessionV1: {
            v: 1,
            agentId: AGENT_ID,
            machineId: 'machine-1',
            remoteSessionId: 'native-session',
            source: SOURCE,
            qualifiedIdentity: {
                v: 1,
                agent: {
                    pluginId: PLUGIN_ID,
                    localId: AGENT_ID,
                },
                source: {
                    kind: SOURCE.kind,
                    contractVersion: 1,
                },
            },
            linkData: {},
            linkedAtMs: 1_000,
            followPolicyV1: {
                v: 1,
                policy: 'background_follow',
                updatedAtMs: 1_100,
            },
        },
    },
}) satisfies ExternalSessionObservationLinkedSession;

describe('installed path plugin External Session uninstall lifecycle', () => {
    it('retires observation and follow work, publishes unknown once, preserves the link, and reacquires after reinstall', async () => {
        const happyHomeDir = await mkdtemp(
            join(tmpdir(), 'happier-external-uninstall-home-'),
        );
        const pluginRoot = await mkdtemp(
            join(tmpdir(), 'happier-external-uninstall-plugin-'),
        );
        roots.push(happyHomeDir, pluginRoot);
        await materializeObservationPlugin(pluginRoot);

        const fixtureState: FixtureState = {
            observerAcquisitions: 0,
            observerDisposals: 0,
            followAcquisitions: 0,
            followDisposals: 0,
            resolveLinkedIdentityCalls: 0,
            reconcilePurposes: [],
            pageTranscriptCalls: 0,
            readAfterTranscriptCalls: 0,
            lastEmit: null,
        };
        (globalThis as unknown as Record<string, unknown>)[FIXTURE_STATE_KEY] =
            fixtureState;

        const runtimeLifecycle = createDaemonPluginRegistryRuntimeLifecycle({
            happyHomeDir,
            reloadController: pluginReloadController,
        });
        const changeService = createDaemonPluginChangeService({
            prepare: createDaemonPathPluginChangePreparer({
                happyHomeDir,
                runtimeLifecycle,
            }),
            createPendingChangeId: () => 'external-uninstall-install-review',
        });
        const install = async () => {
            const request = await changeService.requestPluginChange({
                kind: 'installPath',
                locator: pluginRoot,
                development: false,
            });
            if (request.kind !== 'reviewRequired') {
                throw new Error(`Expected review, received ${request.kind}`);
            }
            await expect(changeService.decidePluginChange({
                pendingChangeId: request.pendingChangeId,
                decision: 'installAndTrust',
                actorEvidence: {
                    kind: 'authenticatedLocalUser',
                    interactionId: `install-${Date.now()}`,
                    occurredAtMs: Date.now(),
                },
            })).resolves.toMatchObject({
                kind: 'committed',
                pluginId: PLUGIN_ID,
            });
            controllerOwnsRegistry = true;
        };
        await install();

        const publications: ExternalAgentObservationSnapshotV1[] = [];
        const projection = createExternalSessionObservationDaemonProjection({
            publishField: vi.fn(async ({ value }) => {
                publications.push(value);
            }),
        });
        const followLeaseManager =
            createExternalSessionFollowLeaseManager();
        let latestObservation: ExternalSessionObservationLinkInput | null = null;
        const lifecycle = startExternalSessionPassiveObservation({
            machineId: 'machine-1',
            projection,
            listCurrentLinks: async ({ signal }) => {
                latestObservation =
                    await resolveExternalSessionObservationLinkInput({
                        linked: linkedSession,
                        sessionId: SESSION_ID,
                        signal,
                        accountProjection: { connectedServicesV2: [] },
                    });
                return [{
                    sessionId: SESSION_ID,
                    observation: latestObservation,
                }];
            },
            restoreFollowPolicy: async (sessionId) => {
                if (!latestObservation) {
                    throw new Error('Current plugin observation is unavailable');
                }
                await followLeaseManager.setBackgroundFollowEnabled({
                    sessionId,
                    enabled: true,
                    resource: {
                        linkGeneration:
                            latestObservation.link.linkGeneration,
                        pluginGeneration:
                            latestObservation.resource.pluginGeneration,
                    },
                    acquireFollowLease: async () => {
                        fixtureState.followAcquisitions += 1;
                        let released = false;
                        return {
                            async release() {
                                if (released) return;
                                released = true;
                                fixtureState.followDisposals += 1;
                            },
                        };
                    },
                });
                await followLeaseManager.resumeSession({
                    sessionId,
                    reason: 'daemon_disconnected',
                });
            },
            releaseFollowSession: async (sessionId) => {
                await followLeaseManager.releaseSession({ sessionId });
            },
            startPaused: true,
            jitterDelay: async () => {},
            isRestoreEnabled: () => true,
            subscribeRuntimeReload: (listener) =>
                pluginReloadController.subscribe(() => listener()),
        });

        try {
            await lifecycle.resume();
            await projection.flush();
            expect(latestObservation).not.toBeNull();
            await vi.waitFor(() => {
                expect(fixtureState.reconcilePurposes).toContain(
                    'resource_descriptors',
                );
                expect(fixtureState.observerAcquisitions).toBe(1);
                expect(publications.map((snapshot) => snapshot.status))
                    .toEqual(['working']);
            });
            expect(fixtureState).toMatchObject({
                observerAcquisitions: 1,
                observerDisposals: 0,
                followAcquisitions: 1,
                followDisposals: 0,
                pageTranscriptCalls: 0,
                readAfterTranscriptCalls: 0,
            });
            const retiredEmit = fixtureState.lastEmit;

            await expect(changeService.requestPluginChange({
                kind: 'uninstall',
                pluginId: PLUGIN_ID,
            })).resolves.toMatchObject({
                kind: 'committed',
                pluginId: PLUGIN_ID,
                desiredGeneration: null,
                appliedGeneration: null,
            });

            await vi.waitFor(() => {
                expect(fixtureState.observerDisposals).toBe(1);
                expect(fixtureState.followDisposals).toBe(1);
                expect(publications.map((snapshot) => snapshot.status))
                    .toEqual(['working', 'unknown']);
            });
            expect(latestObservation).toBeNull();
            expect(linkedSession.metadata.externalSessionV1).toMatchObject({
                agentId: AGENT_ID,
                remoteSessionId: 'native-session',
                linkedAtMs: 1_000,
            });

            retiredEmit?.({
                items: [{
                    linkKey: 'fixture-link',
                    facts: [{
                        kind: 'turn_phase',
                        evidenceClass: 'agent_native',
                        value: 'retrying',
                        observedAtMs: Date.now() + 10_000,
                        expiresAtMs: Date.now() + 20_000,
                    }],
                }],
            });
            await projection.flush();
            expect(publications.map((snapshot) => snapshot.status))
                .toEqual(['working', 'unknown']);

            await install();
            await vi.waitFor(() => {
                expect(fixtureState.observerAcquisitions).toBe(2);
                expect(fixtureState.followAcquisitions).toBe(2);
            });
            await projection.flush();
            expect(publications.map((snapshot) => snapshot.status))
                .toEqual(['working', 'unknown', 'working']);
            expect(fixtureState).toMatchObject({
                observerDisposals: 1,
                followDisposals: 1,
                pageTranscriptCalls: 0,
                readAfterTranscriptCalls: 0,
            });
        } finally {
            await lifecycle.dispose();
            await projection.dispose();
            await followLeaseManager.dispose();
            await changeService.shutdown();
        }

        expect(fixtureState).toMatchObject({
            observerAcquisitions: 2,
            observerDisposals: 2,
            followAcquisitions: 2,
            followDisposals: 2,
        });
    });
});
