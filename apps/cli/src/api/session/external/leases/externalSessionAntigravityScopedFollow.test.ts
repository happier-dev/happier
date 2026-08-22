import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type {
    AgentExternalSessionObservationContribution,
    AgentExternalSessionsContribution,
    AgentExternalSessionsManagedEndpointRead,
} from '@happier-dev/plugin-sdk/sessions/external';
import { expect, it, vi } from 'vitest';

import { createExternalSessionFollowLeaseManager } from './createExternalSessionFollowLeaseManager';
import { createExternalSessionObservationReconciler } from './createExternalSessionObservationReconciler';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';

const unavailableManagedEndpointRead: AgentExternalSessionsManagedEndpointRead =
    async () => {
        throw new Error('Managed endpoint read is unavailable in this file-backed fixture');
    };
const unavailableInvocationExec = createUnavailablePluginServices().exec;

function invocation() {
    return {
        signal: new AbortController().signal,
        deadlineAtMs: Date.now() + 30_000,
        maxSerializedBytes: 524_288,
        managedEndpointRead: unavailableManagedEndpointRead,
        exec: unavailableInvocationExec,
    };
}

async function loadAntigravityFactories() {
    const externalSessionsPath =
        '../../../../../../../packages/plugins/antigravity/src/agent/cliPrint/externalSessions.js';
    const observationPath =
        '../../../../../../../packages/plugins/antigravity/src/agent/cliPrint/observation.js';
    const [externalSessionsModule, observationModule] = await Promise.all([
        import(externalSessionsPath),
        import(observationPath),
    ]);
    return {
        createExternalSessions:
            externalSessionsModule.createAntigravityExternalSessionsContribution as (
                params: Readonly<{ env: NodeJS.ProcessEnv }>,
            ) => AgentExternalSessionsContribution,
        createObservation:
            observationModule.createAntigravityExternalSessionObservationContribution as (
                params: Readonly<{ env: NodeJS.ProcessEnv }>,
            ) => AgentExternalSessionObservationContribution,
    };
}

it('delivers one watched Antigravity append to the scoped follow listener', async () => {
    const root = await mkdtemp(join(
        tmpdir(),
        'happier-antigravity-scoped-follow-',
    ));
    const conversationId = 'conversation-scoped-follow';
    const transcriptPath = join(
        root,
        '.gemini',
        'antigravity-cli',
        'brain',
        conversationId,
        '.system_generated',
        'logs',
        'transcript_full.jsonl',
    );
    await mkdir(dirname(transcriptPath), { recursive: true });
    await writeFile(transcriptPath, [
        JSON.stringify({
            step_index: 1,
            type: 'USER_INPUT',
            text: 'inspect',
            created_at: '2026-07-28T18:00:00Z',
        }),
        JSON.stringify({
            step_index: 2,
            type: 'PLANNER_RESPONSE',
            text: 'initial answer',
            created_at: '2026-07-28T18:00:01Z',
        }),
        '',
    ].join('\n'), 'utf8');

    const { createExternalSessions, createObservation } =
        await loadAntigravityFactories();
    const env = { HOME: root };
    const externalSessions = createExternalSessions({ env });
    const observation = createObservation({ env });
    const source = { kind: 'antigravityCliPrint' as const };
    const identityResult = await externalSessions.resolveLinkIdentity({
        ...invocation(),
        source,
        remoteSessionId: conversationId,
    });
    if (!identityResult.ok) {
        throw new Error('Expected an authoritative Antigravity identity');
    }
    const identity = identityResult.value;
    const grouping = observation.describeResource(identity);
    const descriptorResult = await observation.reconcileResource({
        purpose: 'resource_descriptors',
        resourceKey: grouping.resourceKey,
        links: [{
            linkKey: grouping.linkKey,
            linkedSource: identity,
        }],
        signal: new AbortController().signal,
        managedEndpointRead: unavailableManagedEndpointRead,
    });
    const descriptor = descriptorResult.purpose === 'resource_descriptors'
        ? descriptorResult.outcomes[0]
        : undefined;
    if (descriptor?.kind !== 'described') {
        throw new Error('Expected an authoritative Antigravity watch descriptor');
    }
    if (descriptor.descriptor.changeObservation !== 'watch_file_changes') {
        throw new Error('Expected Antigravity file-change observation');
    }

    const initialPage = await externalSessions.pageTranscript({
        ...invocation(),
        source: identity.source,
        remoteSessionId: identity.remoteSessionId,
        direction: 'older',
        maxItems: 200,
    });
    if (!initialPage.ok || !initialPage.value.tailCursor) {
        throw new Error('Expected an authoritative Antigravity tail cursor');
    }
    const initialCursor = initialPage.value.tailCursor;
    const resource = {
        linkGeneration: 'antigravity-link-generation',
        pluginGeneration: 'antigravity-plugin-generation',
    };
    const manager = createExternalSessionFollowLeaseManager();
    const releasePhysicalFollow = vi.fn(async () => {});
    const deliveredItems: Array<{
        messageRole?: string | null;
        raw: unknown;
    }> = [];
    const listenerRefreshes = vi.fn(async (
        acceptedCursor: string,
        isCurrent: () => boolean,
    ) => {
        expect(acceptedCursor).toBe(initialCursor);
        expect(isCurrent()).toBe(true);
        const result = await externalSessions.readAfterTranscript({
            ...invocation(),
            source: identity.source,
            remoteSessionId: identity.remoteSessionId,
            cursor: acceptedCursor,
            maxItems: 200,
        });
        if (!result.ok || result.value.outcome !== 'advanced') {
            throw new Error('Expected the Antigravity append to advance');
        }
        expect(isCurrent()).toBe(true);
        deliveredItems.push(...result.value.items);
        return { outcome: 'advanced' as const };
    });
    let scopedLease: Awaited<
        ReturnType<typeof manager.attachScoped>
    > | null = null;
    let reconciler: ReturnType<
        typeof createExternalSessionObservationReconciler
    > | null = null;
    try {
        scopedLease = await manager.attachScoped({
            sessionId: 'session-antigravity-scoped-follow',
            acceptedTailCursor: initialCursor,
            resource,
            acquireFollowLease: async () => ({
                release: releasePhysicalFollow,
            }),
            requestTranscriptRefresh: listenerRefreshes,
        });
        const refreshRequests = vi.fn(async (input: Readonly<{
            sessionId: string;
            resource: typeof resource;
        }>) => await manager.requestTranscriptRefresh(input));
        const acquireObserver = vi.fn(async () => ({
            dispose: async () => {},
        }));
        reconciler = createExternalSessionObservationReconciler({
            acquireObserver,
            requestTranscriptRefresh: refreshRequests,
            isTranscriptRefreshDemanded: (input) =>
                manager.hasTranscriptDemand(input),
            reconcileResource: async (input) =>
                await observation.reconcileResource({
                    purpose: input.purpose,
                    resourceKey: input.resource.resourceKey,
                    links: input.links,
                    signal: input.signal,
                    managedEndpointRead: unavailableManagedEndpointRead,
                }),
        });
        await reconciler.reconcileLink({
            resource: {
                pluginId: 'happier.antigravity',
                agentLocalId: 'antigravity',
                pluginGeneration: resource.pluginGeneration,
                resourceKey: descriptor.descriptor.resourceKey,
            },
            link: {
                sessionId: 'session-antigravity-scoped-follow',
                linkGeneration: resource.linkGeneration,
                linkKey: descriptor.descriptor.linkKey,
                linkedSource: identity,
                changeObservation: 'watch_file_changes',
                watchFileChanges: descriptor.descriptor.watchFileChanges,
            },
            demand: {
                passiveEvent: true,
                persistedPolicy: false,
                fallbackDemand: false,
                transcriptDemand: true,
            },
            onFacts: () => {},
        });
        expect(refreshRequests).not.toHaveBeenCalled();
        expect(listenerRefreshes).not.toHaveBeenCalled();
        expect(acquireObserver).not.toHaveBeenCalled();

        const marker = 'ANTIGRAVITY_SCOPED_FOLLOW_MARKER';
        await appendFile(transcriptPath, `${JSON.stringify({
            step_index: 3,
            type: 'PLANNER_RESPONSE',
            text: marker,
            created_at: '2026-07-28T18:00:02Z',
        })}\n`, 'utf8');

        await vi.waitFor(() => {
            expect(deliveredItems).toContainEqual(expect.objectContaining({
                messageRole: 'agent',
                raw: {
                    role: 'agent',
                    content: {
                        type: 'acp',
                        agentId: 'antigravity',
                        data: { type: 'message', message: marker },
                    },
                },
            }));
        }, { timeout: 10_000 });
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(refreshRequests).toHaveBeenCalledTimes(1);
        expect(listenerRefreshes).toHaveBeenCalledTimes(1);
    } finally {
        await scopedLease?.release();
        await reconciler?.dispose();
        await manager.dispose();
        await rm(root, { recursive: true, force: true });
    }
    expect(releasePhysicalFollow).toHaveBeenCalledTimes(1);
}, 20_000);
