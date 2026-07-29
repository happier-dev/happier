import {
    appendFile,
    mkdir,
    mkdtemp,
    realpath,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
    AgentExternalSessionObservationContribution,
    AgentExternalSessionsContribution,
    AgentExternalSessionsResolvedIdentity,
} from '@happier-dev/plugin-sdk/experimental/sessions';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createExternalSessionObservationDaemonProjection,
} from './createExternalSessionObservationDaemonProjection';
import {
    createExternalSessionObservationReconciler,
    type ExternalSessionObservationLinkIdentity,
    type ExternalSessionObservationResourceIdentity,
} from './createExternalSessionObservationReconciler';

const fsBoundary = vi.hoisted(() => ({
    open: vi.fn(),
    readdir: vi.fn(),
}));

vi.mock('node:fs/promises', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
    );
    return {
        ...actual,
        open: (...args: Parameters<typeof actual.open>) =>
            fsBoundary.open(...args),
        readdir: (...args: Parameters<typeof actual.readdir>) =>
            fsBoundary.readdir(...args),
    };
});

type CodexObservationFactory = (
    params: Readonly<{ env: NodeJS.ProcessEnv }>,
) => AgentExternalSessionObservationContribution;

type CodexExternalSessionsFactory = (
    params: Readonly<{
        env: NodeJS.ProcessEnv;
        activeServerDir: string;
    }>,
) => AgentExternalSessionsContribution;

type CodexHomeFixture = Readonly<{
    root: string;
    codexHome: string;
    sessionsRoot: string;
    archivedSessionsRoot: string;
    identities: readonly AgentExternalSessionsResolvedIdentity[];
    rootFiles: readonly string[];
    observation: AgentExternalSessionObservationContribution;
    externalSessions: AgentExternalSessionsContribution;
}>;

const roots: string[] = [];

function jsonl(value: unknown): string {
    return `${JSON.stringify(value)}\n`;
}

function rootSessionId(homeIndex: number, linkIndex: number): string {
    const suffix = String(homeIndex * 1_000 + linkIndex + 1).padStart(12, '0');
    return `11111111-1111-4111-8111-${suffix}`;
}

function childSessionId(homeIndex: number, linkIndex: number): string {
    const suffix = String(500_000 + homeIndex * 1_000 + linkIndex + 1)
        .padStart(12, '0');
    return `22222222-2222-4222-8222-${suffix}`;
}

async function loadCodexObservationFactory(): Promise<CodexObservationFactory> {
    const modulePath =
        '../../../../../../../packages/plugins/codex/src/agent/surfaces/sessions/external/observation.js';
    const module = await import(modulePath);
    return module.createCodexExternalSessionObservationContribution as CodexObservationFactory;
}

async function loadCodexExternalSessionsFactory(): Promise<CodexExternalSessionsFactory> {
    const modulePath =
        '../../../../../../../packages/plugins/codex/src/agent/surfaces/sessions/external/contribution.js';
    const module = await import(modulePath);
    return module.createCodexExternalSessionsContribution as CodexExternalSessionsFactory;
}

async function createCodexHomeFixture(params: Readonly<{
    createObservation: CodexObservationFactory;
    createExternalSessions: CodexExternalSessionsFactory;
    homeIndex: number;
    linkCount: number;
}>): Promise<CodexHomeFixture> {
    const root = await realpath(await mkdtemp(
        join(tmpdir(), `happier-codex-topology-batch-${params.homeIndex}-`),
    ));
    roots.push(root);
    const codexHome = join(root, 'codex-home');
    const sessionsRoot = join(codexHome, 'sessions');
    const archivedSessionsRoot = join(codexHome, 'archived_sessions');
    const sessionDay = join(sessionsRoot, '2026', '07', '25');
    const archivedDay = join(archivedSessionsRoot, '2026', '07', '24');
    await Promise.all([
        mkdir(sessionDay, { recursive: true }),
        mkdir(archivedDay, { recursive: true }),
    ]);

    const identities: AgentExternalSessionsResolvedIdentity[] = [];
    const rootFiles: string[] = [];
    for (let index = 0; index < params.linkCount; index += 1) {
        const remoteSessionId = rootSessionId(params.homeIndex, index);
        const targetDir = index % 2 === 0 ? sessionDay : archivedDay;
        const file = join(
            targetDir,
            `rollout-2026-07-25T12-00-${String(index).padStart(2, '0')}-${remoteSessionId}.jsonl`,
        );
        await writeFile(file, [
            jsonl({
                type: 'session_meta',
                timestamp: '2026-07-25T12:00:00.000Z',
                payload: {
                    id: remoteSessionId,
                    timestamp: '2026-07-25T12:00:00.000Z',
                    cwd: `/work/home-${params.homeIndex}/root-${index}`,
                },
            }),
            jsonl({
                type: 'response_item',
                timestamp: '2026-07-25T12:00:01.000Z',
                payload: {
                    type: 'message',
                    role: 'assistant',
                    content: [{
                        type: 'output_text',
                        text: `initial root ${params.homeIndex}:${index}`,
                    }],
                },
            }),
        ].join(''), 'utf8');
        const source = {
            kind: 'codexHome',
            home: 'user',
            homePath: codexHome,
        } as const;
        identities.push({
            source,
            remoteSessionId,
            linkData: { source },
        });
        rootFiles.push(file);
    }

    return {
        root,
        codexHome,
        sessionsRoot,
        archivedSessionsRoot,
        identities,
        rootFiles,
        observation: params.createObservation({
            env: { CODEX_HOME: codexHome },
        }),
        externalSessions: params.createExternalSessions({
            env: { CODEX_HOME: codexHome },
            activeServerDir: join(root, 'active-server'),
        }),
    };
}

function invocation() {
    return {
        signal: new AbortController().signal,
        deadlineAtMs: Date.now() + 30_000,
        maxSerializedBytes: 524_288,
    };
}

function deferred() {
    let resolve = () => {};
    const promise = new Promise<void>((settle) => {
        resolve = settle;
    });
    return { promise, resolve };
}

function callsForExactPath(
    mock: typeof fsBoundary.readdir,
    path: string,
): number {
    return mock.mock.calls.filter(([requestedPath]) =>
        String(requestedPath) === path).length;
}

describe('composed Codex topology descriptor batching', () => {
    beforeEach(async () => {
        const actual = await vi.importActual<typeof import('node:fs/promises')>(
            'node:fs/promises',
        );
        fsBoundary.open.mockReset();
        fsBoundary.open.mockImplementation(actual.open);
        fsBoundary.readdir.mockReset();
        fsBoundary.readdir.mockImplementation(actual.readdir);
    });

    afterEach(async () => {
        await Promise.all(roots.splice(0).map(async (root) => {
            await rm(root, { recursive: true, force: true });
        }));
        vi.restoreAllMocks();
    });

    it('batches 100 links on one real Codex resource into one full-cardinality home inventory', async () => {
        const [createObservation, createExternalSessions] = await Promise.all([
            loadCodexObservationFactory(),
            loadCodexExternalSessionsFactory(),
        ]);
        const home = await createCodexHomeFixture({
            createObservation,
            createExternalSessions,
            homeIndex: 3,
            linkCount: 100,
        });
        fsBoundary.open.mockClear();
        fsBoundary.readdir.mockClear();
        const grouping = home.identities.map((identity) => ({
            identity,
            grouping: home.observation.describeResource(identity),
        }));
        expect(fsBoundary.open).not.toHaveBeenCalled();
        expect(fsBoundary.readdir).not.toHaveBeenCalled();
        fsBoundary.open.mockClear();
        fsBoundary.readdir.mockClear();
        const changedIndex = 73;
        const changedRootId = home.identities[changedIndex]!.remoteSessionId;
        const delayedChildId = childSessionId(3, changedIndex);
        const delayedChildFile = join(
            home.sessionsRoot,
            '2026',
            '07',
            '25',
            `rollout-2026-07-25T12-03-00-${delayedChildId}.jsonl`,
        );
        await writeFile(delayedChildFile, jsonl({
            type: 'session_meta',
            timestamp: '2026-07-25T12:03:00.000Z',
            payload: {
                id: delayedChildId,
                session_id: changedRootId,
                timestamp: '2026-07-25T12:03:00.000Z',
                cwd: '/work/one-home-delayed-child',
            },
        }), 'utf8');

        const topologyCallbacks = new Map<string, () => void>();
        const watchedFiles = new Set<string>();
        const descriptorResults: Array<Awaited<ReturnType<
            AgentExternalSessionObservationContribution['reconcileResource']
        >>> = [];
        const descriptorCalls = vi.fn(async (input: Readonly<{
            purpose: 'observation_evidence' | 'resource_descriptors';
            resource: ExternalSessionObservationResourceIdentity;
            links: readonly ExternalSessionObservationLinkIdentity[];
            signal: AbortSignal;
        }>) => {
            const result = await home.observation.reconcileResource({
                purpose: input.purpose,
                resourceKey: input.resource.resourceKey,
                links: input.links.map((link) => ({
                    linkKey: link.linkKey,
                    linkedSource: link.linkedSource,
                })),
                signal: input.signal,
            });
            if (input.purpose === 'resource_descriptors') {
                descriptorResults.push(result);
            }
            return result;
        });
        const resource = {
            pluginId: 'happier.codex',
            agentLocalId: 'codex',
            pluginGeneration: 'one-home-plugin-generation',
            resourceKey: grouping[0]!.grouping.resourceKey,
        } satisfies ExternalSessionObservationResourceIdentity;
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver: vi.fn(async () => ({ dispose: vi.fn() })),
            reconcileResource: descriptorCalls,
            watchFile: vi.fn((file) => {
                watchedFiles.add(file);
                return vi.fn();
            }),
            watchTopologyDirectory: vi.fn((directory, onChange) => {
                topologyCallbacks.set(directory, onChange);
                return vi.fn();
            }),
        });
        for (const [index, entry] of grouping.entries()) {
            await reconciler.reconcileLink({
                resource,
                link: {
                    sessionId: `one-home-session-${index}`,
                    linkGeneration: `one-home-link-generation-${index}`,
                    linkKey: entry.grouping.linkKey,
                    linkedSource: entry.identity,
                },
                demand: {
                    passiveEvent: true,
                    persistedPolicy: false,
                    fallbackDemand: false,
                },
                onFacts: () => {},
            });
        }

        await vi.waitFor(() => {
            expect(descriptorCalls.mock.calls.filter(
                ([input]) => input.purpose === 'resource_descriptors',
            )).toHaveLength(1);
            expect(watchedFiles.has(delayedChildFile)).toBe(true);
        }, { timeout: 30_000 });

        expect(descriptorCalls.mock.calls.filter(
            ([input]) => input.purpose === 'resource_descriptors',
        )).toHaveLength(1);
        expect(watchedFiles.size).toBe(101);
        expect(watchedFiles.has(delayedChildFile)).toBe(true);
        expect(topologyCallbacks.size).toBe(2);

        const [descriptorCall] = descriptorCalls.mock.calls.filter(
            ([input]) => input.purpose === 'resource_descriptors',
        );
        expect(descriptorCall?.[0].links).toHaveLength(100);
        expect(callsForExactPath(
            fsBoundary.readdir,
            home.sessionsRoot,
        )).toBeLessThanOrEqual(2);
        expect(callsForExactPath(
            fsBoundary.readdir,
            home.archivedSessionsRoot,
        )).toBeLessThanOrEqual(2);
        expect(new Set(fsBoundary.open.mock.calls.map(([file]) => String(file))).size)
            .toBe(101);
        const descriptorResult = descriptorResults.at(-1);
        if (descriptorResult?.purpose !== 'resource_descriptors') {
            throw new Error('Expected the one-home descriptor result');
        }
        expect(descriptorResult.outcomes).toHaveLength(100);
        for (const [index, outcome] of descriptorResult.outcomes.entries()) {
            if (
                outcome.kind !== 'described'
                || outcome.descriptor.changeObservation !== 'watch_file_changes'
            ) {
                throw new Error('Expected a described Codex file set');
            }
            if (index === changedIndex) {
                expect(outcome.descriptor.watchFileChanges.files).toEqual(
                    expect.arrayContaining([
                        home.rootFiles[index],
                        delayedChildFile,
                    ]),
                );
            } else {
                expect(outcome.descriptor.watchFileChanges.files)
                    .toEqual([home.rootFiles[index]]);
                expect(outcome.descriptor.watchFileChanges.files)
                    .not.toContain(delayedChildFile);
            }
        }

        await reconciler.dispose();
    }, 120_000);

    it('awaits real Codex descriptor admission before transcript demand observes exact-file appends', async () => {
        const [createObservation, createExternalSessions] = await Promise.all([
            loadCodexObservationFactory(),
            loadCodexExternalSessionsFactory(),
        ]);
        const home = await createCodexHomeFixture({
            createObservation,
            createExternalSessions,
            homeIndex: 4,
            linkCount: 1,
        });
        const identity = home.identities[0]!;
        const grouping = home.observation.describeResource(identity);
        const descriptorGate = deferred();
        const reconcileResource = vi.fn<
            AgentExternalSessionObservationContribution['reconcileResource']
        >(async (request) => {
            if (request.purpose === 'resource_descriptors') {
                await descriptorGate.promise;
            }
            return await home.observation.reconcileResource(request);
        });
        const contribution: AgentExternalSessionObservationContribution = {
            describeResource: (resolved) =>
                home.observation.describeResource(resolved),
            observeResource: async (request) =>
                await home.observation.observeResource(request),
            reconcileResource,
        };
        const fileCallbacks = new Map<string, (file: string) => void>();
        const requestTranscriptRefresh = vi.fn();
        const projection = createExternalSessionObservationDaemonProjection({
            acquireObservationContribution: vi.fn(async () => ({
                contribution,
                filesystemReadAllowedPaths: new Set(['grant-present']),
                release: async () => {},
            })),
            publishField: vi.fn(async () => {}),
            watchFile: vi.fn((file, onChange) => {
                fileCallbacks.set(file, onChange);
                return vi.fn();
            }),
            watchTopologyDirectory: vi.fn(() => vi.fn()),
            requestTranscriptRefresh,
            isTranscriptRefreshDemanded: () => true,
        });
        const sessionId = 'happier-session-grouping-transcript-demand';
        const linkGeneration = 'grouping-transcript-demand-link';
        let admissionSettled = false;
        const admission = projection.reconcileTranscriptDemand({
            resolved: {
                resource: {
                    pluginId: 'happier.agent.codex',
                    agentLocalId: 'codex',
                    pluginGeneration: 'grouping-transcript-demand-plugin',
                    resourceKey: grouping.resourceKey,
                },
                link: {
                    sessionId,
                    linkGeneration,
                    linkKey: grouping.linkKey,
                    linkedSource: identity,
                },
                target: {
                    qualifiedLinkIdentity: {
                        v: 1,
                        agent: {
                            pluginId: 'happier.agent.codex',
                            localId: 'codex',
                        },
                        source: {
                            kind: 'codexHome',
                            contractVersion: 1,
                        },
                    },
                    linkGeneration,
                },
            },
            demanded: true,
        }).then((result) => {
            admissionSettled = true;
            return result;
        });

        await vi.waitFor(() => expect(reconcileResource).toHaveBeenCalledWith(
            expect.objectContaining({ purpose: 'resource_descriptors' }),
        ));
        const settledBeforeDescriptorAdmission = admissionSettled;
        descriptorGate.resolve();
        const admitted = await admission;
        const rootFile = home.rootFiles[0]!;
        await vi.waitFor(() => expect(fileCallbacks.has(rootFile)).toBe(true));

        await appendFile(
            rootFile,
            jsonl({
                type: 'response_item',
                timestamp: '2026-07-25T12:00:02.000Z',
                payload: {
                    type: 'message',
                    role: 'assistant',
                    content: [{
                        type: 'output_text',
                        text: 'live grouping-demand canary',
                    }],
                },
            }),
            'utf8',
        );
        fileCallbacks.get(rootFile)?.(rootFile);
        await vi.waitFor(() => expect(requestTranscriptRefresh).toHaveBeenCalledWith({
            sessionId,
            resource: {
                linkGeneration,
                pluginGeneration: 'grouping-transcript-demand-plugin',
            },
        }));

        await projection.dispose();
        expect(settledBeforeDescriptorAdmission).toBe(false);
        expect(admitted).toEqual({ state: 'observing' });
    }, 60_000);

    it('inventories each real Codex home once for 100 current links and isolates a delayed child to its root', async () => {
        const [createObservation, createExternalSessions] = await Promise.all([
            loadCodexObservationFactory(),
            loadCodexExternalSessionsFactory(),
        ]);
        const homes = await Promise.all([0, 1].map(async (homeIndex) =>
            await createCodexHomeFixture({
                createObservation,
                createExternalSessions,
                homeIndex,
                linkCount: 50,
            })));

        const grouped = homes.map((home) =>
            home.identities.map((identity) => ({
                identity,
                grouping: home.observation.describeResource(identity),
            })));
        const changedHome = homes[0]!;
        const changedRootIndex = 17;
        const changedRootId =
            changedHome.identities[changedRootIndex]!.remoteSessionId;
        const initialPage = await changedHome.externalSessions.pageTranscript({
            ...invocation(),
            source: changedHome.identities[changedRootIndex]!.source,
            remoteSessionId: changedRootId,
            direction: 'older',
            maxItems: 200,
        });
        if (!initialPage.ok || !initialPage.value.tailCursor) {
            throw new Error('Expected a current cursor before delayed-child creation');
        }
        const initialCursor = initialPage.value.tailCursor;
        const delayedChildId = childSessionId(0, changedRootIndex);
        const delayedChildFile = join(
            changedHome.sessionsRoot,
            '2026',
            '07',
            '25',
            `rollout-2026-07-25T12-01-00-${delayedChildId}.jsonl`,
        );
        await writeFile(delayedChildFile, [
            jsonl({
                type: 'session_meta',
                timestamp: '2026-07-25T12:01:00.000Z',
                payload: {
                    id: delayedChildId,
                    session_id: changedRootId,
                    timestamp: '2026-07-25T12:01:00.000Z',
                    cwd: '/work/delayed-child',
                },
            }),
            jsonl({
                type: 'response_item',
                timestamp: '2026-07-25T12:01:01.000Z',
                payload: {
                    type: 'message',
                    role: 'assistant',
                    content: [{
                        type: 'output_text',
                        text: 'delayed child answer',
                    }],
                },
            }),
        ].join(''), 'utf8');

        fsBoundary.open.mockClear();
        fsBoundary.readdir.mockClear();
        const publicCalls = vi.fn(async (
            home: CodexHomeFixture,
            links: readonly Readonly<{
                linkKey: string;
                linkedSource: AgentExternalSessionsResolvedIdentity;
            }>[],
        ) => await home.observation.reconcileResource({
            purpose: 'resource_descriptors',
            resourceKey: grouped[homes.indexOf(home)]![0]!.grouping.resourceKey,
            links,
            signal: new AbortController().signal,
        }));

        const results = await Promise.all(homes.map(async (home, homeIndex) =>
            await publicCalls(
                home,
                grouped[homeIndex]!.map(({ identity, grouping }) => ({
                    linkKey: grouping.linkKey,
                    linkedSource: identity,
                })),
            )));

        expect(publicCalls).toHaveBeenCalledTimes(2);
        for (const home of homes) {
            expect(callsForExactPath(fsBoundary.readdir, home.sessionsRoot))
                .toBe(1);
            expect(callsForExactPath(
                fsBoundary.readdir,
                home.archivedSessionsRoot,
            )).toBe(1);
        }
        expect(fsBoundary.open).toHaveBeenCalledTimes(101);
        const described = results.map((result, homeIndex) => {
            if (result.purpose !== 'resource_descriptors') {
                throw new Error('Expected descriptor reconciliation');
            }
            return result.outcomes.map((outcome, index) => {
                if (outcome.kind !== 'described') {
                    throw new Error('Expected an admitted initial descriptor');
                }
                return {
                    identity: homes[homeIndex]!.identities[index]!,
                    descriptor: outcome.descriptor,
                };
            });
        });

        const changedResult = results[0]!;
        if (changedResult.purpose !== 'resource_descriptors') {
            throw new Error('Expected descriptor reconciliation for the changed home');
        }
        const changedOutcomes = changedResult.outcomes;
        expect(changedOutcomes).toHaveLength(50);
        for (const [index, outcome] of changedOutcomes.entries()) {
            expect(outcome.kind).toBe('described');
            if (outcome.kind !== 'described') continue;
            const files = outcome.descriptor.changeObservation
                === 'watch_file_changes'
                ? outcome.descriptor.watchFileChanges.files
                : [];
            if (index === changedRootIndex) {
                expect(files).toEqual(expect.arrayContaining([
                    changedHome.rootFiles[index],
                    delayedChildFile,
                ]));
            } else {
                expect(files).toEqual([changedHome.rootFiles[index]]);
                expect(files).not.toContain(delayedChildFile);
            }
        }
        const unchangedResult = results[1]!;
        if (unchangedResult.purpose !== 'resource_descriptors') {
            throw new Error('Expected descriptor reconciliation for the unchanged home');
        }
        expect(unchangedResult.outcomes).toHaveLength(50);
        const topologyCallbacks = new Map<string, (changedPath?: string) => void>();
        const fileCallbacks = new Map<string, (changedPath: string) => void>();
        const fileDisposals = new Map<string, ReturnType<typeof vi.fn>>();
        const retirementControllers = homes.map(() => new AbortController());
        const resourceByHome = homes.map((_, homeIndex) => ({
            pluginId: 'happier.codex',
            agentLocalId: 'codex',
            pluginGeneration: `codex-generation-${homeIndex}`,
            resourceKey: described[homeIndex]![0]!.descriptor.resourceKey,
            retirementSignal: retirementControllers[homeIndex]!.signal,
        } satisfies ExternalSessionObservationResourceIdentity));
        const linkedSessions = homes.flatMap((home, homeIndex) =>
            described[homeIndex]!.map(({ identity, descriptor }, linkIndex) => ({
                homeIndex,
                linkIndex,
                resource: resourceByHome[homeIndex]!,
                link: {
                    sessionId: `happier-session-${homeIndex}-${linkIndex}`,
                    linkGeneration: `link-generation-${homeIndex}-${linkIndex}`,
                    linkKey: descriptor.linkKey,
                    linkedSource: identity,
                    changeObservation: descriptor.changeObservation,
                    ...(descriptor.changeObservation === 'watch_file_changes'
                        ? { watchFileChanges: descriptor.watchFileChanges }
                        : {}),
                } satisfies ExternalSessionObservationLinkIdentity,
            })));
        const changedSessionId =
            `happier-session-0-${changedRootIndex}`;
        const homeByResourceKey = new Map(resourceByHome.map(
            (resource, homeIndex) => [resource.resourceKey, homes[homeIndex]!],
        ));
        let unavailableLinkKey: string | null = null;
        let descriptorGate: Promise<void> | null = null;
        const descriptorInventoryCounts: Array<Readonly<{
            sessions: number;
            archivedSessions: number;
        }>> = [];
        const hostReconcileResource = vi.fn(async (
            input: Readonly<{
                purpose: 'observation_evidence' | 'resource_descriptors';
                resource: ExternalSessionObservationResourceIdentity;
                links: readonly ExternalSessionObservationLinkIdentity[];
                signal: AbortSignal;
            }>,
        ) => {
            const home = homeByResourceKey.get(input.resource.resourceKey);
            if (!home) {
                throw new Error('Unexpected Codex resource');
            }
            const sessionsBefore = callsForExactPath(
                fsBoundary.readdir,
                home.sessionsRoot,
            );
            const archivedBefore = callsForExactPath(
                fsBoundary.readdir,
                home.archivedSessionsRoot,
            );
            const result = await home.observation.reconcileResource({
                purpose: input.purpose,
                resourceKey: input.resource.resourceKey,
                links: input.links.map((link) => ({
                    linkKey: link.linkKey,
                    linkedSource: link.linkedSource,
                })),
                signal: input.signal,
            });
            if (input.purpose === 'resource_descriptors') {
                descriptorInventoryCounts.push({
                    sessions: callsForExactPath(
                        fsBoundary.readdir,
                        home.sessionsRoot,
                    ) - sessionsBefore,
                    archivedSessions: callsForExactPath(
                        fsBoundary.readdir,
                        home.archivedSessionsRoot,
                    ) - archivedBefore,
                });
            }
            if (input.purpose !== 'resource_descriptors') {
                return result;
            }
            if (descriptorGate) {
                await descriptorGate;
            }
            if (
                result.purpose !== 'resource_descriptors'
                || unavailableLinkKey === null
            ) {
                return result;
            }
            return {
                purpose: 'resource_descriptors' as const,
                outcomes: result.outcomes.map((outcome) => (
                    outcome.kind === 'described'
                    && outcome.descriptor.linkKey === unavailableLinkKey
                        ? {
                            kind: 'unavailable' as const,
                            linkKey: unavailableLinkKey,
                        }
                        : outcome
                )),
            };
        });
        const waitForDescriptorApplication = async (): Promise<void> => {
            const pending = hostReconcileResource.mock.results.flatMap(
                (mockResult, index) => (
                    hostReconcileResource.mock.calls[index]?.[0].purpose
                        === 'resource_descriptors'
                    && mockResult.type === 'return'
                        ? [Promise.resolve(mockResult.value)]
                        : []
                ),
            );
            await Promise.all(pending);
            await new Promise<void>((resolve) => {
                setImmediate(resolve);
            });
        };
        const refreshReads: unknown[] = [];
        const requestTranscriptRefresh = vi.fn(async (input: Readonly<{
            sessionId: string;
        }>) => {
            if (input.sessionId !== changedSessionId) {
                return;
            }
            refreshReads.push(
                await changedHome.externalSessions.readAfterTranscript({
                    ...invocation(),
                    source: changedHome.identities[changedRootIndex]!.source,
                    remoteSessionId: changedRootId,
                    cursor: initialCursor,
                    maxItems: 200,
                }),
            );
        });
        const acquireObserver = vi.fn(async () => ({ dispose: vi.fn() }));
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver,
            requestTranscriptRefresh,
            isTranscriptRefreshDemanded: () => true,
            reconcileResource: hostReconcileResource,
            watchFile: vi.fn((file, onChange) => {
                fileCallbacks.set(file, onChange);
                const dispose = vi.fn();
                fileDisposals.set(file, dispose);
                return dispose;
            }),
            watchTopologyDirectory: vi.fn((directory, onChange) => {
                topologyCallbacks.set(directory, onChange);
                return vi.fn();
            }),
        });

        for (const current of linkedSessions) {
            await reconciler.reconcileLink({
                resource: current.resource,
                link: current.link,
                demand: {
                    passiveEvent: true,
                    persistedPolicy: false,
                    fallbackDemand: false,
                    transcriptDemand: true,
                },
                onFacts: () => {},
            });
        }

        expect(acquireObserver).not.toHaveBeenCalled();
        expect(topologyCallbacks.size).toBe(4);
        expect(new Set([...topologyCallbacks.keys()].map((directory) =>
            homes.findIndex((home) => directory.startsWith(home.codexHome)),
        ))).toEqual(new Set([0, 1]));
        expect(fileCallbacks.size).toBe(101);
        fsBoundary.open.mockClear();
        fsBoundary.readdir.mockClear();
        hostReconcileResource.mockClear();
        descriptorInventoryCounts.length = 0;
        topologyCallbacks.get(changedHome.sessionsRoot)?.();
        topologyCallbacks.get(homes[1]!.sessionsRoot)?.();

        await vi.waitFor(() => {
            expect(hostReconcileResource.mock.calls.filter(
                ([input]) => input.purpose === 'resource_descriptors',
            )).toHaveLength(2);
            expect(descriptorInventoryCounts).toHaveLength(2);
            expect(fileCallbacks.has(delayedChildFile)).toBe(true);
        }, { timeout: 30_000 });
        await waitForDescriptorApplication();
        expect(hostReconcileResource.mock.calls.filter(
            ([input]) => input.purpose === 'resource_descriptors',
        ).map(([input]) => input.links.length).sort()).toEqual([50, 50]);
        expect(descriptorInventoryCounts).toEqual([
            { sessions: 1, archivedSessions: 1 },
            { sessions: 1, archivedSessions: 1 },
        ]);
        expect(requestTranscriptRefresh).not.toHaveBeenCalled();
        expect(fileCallbacks.has(delayedChildFile)).toBe(true);

        hostReconcileResource.mockClear();
        requestTranscriptRefresh.mockClear();
        refreshReads.length = 0;
        fileCallbacks.get(delayedChildFile)?.(delayedChildFile);
        await vi.waitFor(() => {
            expect(hostReconcileResource.mock.calls.filter(
                ([input]) => input.purpose === 'resource_descriptors',
            )).toHaveLength(1);
            expect(requestTranscriptRefresh).toHaveBeenCalledOnce();
            expect(refreshReads).toHaveLength(1);
        }, { timeout: 30_000 });
        expect(hostReconcileResource.mock.calls.filter(
            ([input]) => input.purpose === 'resource_descriptors',
        )[0]?.[0].links.map((link) => link.sessionId)).toEqual([
            changedSessionId,
        ]);

        hostReconcileResource.mockClear();
        requestTranscriptRefresh.mockClear();
        refreshReads.length = 0;
        unavailableLinkKey =
            linkedSessions.find(({ homeIndex, linkIndex }) => (
                homeIndex === 0 && linkIndex === changedRootIndex
            ))!.link.linkKey;
        const delayedChildDisposal = fileDisposals.get(delayedChildFile);
        expect(delayedChildDisposal).toBeDefined();
        topologyCallbacks.get(changedHome.sessionsRoot)?.();
        await vi.waitFor(() => expect(
            hostReconcileResource.mock.calls.filter(
                ([input]) => input.purpose === 'resource_descriptors',
            ),
        ).toHaveLength(1), { timeout: 30_000 });
        await waitForDescriptorApplication();
        expect(fileCallbacks.has(delayedChildFile)).toBe(true);
        expect(delayedChildDisposal!).not.toHaveBeenCalled();
        expect(requestTranscriptRefresh).not.toHaveBeenCalled();
        fileCallbacks.get(delayedChildFile)?.(delayedChildFile);
        await vi.waitFor(() => {
            expect(hostReconcileResource.mock.calls.filter(
                ([input]) => input.purpose === 'resource_descriptors',
            ).length).toBeGreaterThanOrEqual(2);
        });
        await waitForDescriptorApplication();

        unavailableLinkKey = null;
        hostReconcileResource.mockClear();
        const coalescingGate = deferred();
        descriptorGate = coalescingGate.promise;
        topologyCallbacks.get(changedHome.sessionsRoot)?.();
        await vi.waitFor(() => expect(
            hostReconcileResource.mock.calls.filter(
                ([input]) => input.purpose === 'resource_descriptors',
            ),
        ).toHaveLength(1), { timeout: 30_000 });
        topologyCallbacks.get(changedHome.sessionsRoot)?.();
        topologyCallbacks.get(changedHome.archivedSessionsRoot)?.();
        topologyCallbacks.get(changedHome.sessionsRoot)?.();
        coalescingGate.resolve();
        descriptorGate = null;
        await vi.waitFor(() => expect(
            hostReconcileResource.mock.calls.filter(
                ([input]) => input.purpose === 'resource_descriptors',
            ),
        ).toHaveLength(2), { timeout: 30_000 });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(hostReconcileResource.mock.calls.filter(
            ([input]) => input.purpose === 'resource_descriptors',
        )).toHaveLength(2);

        const statusOnlyWatchFile = vi.fn(() => vi.fn());
        const statusOnlyWatchTopology = vi.fn(() => vi.fn());
        const statusOnlyAcquireObserver = vi.fn(async () => ({ dispose: vi.fn() }));
        const statusOnlyRefresh = vi.fn();
        const statusOnlyReconcileResource = vi.fn(async (input: Readonly<{
            purpose: 'observation_evidence' | 'resource_descriptors';
            resource: ExternalSessionObservationResourceIdentity;
            links: readonly ExternalSessionObservationLinkIdentity[];
            signal: AbortSignal;
        }>) => await homes[1]!.observation.reconcileResource({
            purpose: input.purpose,
            resourceKey: input.resource.resourceKey,
            links: input.links.map((link) => ({
                linkKey: link.linkKey,
                linkedSource: link.linkedSource,
            })),
            signal: input.signal,
        }));
        const statusOnly = createExternalSessionObservationReconciler({
            acquireObserver: statusOnlyAcquireObserver,
            requestTranscriptRefresh: statusOnlyRefresh,
            isTranscriptRefreshDemanded: () => false,
            reconcileResource: statusOnlyReconcileResource,
            watchFile: statusOnlyWatchFile,
            watchTopologyDirectory: statusOnlyWatchTopology,
        });
        const statusOnlyCurrent = linkedSessions.find(
            ({ homeIndex, linkIndex }) => homeIndex === 1 && linkIndex === 0,
        )!;
        await statusOnly.reconcileLink({
            resource: statusOnlyCurrent.resource,
            link: statusOnlyCurrent.link,
            demand: {
                passiveEvent: false,
                persistedPolicy: false,
                fallbackDemand: true,
                transcriptDemand: false,
            },
            onFacts: () => {},
        });
        await statusOnly.reconcileResource(statusOnlyCurrent.resource);
        expect(statusOnlyReconcileResource).toHaveBeenCalledOnce();
        expect(statusOnlyReconcileResource).toHaveBeenCalledWith(
            expect.objectContaining({ purpose: 'observation_evidence' }),
        );
        expect(statusOnlyAcquireObserver).not.toHaveBeenCalled();
        expect(statusOnlyWatchFile).not.toHaveBeenCalled();
        expect(statusOnlyWatchTopology).not.toHaveBeenCalled();
        expect(statusOnlyRefresh).not.toHaveBeenCalled();
        await statusOnly.dispose();

        const lateTopologyCallbacks = new Map<string, () => void>();
        const lateFileCallbacks = new Map<string, (file: string) => void>();
        const lateRefresh = vi.fn();
        const lateRetirement = new AbortController();
        const retirementGate = deferred();
        const lateReconcileResource = vi.fn(async (input: Readonly<{
            purpose: 'observation_evidence' | 'resource_descriptors';
            resource: ExternalSessionObservationResourceIdentity;
            links: readonly ExternalSessionObservationLinkIdentity[];
            signal: AbortSignal;
        }>) => {
            const result = await changedHome.observation.reconcileResource({
                purpose: input.purpose,
                resourceKey: input.resource.resourceKey,
                links: input.links.map((link) => ({
                    linkKey: link.linkKey,
                    linkedSource: link.linkedSource,
                })),
                signal: input.signal,
            });
            if (input.purpose === 'resource_descriptors') {
                await retirementGate.promise;
            }
            return result;
        });
        const lateReconciler = createExternalSessionObservationReconciler({
            acquireObserver: vi.fn(async () => ({ dispose: vi.fn() })),
            requestTranscriptRefresh: lateRefresh,
            isTranscriptRefreshDemanded: () => true,
            reconcileResource: lateReconcileResource,
            watchFile: vi.fn((file, onChange) => {
                lateFileCallbacks.set(file, onChange);
                return vi.fn();
            }),
            watchTopologyDirectory: vi.fn((directory, onChange) => {
                lateTopologyCallbacks.set(directory, onChange);
                return vi.fn();
            }),
        });
        const lateCurrent = linkedSessions.find(
            ({ homeIndex, linkIndex }) => (
                homeIndex === 0 && linkIndex === changedRootIndex
            ),
        )!;
        await lateReconciler.reconcileLink({
            resource: {
                ...lateCurrent.resource,
                pluginGeneration: 'late-plugin-generation',
                retirementSignal: lateRetirement.signal,
            },
            link: {
                ...lateCurrent.link,
                watchFileChanges: lateCurrent.link.watchFileChanges
                    ? {
                        ...lateCurrent.link.watchFileChanges,
                        files: lateCurrent.link.watchFileChanges.files.filter(
                            (file) => file !== delayedChildFile,
                        ),
                    }
                    : undefined,
            },
            demand: {
                passiveEvent: true,
                persistedPolicy: false,
                fallbackDemand: false,
                transcriptDemand: true,
            },
            onFacts: () => {},
        });
        lateTopologyCallbacks.get(changedHome.sessionsRoot)?.();
        await vi.waitFor(() => {
            expect(lateReconcileResource).toHaveBeenCalledOnce();
        }, { timeout: 30_000 });
        lateRetirement.abort();
        retirementGate.resolve();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(lateFileCallbacks.has(delayedChildFile)).toBe(false);
        expect(lateRefresh).not.toHaveBeenCalled();
        await lateReconciler.dispose();

        await reconciler.dispose();
    }, 120_000);

    it('revalidates targeted exact-file descriptor reconciliation against the Codex source grant', async () => {
        const [createObservation, createExternalSessions] = await Promise.all([
            loadCodexObservationFactory(),
            loadCodexExternalSessionsFactory(),
        ]);
        const home = await createCodexHomeFixture({
            createObservation,
            createExternalSessions,
            homeIndex: 2,
            linkCount: 1,
        });
        const identity = home.identities[0]!;
        const grouping = home.observation.describeResource(identity);
        const outsideSourceFile = join(home.root, 'outside-codex-source.jsonl');
        await writeFile(outsideSourceFile, '{}\n', 'utf8');
        const describeResource = vi.fn(() => grouping);
        let returnUnauthorizedDescriptor = false;
        const reconcileResource = vi.fn<
            AgentExternalSessionObservationContribution['reconcileResource']
        >(async (request) => {
            const result = await home.observation.reconcileResource(request);
            if (
                !returnUnauthorizedDescriptor
                || result.purpose !== 'resource_descriptors'
            ) {
                return result;
            }
            return {
                purpose: result.purpose,
                outcomes: result.outcomes.map((outcome) => outcome.kind === 'described'
                    ? {
                        kind: outcome.kind,
                        descriptor: {
                            ...outcome.descriptor,
                            watchFileChanges: { files: [outsideSourceFile] },
                        },
                    }
                    : outcome),
            };
        });
        const contribution: AgentExternalSessionObservationContribution = {
            describeResource,
            observeResource: async (request) =>
                await home.observation.observeResource(request),
            reconcileResource,
        };
        const fileCallbacks = new Map<string, (file: string) => void>();
        const initialWatcherDisposal = vi.fn();
        const watchFile = vi.fn((file: string, onChange: (file: string) => void) => {
            fileCallbacks.set(file, onChange);
            return initialWatcherDisposal;
        });
        const requestTranscriptRefresh = vi.fn();
        const projection = createExternalSessionObservationDaemonProjection({
            acquireObservationContribution: vi.fn(async () => ({
                contribution,
                filesystemReadAllowedPaths: new Set(['grant-present']),
                release: async () => {},
            })),
            publishField: vi.fn(async () => {}),
            watchFile,
            watchTopologyDirectory: vi.fn(() => vi.fn()),
            requestTranscriptRefresh,
            isTranscriptRefreshDemanded: () => false,
        });
        const sessionId = 'happier-session-grant-revalidation';
        const linkGeneration = 'grant-link-generation';
        const rootFile = home.rootFiles[0]!;
        await projection.reconcileLink({
            resource: {
                pluginId: 'happier.codex',
                agentLocalId: 'codex',
                pluginGeneration: 'grant-plugin-generation',
                resourceKey: grouping.resourceKey,
            },
            link: {
                sessionId,
                linkGeneration,
                linkKey: grouping.linkKey,
                linkedSource: identity,
            },
            target: {
                qualifiedLinkIdentity: {
                    v: 1,
                    agent: {
                        pluginId: 'happier.codex',
                        localId: 'codex',
                    },
                    source: {
                        kind: 'codexHome',
                        contractVersion: 1,
                    },
                },
                linkGeneration,
            },
            demand: {
                passiveEvent: true,
                persistedPolicy: false,
                fallbackDemand: false,
                transcriptDemand: false,
            },
        });

        await vi.waitFor(() => expect(watchFile).toHaveBeenCalledOnce());
        expect(reconcileResource.mock.calls.filter(
            ([request]) => request.purpose === 'resource_descriptors',
        )).toHaveLength(1);
        returnUnauthorizedDescriptor = true;
        fileCallbacks.get(rootFile)?.(rootFile);
        await vi.waitFor(() => {
            expect(describeResource).not.toHaveBeenCalled();
            expect(reconcileResource.mock.calls.filter(
                ([request]) => request.purpose === 'resource_descriptors',
            )).toHaveLength(2);
        }, { timeout: 30_000 });
        expect(reconcileResource.mock.calls.filter(
            ([request]) => request.purpose === 'resource_descriptors',
        )).toHaveLength(2);
        expect(watchFile).toHaveBeenCalledOnce();
        expect(fileCallbacks.has(outsideSourceFile)).toBe(false);
        expect(initialWatcherDisposal).not.toHaveBeenCalled();
        expect(requestTranscriptRefresh).not.toHaveBeenCalled();

        await projection.dispose();
        expect(initialWatcherDisposal).toHaveBeenCalledOnce();
    }, 60_000);
});
