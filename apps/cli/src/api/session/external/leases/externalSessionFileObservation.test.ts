import {
    appendFile,
    mkdir,
    mkdtemp,
    realpath,
    rename,
    rm,
    stat,
    unlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
    AgentExternalSessionObservationContribution,
    AgentExternalSessionsContribution,
    AgentExternalSessionsResolvedIdentity,
} from '@happier-dev/plugin-sdk/experimental/sessions';
import type {
    ExternalAgentObservationResourceDescriptorV1,
} from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { startFileWatcher } from '@/integrations/watcher/startFileWatcher';

import { createExternalSessionFollowLeaseManager } from './createExternalSessionFollowLeaseManager';
import {
    createExternalSessionObservationReconciler,
    type ExternalSessionObservationLinkIdentity,
    type ExternalSessionObservationResourceIdentity,
} from './createExternalSessionObservationReconciler';

type FileBackedFixture = Readonly<{
    root: string;
    file: string;
    pluginId: string;
    agentLocalId: string;
    identity: AgentExternalSessionsResolvedIdentity;
    observation: AgentExternalSessionObservationContribution;
    externalSessions: AgentExternalSessionsContribution;
    append(): Promise<void>;
    replace(): Promise<void>;
    recreate(): Promise<void>;
}>;

type ReadOutcome =
    | 'already_current'
    | 'advanced'
    | 'gap_or_cursor_expired'
    | 'source_replaced'
    | 'source_unavailable'
    | 'read_failed';

const roots: string[] = [];

function invocation(maxSerializedBytes = 524_288) {
    return {
        signal: new AbortController().signal,
        deadlineAtMs: Date.now() + 30_000,
        maxSerializedBytes,
    };
}

function jsonl(value: unknown): string {
    return `${JSON.stringify(value)}\n`;
}

async function resolveResourceDescriptor(
    observation: AgentExternalSessionObservationContribution,
    identity: AgentExternalSessionsResolvedIdentity,
): Promise<ExternalAgentObservationResourceDescriptorV1> {
    const grouping = observation.describeResource(identity);
    const result = await observation.reconcileResource({
        purpose: 'resource_descriptors',
        resourceKey: grouping.resourceKey,
        links: [{ linkKey: grouping.linkKey, linkedSource: identity }],
        signal: new AbortController().signal,
    });
    const outcome = result.purpose === 'resource_descriptors'
        ? result.outcomes[0]
        : undefined;
    if (outcome?.kind !== 'described') {
        throw new Error('Expected an authoritative observation resource descriptor');
    }
    return outcome.descriptor;
}

async function loadClaudeFactories() {
    const modulePath =
        '../../../../../../../packages/plugins/claude/src/agent/surfaces/sessions/external/contribution.js';
    const observationPath =
        '../../../../../../../packages/plugins/claude/src/agent/surfaces/sessions/external/observation.js';
    const [contributionModule, observationModule] = await Promise.all([
        import(modulePath),
        import(observationPath),
    ]);
    return {
        createExternalSessions:
            contributionModule.createClaudeExternalSessionsContribution as (
                params: Readonly<{ env: NodeJS.ProcessEnv }>,
            ) => AgentExternalSessionsContribution,
        createObservation:
            observationModule.createClaudeExternalSessionObservationContribution as (
                params: Readonly<{ env: NodeJS.ProcessEnv }>,
            ) => AgentExternalSessionObservationContribution,
    };
}

async function loadCodexFactories() {
    const modulePath =
        '../../../../../../../packages/plugins/codex/src/agent/surfaces/sessions/external/contribution.js';
    const observationPath =
        '../../../../../../../packages/plugins/codex/src/agent/surfaces/sessions/external/observation.js';
    const [contributionModule, observationModule] = await Promise.all([
        import(modulePath),
        import(observationPath),
    ]);
    return {
        createExternalSessions:
            contributionModule.createCodexExternalSessionsContribution as (
                params: Readonly<{
                    env: NodeJS.ProcessEnv;
                    activeServerDir: string;
                }>,
            ) => AgentExternalSessionsContribution,
        createObservation:
            observationModule.createCodexExternalSessionObservationContribution as (
                params: Readonly<{ env: NodeJS.ProcessEnv }>,
            ) => AgentExternalSessionObservationContribution,
    };
}

async function createClaudeFixture(): Promise<FileBackedFixture> {
    const { createExternalSessions, createObservation } =
        await loadClaudeFactories();
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-file-observation-'));
    roots.push(root);
    const configDir = join(root, '.claude');
    const projectId = 'project-a';
    const remoteSessionId = 'session-a';
    const transcriptDir = join(configDir, 'projects', projectId);
    const file = join(transcriptDir, `${remoteSessionId}.jsonl`);
    await mkdir(transcriptDir, { recursive: true });
    const initial = [
        jsonl({
            type: 'user',
            uuid: 'claude-user-1',
            timestamp: '2026-07-25T12:00:00.000Z',
            cwd: '/work/project-a',
            message: { content: 'initial Claude prompt' },
        }),
        jsonl({
            type: 'assistant',
            uuid: 'claude-agent-1',
            timestamp: '2026-07-25T12:00:01.000Z',
            message: {
                content: [{ type: 'text', text: 'initial Claude answer' }],
            },
        }),
    ].join('');
    await writeFile(file, initial, 'utf8');
    const canonicalFile = await realpath(file);
    const env = { HAPPIER_CLAUDE_CONFIG_DIR: configDir };
    const source = {
        kind: 'claudeConfig',
        configDir,
        projectId,
    } as const;
    return {
        root,
        file: canonicalFile,
        pluginId: 'happier.claude',
        agentLocalId: 'claude',
        identity: {
            source,
            remoteSessionId,
            linkData: { projectId },
        },
        observation: createObservation({ env }),
        externalSessions: createExternalSessions({ env }),
        append: async () => {
            await appendFile(canonicalFile, jsonl({
                type: 'assistant',
                uuid: `claude-agent-append-${Date.now()}`,
                timestamp: '2026-07-25T12:00:02.000Z',
                message: {
                    content: [{ type: 'text', text: 'appended Claude answer' }],
                },
            }), 'utf8');
        },
        replace: async () => {
            const replacement = `${canonicalFile}.replacement`;
            await writeFile(replacement, `${initial}${jsonl({
                type: 'assistant',
                uuid: 'claude-agent-replacement',
                timestamp: '2026-07-25T12:00:03.000Z',
                message: {
                    content: [{ type: 'text', text: 'replacement Claude answer' }],
                },
            })}`, 'utf8');
            await rename(replacement, canonicalFile);
        },
        recreate: async () => {
            await writeFile(canonicalFile, `${initial}${jsonl({
                type: 'assistant',
                uuid: 'claude-agent-recreated',
                timestamp: '2026-07-25T12:00:04.000Z',
                message: {
                    content: [{ type: 'text', text: 'recreated Claude answer' }],
                },
            })}`, 'utf8');
        },
    };
}

async function createCodexFixture(): Promise<FileBackedFixture> {
    const { createExternalSessions, createObservation } =
        await loadCodexFactories();
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-file-observation-'));
    roots.push(root);
    const codexHome = join(root, 'codex-home');
    const remoteSessionId = '11111111-1111-1111-1111-111111111111';
    const sessionsDir = join(codexHome, 'sessions', '2026', '07', '25');
    const file = join(
        sessionsDir,
        `rollout-2026-07-25T12-00-00-${remoteSessionId}.jsonl`,
    );
    await mkdir(sessionsDir, { recursive: true });
    const initial = [
        jsonl({
            type: 'session_meta',
            timestamp: '2026-07-25T12:00:00.000Z',
            payload: {
                id: remoteSessionId,
                timestamp: '2026-07-25T12:00:00.000Z',
                cwd: '/work/codex',
            },
        }),
        jsonl({
            type: 'response_item',
            timestamp: '2026-07-25T12:00:01.000Z',
            payload: {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'initial Codex answer' }],
            },
        }),
    ].join('');
    await writeFile(file, initial, 'utf8');
    const canonicalFile = await realpath(file);
    const env = { CODEX_HOME: codexHome } as NodeJS.ProcessEnv;
    const source = {
        kind: 'codexHome',
        home: 'user',
        homePath: codexHome,
    } as const;
    return {
        root,
        file: canonicalFile,
        pluginId: 'happier.codex',
        agentLocalId: 'codex',
        identity: {
            source,
            remoteSessionId,
            linkData: { source },
        },
        observation: createObservation({ env }),
        externalSessions: createExternalSessions({
            env,
            activeServerDir: join(root, 'active-server'),
        }),
        append: async () => {
            await appendFile(canonicalFile, jsonl({
                type: 'response_item',
                timestamp: '2026-07-25T12:00:02.000Z',
                payload: {
                    type: 'message',
                    role: 'assistant',
                    content: [{
                        type: 'output_text',
                        text: 'appended Codex answer',
                    }],
                },
            }), 'utf8');
        },
        replace: async () => {
            const replacement = `${canonicalFile}.replacement`;
            await writeFile(replacement, `${initial}${jsonl({
                type: 'response_item',
                timestamp: '2026-07-25T12:00:03.000Z',
                payload: {
                    type: 'message',
                    role: 'assistant',
                    content: [{
                        type: 'output_text',
                        text: 'replacement Codex answer',
                    }],
                },
            })}`, 'utf8');
            await rename(replacement, canonicalFile);
        },
        recreate: async () => {
            await writeFile(canonicalFile, `${initial}${jsonl({
                type: 'response_item',
                timestamp: '2026-07-25T12:00:04.000Z',
                payload: {
                    type: 'message',
                    role: 'assistant',
                    content: [{
                        type: 'output_text',
                        text: 'recreated Codex answer',
                    }],
                },
            })}`, 'utf8');
        },
    };
}

async function runFileObservationScenario(
    fixture: FileBackedFixture,
): Promise<void> {
    const firstDescriptor = await resolveResourceDescriptor(
        fixture.observation,
        fixture.identity,
    );
    if (firstDescriptor.changeObservation !== 'watch_file_changes') {
        throw new Error('Expected file-backed external session observation');
    }
    const watchedFile = firstDescriptor.watchFileChanges.files[0];
    if (!watchedFile) {
        throw new Error('Expected an external session observation file');
    }
    expect(await realpath(watchedFile)).toBe(await realpath(fixture.file));
    expect(firstDescriptor.resourceKey).not.toContain(fixture.root);
    expect(firstDescriptor.linkKey).not.toContain(fixture.root);

    const initialPage = await fixture.externalSessions.pageTranscript({
        ...invocation(),
        source: fixture.identity.source,
        remoteSessionId: fixture.identity.remoteSessionId,
        direction: 'older',
        maxItems: 200,
    });
    expect(initialPage).toMatchObject({
        ok: true,
        value: { tailCursor: expect.any(String) },
    });
    if (!initialPage.ok || !initialPage.value.tailCursor) {
        throw new Error('Expected an authoritative initial transcript cursor');
    }

    let cursor = initialPage.value.tailCursor;
    let activeReads = 0;
    let maximumConcurrentReads = 0;
    const outcomes: ReadOutcome[] = [];
    const readLimits: number[] = [];
    const retirement = new AbortController();
    const resource = {
        linkGeneration: 'link-generation-1',
        pluginGeneration: 'plugin-generation-1',
        retirementSignal: retirement.signal,
    };
    const manager = createExternalSessionFollowLeaseManager();
    const releaseFollowLease = vi.fn(async () => {});
    await manager.attach({
        sessionId: 'session-1',
        leaseId: 'viewer-1',
        ttlMs: 60_000,
        resource,
        acquireFollowLease: async () => ({
            release: releaseFollowLease,
            requestTranscriptRefresh: async () => {
                activeReads += 1;
                maximumConcurrentReads = Math.max(
                    maximumConcurrentReads,
                    activeReads,
                );
                try {
                    await new Promise((resolve) => setTimeout(resolve, 20));
                    readLimits.push(200);
                    const result =
                        await fixture.externalSessions.readAfterTranscript({
                            ...invocation(),
                            source: fixture.identity.source,
                            remoteSessionId: fixture.identity.remoteSessionId,
                            cursor,
                            maxItems: 200,
                        });
                    if (!result.ok) {
                        outcomes.push('read_failed');
                        return;
                    }
                    outcomes.push(result.value.outcome);
                    if (result.value.outcome === 'advanced') {
                        cursor = result.value.nextCursor;
                    }
                } finally {
                    activeReads -= 1;
                }
            },
        }),
    });

    let watcherDisposals = 0;
    let watchedFileChanges = 0;
    let refreshRequests = 0;
    let descriptorReconciliations = 0;
    let transcriptDemandChecks = 0;
    let lastTranscriptDemand = false;
    const reconciler = createExternalSessionObservationReconciler({
        acquireObserver: async () => ({ dispose: async () => {} }),
        watchFile: (file, onChange, options) => {
            const stop = startFileWatcher(file, (changedFile) => {
                watchedFileChanges += 1;
                onChange(changedFile);
            }, options);
            return () => {
                watcherDisposals += 1;
                stop();
            };
        },
        requestTranscriptRefresh: async (input) => {
            refreshRequests += 1;
            return await manager.requestTranscriptRefresh(input);
        },
        isTranscriptRefreshDemanded: (input) => {
            transcriptDemandChecks += 1;
            lastTranscriptDemand = manager.hasTranscriptDemand(input);
            return lastTranscriptDemand;
        },
        reconcileResource: async (input) => {
            if (input.purpose === 'resource_descriptors') {
                descriptorReconciliations += 1;
            }
            return await fixture.observation.reconcileResource({
                purpose: input.purpose,
                resourceKey: input.resource.resourceKey,
                links: input.links,
                signal: input.signal,
            });
        },
    });
    const observationResource: ExternalSessionObservationResourceIdentity = {
        pluginId: fixture.pluginId,
        agentLocalId: fixture.agentLocalId,
        pluginGeneration: resource.pluginGeneration,
        resourceKey: firstDescriptor.resourceKey,
        retirementSignal: retirement.signal,
    };
    const observationLink: ExternalSessionObservationLinkIdentity = {
        sessionId: 'session-1',
        linkGeneration: resource.linkGeneration,
        linkKey: firstDescriptor.linkKey,
        linkedSource: fixture.identity,
        changeObservation: 'watch_file_changes',
        watchFileChanges: firstDescriptor.watchFileChanges,
    };
    await reconciler.reconcileLink({
        resource: observationResource,
        link: observationLink,
        demand: {
            passiveEvent: true,
            persistedPolicy: false,
            fallbackDemand: false,
            transcriptDemand: true,
        },
        onFacts: () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 150));

    await fixture.append();
    await vi.waitFor(() => expect(outcomes).toContain('advanced'), {
        timeout: 10_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));

    const readsBeforeReplacement = readLimits.length;
    const changesBeforeReplacement = watchedFileChanges;
    const requestsBeforeReplacement = refreshRequests;
    const descriptorReconciliationsBeforeReplacement =
        descriptorReconciliations;
    const demandChecksBeforeReplacement = transcriptDemandChecks;
    await fixture.replace();
    await vi.waitFor(
        () => expect(watchedFileChanges).toBeGreaterThan(changesBeforeReplacement),
        { timeout: 10_000 },
    );
    await vi.waitFor(
        () => expect(descriptorReconciliations).toBeGreaterThan(
            descriptorReconciliationsBeforeReplacement,
        ),
        { timeout: 10_000 },
    );
    await vi.waitFor(
        () => expect(transcriptDemandChecks).toBeGreaterThan(demandChecksBeforeReplacement),
        { timeout: 10_000 },
    );
    expect(lastTranscriptDemand).toBe(true);
    await vi.waitFor(
        () => expect(refreshRequests).toBeGreaterThan(requestsBeforeReplacement),
        { timeout: 10_000 },
    );
    await vi.waitFor(
        () => expect(readLimits.length).toBeGreaterThan(readsBeforeReplacement),
        { timeout: 10_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 200));

    const readsBeforeDeletion = readLimits.length;
    await unlink(fixture.file);
    await vi.waitFor(
        () => expect(readLimits.length).toBeGreaterThan(readsBeforeDeletion),
        { timeout: 10_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 200));

    const readsBeforeRecreation = readLimits.length;
    const changesBeforeRecreation = watchedFileChanges;
    await fixture.recreate();
    await vi.waitFor(
        () => expect(watchedFileChanges).toBeGreaterThan(changesBeforeRecreation),
        { timeout: 10_000 },
    );
    await vi.waitFor(
        () => expect(readLimits.length).toBeGreaterThan(readsBeforeRecreation),
        { timeout: 10_000 },
    );

    expect(readLimits.length).toBeGreaterThan(0);
    expect(readLimits.every((limit) => limit === 200)).toBe(true);
    expect(maximumConcurrentReads).toBe(1);
    expect(outcomes.slice(readsBeforeReplacement)).toEqual(
        expect.arrayContaining([
            expect.stringMatching(
                /source_replaced|source_unavailable|gap_or_cursor_expired|read_failed/u,
            ),
        ]),
    );

    await vi.waitFor(() => expect(activeReads).toBe(0));
    retirement.abort();
    await vi.waitFor(() => expect(watcherDisposals).toBeGreaterThanOrEqual(1));
    await vi.waitFor(() => expect(releaseFollowLease).toHaveBeenCalledOnce());
    const readsAfterRetirement = outcomes.length;
    await appendFile(fixture.file, '\n', 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(outcomes).toHaveLength(readsAfterRetirement);

    await reconciler.dispose();
    await manager.dispose();
}

describe('source-backed External Session file observation', () => {
    afterEach(async () => {
        await Promise.all(roots.splice(0).map(async (root) => {
            await rm(root, { recursive: true, force: true });
        }));
        vi.restoreAllMocks();
    });

    it('routes Claude append, replacement, deletion, and recreation through demanded bounded readAfter', async () => {
        await runFileObservationScenario(await createClaudeFixture());
    }, 30_000);

    it('routes Codex append, replacement, deletion, and recreation through demanded bounded readAfter', async () => {
        await runFileObservationScenario(await createCodexFixture());
    }, 30_000);

    it('discovers a delayed Codex child through topology re-description and follows its exact file', async () => {
        const { createExternalSessions, createObservation } =
            await loadCodexFactories();
        const root = await realpath(await mkdtemp(
            join(tmpdir(), 'happier-codex-delayed-child-observation-'),
        ));
        roots.push(root);
        const codexHome = join(root, 'codex-home');
        const sessionsDir = join(codexHome, 'sessions', '2026', '07', '25');
        const rootSessionId = '11111111-1111-1111-1111-111111111111';
        const childSessionId = '22222222-2222-2222-2222-222222222222';
        const unrelatedChildSessionId =
            '33333333-3333-3333-3333-333333333333';
        const rootFile = join(
            sessionsDir,
            `rollout-2026-07-25T12-00-00-${rootSessionId}.jsonl`,
        );
        const childFile = join(
            sessionsDir,
            `rollout-2026-07-25T12-00-02-${childSessionId}.jsonl`,
        );
        const unrelatedChildFile = join(
            sessionsDir,
            `rollout-2026-07-25T12-00-04-${unrelatedChildSessionId}.jsonl`,
        );
        await mkdir(sessionsDir, { recursive: true });
        await writeFile(rootFile, [
            jsonl({
                type: 'session_meta',
                timestamp: '2026-07-25T12:00:00.000Z',
                payload: {
                    id: rootSessionId,
                    timestamp: '2026-07-25T12:00:00.000Z',
                    cwd: '/work/codex-delayed-child',
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
                        text: 'root answer before child creation',
                    }],
                },
            }),
            jsonl({
                type: 'event_msg',
                timestamp: '2026-07-25T12:00:01.500Z',
                payload: {
                    type: 'collab_agent_spawn_end',
                    new_thread_id: childSessionId,
                    new_agent_nickname: 'Child',
                    new_agent_role: 'explorer',
                    prompt: 'inspect the repository',
                },
            }),
        ].join(''), 'utf8');

        const env = { CODEX_HOME: codexHome } as NodeJS.ProcessEnv;
        const source = {
            kind: 'codexHome',
            home: 'user',
            homePath: codexHome,
        } as const;
        const linkedSource: AgentExternalSessionsResolvedIdentity = {
            source,
            remoteSessionId: rootSessionId,
            linkData: { source },
        };
        const observation = createObservation({ env });
        const externalSessions = createExternalSessions({
            env,
            activeServerDir: join(root, 'active-server'),
        });
        const descriptor = await resolveResourceDescriptor(
            observation,
            linkedSource,
        );
        expect(descriptor).toMatchObject({
            changeObservation: 'watch_file_changes',
            watchFileChanges: {
                files: [rootFile],
                topologyDirectories: [
                    join(codexHome, 'archived_sessions'),
                    join(codexHome, 'sessions'),
                ],
            },
        });
        if (descriptor.changeObservation !== 'watch_file_changes') {
            throw new Error('Expected Codex file-change observation');
        }

        const initialPage = await externalSessions.pageTranscript({
            ...invocation(),
            source,
            remoteSessionId: rootSessionId,
            direction: 'older',
            maxItems: 200,
        });
        if (!initialPage.ok || !initialPage.value.tailCursor) {
            throw new Error('Expected the current root transcript cursor');
        }

        let cursor = initialPage.value.tailCursor;
        const deliveredMessages: Array<Readonly<{
            message: string;
            sidechainId?: string;
        }>> = [];
        const isCodexMessageBody = (
            value: unknown,
        ): value is Readonly<{
            type: 'message';
            message: string;
            sidechainId?: string;
        }> => {
            if (
                typeof value !== 'object'
                || value === null
                || Array.isArray(value)
            ) {
                return false;
            }
            const outer = value as Record<string, unknown>;
            return (
                outer.type === 'message'
                && typeof outer.message === 'string'
                && (
                    outer.sidechainId === undefined
                    || typeof outer.sidechainId === 'string'
                )
            );
        };
        const readAfterLimits: number[] = [];
        const retirement = new AbortController();
        const resource = {
            linkGeneration: 'delayed-child-link-generation',
            pluginGeneration: 'delayed-child-plugin-generation',
            retirementSignal: retirement.signal,
        };
        const manager = createExternalSessionFollowLeaseManager();
        await manager.attach({
            sessionId: 'delayed-child-session',
            leaseId: 'delayed-child-viewer',
            ttlMs: 60_000,
            resource,
            acquireFollowLease: async () => ({
                release: async () => {},
                requestTranscriptRefresh: async () => {
                    readAfterLimits.push(200);
                    const result = await externalSessions.readAfterTranscript({
                        ...invocation(),
                        source,
                        remoteSessionId: rootSessionId,
                        cursor,
                        maxItems: 200,
                    });
                    if (!result.ok || result.value.outcome !== 'advanced') {
                        return;
                    }
                    cursor = result.value.nextCursor;
                    for (const item of result.value.items) {
                        if (!isCodexMessageBody(item.raw)) {
                            continue;
                        }
                        deliveredMessages.push({
                            message: item.raw.message,
                            ...(item.raw.sidechainId
                                ? {
                                    sidechainId: item.raw.sidechainId,
                                }
                                : {}),
                        });
                    }
                },
            }),
        });

        const watchedFiles = new Set<string>();
        const watchedTopologyDirectories = new Set<string>();
        const topologyCallbacks = new Map<
            string,
            (changedPath?: string) => void
        >();
        let descriptorBatches = 0;
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver: async () => ({ dispose: async () => {} }),
            watchFile: (file, onChange, options) => {
                watchedFiles.add(file);
                return startFileWatcher(file, onChange, options);
            },
            watchTopologyDirectory: (
                directory,
                onStructuralChange,
            ) => {
                watchedTopologyDirectories.add(directory);
                topologyCallbacks.set(directory, onStructuralChange);
                return () => {
                    if (topologyCallbacks.get(directory) === onStructuralChange) {
                        topologyCallbacks.delete(directory);
                    }
                };
            },
            requestTranscriptRefresh: async (input) =>
                await manager.requestTranscriptRefresh(input),
            isTranscriptRefreshDemanded: (input) =>
                manager.hasTranscriptDemand(input),
            reconcileResource: async (input) => {
                if (input.purpose === 'resource_descriptors') {
                    descriptorBatches += 1;
                }
                return await observation.reconcileResource({
                    purpose: input.purpose,
                    resourceKey: input.resource.resourceKey,
                    links: input.links,
                    signal: input.signal,
                });
            },
        });
        try {
            await reconciler.reconcileLink({
                resource: {
                    pluginId: 'happier.codex',
                    agentLocalId: 'codex',
                    pluginGeneration: resource.pluginGeneration,
                    resourceKey: descriptor.resourceKey,
                    retirementSignal: retirement.signal,
                },
                link: {
                    sessionId: 'delayed-child-session',
                    linkGeneration: resource.linkGeneration,
                    linkKey: descriptor.linkKey,
                    linkedSource,
                    changeObservation: 'watch_file_changes',
                    watchFileChanges: descriptor.watchFileChanges,
                },
                demand: {
                    passiveEvent: true,
                    persistedPolicy: false,
                    fallbackDemand: false,
                    transcriptDemand: true,
                },
                onFacts: () => {},
            });
            await vi.waitFor(() => {
                expect(watchedFiles).toContain(rootFile);
                expect([...watchedTopologyDirectories].sort()).toEqual(
                    descriptor.watchFileChanges.topologyDirectories,
                );
            }, { timeout: 10_000 });
            await new Promise((resolve) => setTimeout(resolve, 250));

            const parentBeforeChild = await stat(rootFile);
            const descriptorBatchesBeforeChild = descriptorBatches;
            const readsBeforeChild = readAfterLimits.length;
            await writeFile(childFile, jsonl({
                type: 'session_meta',
                timestamp: '2026-07-25T12:00:02.000Z',
                payload: {
                    id: childSessionId,
                    session_id: rootSessionId,
                    timestamp: '2026-07-25T12:00:02.000Z',
                    cwd: '/work/codex-delayed-child',
                },
            }), 'utf8');
            await appendFile(childFile, jsonl({
                type: 'response_item',
                timestamp: '2026-07-25T12:00:03.000Z',
                payload: {
                    type: 'message',
                    role: 'assistant',
                    content: [{
                        type: 'output_text',
                        text: 'delayed child first answer',
                    }],
                },
            }), 'utf8');
            topologyCallbacks.get(join(codexHome, 'sessions'))?.(childFile);

            await vi.waitFor(() => {
                expect(descriptorBatches).toBeGreaterThan(
                    descriptorBatchesBeforeChild,
                );
                expect(watchedFiles).toContain(childFile);
                expect(readAfterLimits.length).toBeGreaterThan(readsBeforeChild);
                expect(deliveredMessages.filter(
                    ({ message }) => message === 'delayed child first answer',
                )).toHaveLength(1);
            }, { timeout: 10_000 });
            expect(deliveredMessages).toContainEqual({
                message: 'delayed child first answer',
                sidechainId: childSessionId,
            });
            const parentAfterChild = await stat(rootFile);
            expect({
                size: parentAfterChild.size,
                mtimeMs: parentAfterChild.mtimeMs,
            }).toEqual({
                size: parentBeforeChild.size,
                mtimeMs: parentBeforeChild.mtimeMs,
            });

            await new Promise((resolve) => setTimeout(resolve, 250));
            const readsBeforeSecondChildItem = readAfterLimits.length;
            await appendFile(childFile, jsonl({
                type: 'response_item',
                timestamp: '2026-07-25T12:00:04.000Z',
                payload: {
                    type: 'message',
                    role: 'assistant',
                    content: [{
                        type: 'output_text',
                        text: 'delayed child second answer',
                    }],
                },
            }), 'utf8');
            await vi.waitFor(() => {
                expect(readAfterLimits.length).toBeGreaterThan(
                    readsBeforeSecondChildItem,
                );
                expect(deliveredMessages.filter(
                    ({ message }) => message === 'delayed child second answer',
                )).toHaveLength(1);
            }, { timeout: 10_000 });
            expect(deliveredMessages).toContainEqual({
                message: 'delayed child second answer',
                sidechainId: childSessionId,
            });

            await new Promise((resolve) => setTimeout(resolve, 250));
            const descriptorBatchesBeforeUnrelated = descriptorBatches;
            const readsBeforeUnrelated = readAfterLimits.length;
            await writeFile(unrelatedChildFile, [
                jsonl({
                    type: 'session_meta',
                    timestamp: '2026-07-25T12:00:05.000Z',
                    payload: {
                        id: unrelatedChildSessionId,
                        session_id:
                            '44444444-4444-4444-4444-444444444444',
                        timestamp: '2026-07-25T12:00:05.000Z',
                        cwd: '/work/unrelated-root',
                    },
                }),
                jsonl({
                    type: 'response_item',
                    timestamp: '2026-07-25T12:00:06.000Z',
                    payload: {
                        type: 'message',
                        role: 'assistant',
                        content: [{
                            type: 'output_text',
                            text: 'unrelated child answer',
                        }],
                    },
                }),
            ].join(''), 'utf8');
            topologyCallbacks.get(join(codexHome, 'sessions'))?.(
                unrelatedChildFile,
            );
            await vi.waitFor(
                () => expect(descriptorBatches).toBeGreaterThan(
                    descriptorBatchesBeforeUnrelated,
                ),
                { timeout: 10_000 },
            );
            await new Promise((resolve) => setTimeout(resolve, 300));
            expect(watchedFiles).not.toContain(unrelatedChildFile);
            expect(readAfterLimits).toHaveLength(readsBeforeUnrelated);
            expect(deliveredMessages).not.toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        message: 'unrelated child answer',
                    }),
                ]),
            );
            expect(readAfterLimits.every((limit) => limit === 200)).toBe(true);
        } finally {
            retirement.abort();
            await reconciler.dispose();
            await manager.dispose();
        }
    }, 30_000);
});
