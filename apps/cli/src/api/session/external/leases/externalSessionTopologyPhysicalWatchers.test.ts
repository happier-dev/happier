import {
    mkdir,
    mkdtemp,
    realpath,
    rm,
    symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
    FSWatcher,
    WatchListener,
    WatchOptions,
} from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    createExternalSessionObservationReconciler,
    type ExternalSessionObservationLinkIdentity,
    type ExternalSessionObservationResourceIdentity,
} from './createExternalSessionObservationReconciler';

const watchBoundary = vi.hoisted(() => ({
    watch: vi.fn(),
}));

vi.mock('node:fs', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    return {
        ...actual,
        watch: watchBoundary.watch,
    };
});

type PhysicalRegistration = Readonly<{
    path: string;
    options: WatchOptions;
    listener: WatchListener<string>;
    close: ReturnType<typeof vi.fn>;
    errorListeners: Array<(error: Error) => void>;
}>;

const fixtureRoots: string[] = [];

function createFakeWatchBoundary(): PhysicalRegistration[] {
    const registrations: PhysicalRegistration[] = [];
    watchBoundary.watch.mockReset();
    watchBoundary.watch.mockImplementation((
        path: string,
        options: WatchOptions,
        listener: WatchListener<string>,
    ): FSWatcher => {
        const errorListeners: Array<(error: Error) => void> = [];
        const close = vi.fn();
        const watcher = {
            close,
            on: vi.fn((event: string, callback: (error: Error) => void) => {
                if (event === 'error') {
                    errorListeners.push(callback);
                }
                return watcher;
            }),
        } as unknown as FSWatcher;
        registrations.push({
            path,
            options,
            listener,
            close,
            errorListeners,
        });
        return watcher;
    });
    return registrations;
}

async function createHome(name: string) {
    const root = await realpath(
        await mkdtemp(join(tmpdir(), `happier-topology-pool-${name}-`)),
    );
    fixtureRoots.push(root);
    const home = join(root, 'codex-home');
    const sessions = join(home, 'sessions');
    const archivedSessions = join(home, 'archived_sessions');
    await Promise.all([
        mkdir(sessions, { recursive: true }),
        mkdir(archivedSessions, { recursive: true }),
    ]);
    return { home, sessions, archivedSessions };
}

function resource(
    key: string,
): ExternalSessionObservationResourceIdentity {
    return {
        pluginId: 'happier.codex',
        agentLocalId: 'codex',
        pluginGeneration: 'generation-1',
        resourceKey: key,
    };
}

function link(
    sessionId: string,
    home: Awaited<ReturnType<typeof createHome>>,
): ExternalSessionObservationLinkIdentity {
    return {
        sessionId,
        linkGeneration: 'link-generation-1',
        linkKey: `native-${sessionId}`,
        linkedSource: {
            source: {
                kind: 'codexHome',
                home: 'user',
                homePath: home.home,
            },
            remoteSessionId: `native-${sessionId}`,
            linkData: {},
        },
        changeObservation: 'watch_file_changes',
        watchFileChanges: {
            files: [join(home.sessions, `${sessionId}.jsonl`)],
            topologyDirectories: [
                home.sessions,
                home.archivedSessions,
            ],
        },
    };
}

async function addHome(
    reconciler: ReturnType<typeof createExternalSessionObservationReconciler>,
    home: Awaited<ReturnType<typeof createHome>>,
    index: number,
): Promise<ExternalSessionObservationLinkIdentity> {
    const watchedLink = link(`session-${index}`, home);
    await reconciler.reconcileLink({
        resource: resource(`codex-home-${index}`),
        link: watchedLink,
        demand: {
            passiveEvent: true,
            persistedPolicy: false,
            fallbackDemand: false,
        },
        onFacts: () => {},
    });
    return watchedLink;
}

afterEach(async () => {
    await Promise.all(fixtureRoots.splice(0).map((root) =>
        rm(root, { recursive: true, force: true })
    ));
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('External Sessions topology physical watcher pooling', () => {
    it.each(['target', 'parent'] as const)(
        'reacquires the complete watcher batch after a transient %s error only when demand re-enters',
        async (failedWatcherKind) => {
            vi.useFakeTimers({
                toFake: ['setTimeout', 'clearTimeout'],
            });
            const registrations = createFakeWatchBoundary();
            const reconcileResource = vi.fn(async (input: Readonly<{
                purpose: 'observation_evidence' | 'resource_descriptors';
                resource: ExternalSessionObservationResourceIdentity;
                links: readonly ExternalSessionObservationLinkIdentity[];
            }>) => input.purpose === 'resource_descriptors'
                ? {
                    purpose: 'resource_descriptors' as const,
                    outcomes: input.links.map((current) => ({
                        kind: 'described' as const,
                        descriptor: {
                            resourceKey: input.resource.resourceKey,
                            linkKey: current.linkKey,
                            changeObservation: 'watch_file_changes' as const,
                            watchFileChanges: current.watchFileChanges!,
                        },
                    })),
                }
                : {
                    purpose: 'observation_evidence' as const,
                    outcomes: [],
                });
            const reconciler = createExternalSessionObservationReconciler({
                acquireObserver: vi.fn(async () => ({ dispose: vi.fn() })),
                watchFile: vi.fn(() => vi.fn()),
                reconcileResource,
            });
            const home = await createHome(`recover-${failedWatcherKind}`);
            const watchedLink = await addHome(reconciler, home, 1);
            await Promise.resolve();
            await Promise.resolve();
            expect(registrations).toHaveLength(3);
            reconcileResource.mockClear();

            const failedRegistration = registrations.find(
                ({ path, options }) => failedWatcherKind === 'target'
                    ? path === home.sessions && options.recursive === true
                    : path === home.home && options.recursive !== true,
            );
            expect(failedRegistration).toBeDefined();
            for (const onError of failedRegistration?.errorListeners ?? []) {
                onError(Object.assign(new Error('descriptor limit'), {
                    code: 'EMFILE',
                }));
            }
            await Promise.resolve();
            await Promise.resolve();

            expect(registrations).toHaveLength(3);
            expect(vi.getTimerCount()).toBe(0);
            expect(reconcileResource).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(120_000);
            expect(registrations).toHaveLength(3);
            expect(reconcileResource).not.toHaveBeenCalled();

            await addHome(reconciler, home, 1);
            await Promise.resolve();
            await Promise.resolve();
            await new Promise<void>((resolve) => setImmediate(resolve));
            await Promise.resolve();

            expect(registrations).toHaveLength(6);
            expect(reconcileResource).toHaveBeenCalledOnce();
            expect(reconcileResource).toHaveBeenCalledWith(
                expect.objectContaining({
                    purpose: 'resource_descriptors',
                    links: [expect.objectContaining({
                        sessionId: watchedLink.sessionId,
                    })],
                }),
            );
            for (const registration of registrations.slice(0, 3)) {
                expect(registration.close).toHaveBeenCalledOnce();
            }

            await reconciler.removeLink(watchedLink);
            await reconciler.dispose();
            for (const registration of registrations.slice(3)) {
                expect(registration.close).toHaveBeenCalledOnce();
            }
        },
    );

    it('holds persistent EMFILE recovery until a later demand reconciliation, then catches up once', async () => {
        vi.useFakeTimers({
            toFake: ['setTimeout', 'clearTimeout'],
        });
        const registrations: PhysicalRegistration[] = [];
        let failRecursiveAttachments = true;
        watchBoundary.watch.mockReset();
        watchBoundary.watch.mockImplementation((
            path: string,
            options: WatchOptions,
            listener: WatchListener<string>,
        ): FSWatcher => {
            if (options.recursive === true && failRecursiveAttachments) {
                throw Object.assign(new Error('descriptor limit'), {
                    code: 'EMFILE',
                });
            }
            const errorListeners: Array<(error: Error) => void> = [];
            const close = vi.fn();
            const watcher = {
                close,
                on: vi.fn((event: string, callback: (error: Error) => void) => {
                    if (event === 'error') {
                        errorListeners.push(callback);
                    }
                    return watcher;
                }),
            } as unknown as FSWatcher;
            registrations.push({
                path,
                options,
                listener,
                close,
                errorListeners,
            });
            return watcher;
        });
        const reconcileResource = vi.fn(async (input: Readonly<{
            purpose: 'observation_evidence' | 'resource_descriptors';
            resource: ExternalSessionObservationResourceIdentity;
            links: readonly ExternalSessionObservationLinkIdentity[];
        }>) => input.purpose === 'resource_descriptors'
            ? {
                purpose: 'resource_descriptors' as const,
                outcomes: input.links.map((current) => ({
                    kind: 'described' as const,
                    descriptor: {
                        resourceKey: input.resource.resourceKey,
                        linkKey: current.linkKey,
                        changeObservation: 'watch_file_changes' as const,
                        watchFileChanges: current.watchFileChanges!,
                    },
                })),
            }
            : {
                purpose: 'observation_evidence' as const,
                outcomes: [],
            });
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver: vi.fn(async () => ({ dispose: vi.fn() })),
            watchFile: vi.fn(() => vi.fn()),
            reconcileResource,
        });
        const home = await createHome('persistent-emfile');
        const watchedLink = await addHome(reconciler, home, 1);
        await Promise.resolve();
        await Promise.resolve();
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(watchBoundary.watch).toHaveBeenCalledTimes(3);
        expect(registrations).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(0);
        expect(reconcileResource).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(120_000);
        await Promise.resolve();
        await Promise.resolve();
        expect(watchBoundary.watch).toHaveBeenCalledTimes(3);
        expect(registrations).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(0);
        expect(reconcileResource).not.toHaveBeenCalled();

        failRecursiveAttachments = false;
        await addHome(reconciler, home, 1);
        await Promise.resolve();
        await Promise.resolve();
        await new Promise<void>((resolve) => setImmediate(resolve));
        await Promise.resolve();

        expect(watchBoundary.watch).toHaveBeenCalledTimes(6);
        expect(registrations).toHaveLength(4);
        expect(reconcileResource).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);

        await reconciler.removeLink(watchedLink);
        await reconciler.dispose();
        for (const registration of registrations) {
            expect(registration.close).toHaveBeenCalledOnce();
        }
    });

    it('uses one parent sentinel plus two recursive target watchers per Codex home', async () => {
        const registrations = createFakeWatchBoundary();
        const reconcileResource = vi.fn(async (input: Readonly<{
            purpose: 'observation_evidence' | 'resource_descriptors';
            resource: ExternalSessionObservationResourceIdentity;
            links: readonly ExternalSessionObservationLinkIdentity[];
        }>) => input.purpose === 'resource_descriptors'
            ? {
                purpose: 'resource_descriptors' as const,
                outcomes: input.links.map((current) => ({
                    kind: 'described' as const,
                    descriptor: {
                        resourceKey: input.resource.resourceKey,
                        linkKey: current.linkKey,
                        changeObservation: 'watch_file_changes' as const,
                        watchFileChanges: current.watchFileChanges!,
                    },
                })),
            }
            : {
                purpose: 'observation_evidence' as const,
                outcomes: [],
            });
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver: vi.fn(async () => ({ dispose: vi.fn() })),
            watchFile: vi.fn(() => vi.fn()),
            reconcileResource,
        });
        const firstHome = await createHome('one');
        const firstLink = await addHome(reconciler, firstHome, 1);

        expect(registrations).toHaveLength(3);
        expect(registrations.filter(({ path, options }) =>
            path === firstHome.home && options.recursive !== true
        )).toHaveLength(1);
        expect(registrations.filter(({ path, options }) =>
            (
                path === firstHome.sessions
                || path === firstHome.archivedSessions
            )
            && options.recursive === true
        )).toHaveLength(2);

        const firstParentRegistration = registrations.find(
            ({ path, options }) =>
                path === firstHome.home && options.recursive !== true,
        );
        expect(firstParentRegistration).toBeDefined();
        firstParentRegistration?.listener('rename', 'archived_sessions');
        await vi.waitFor(() => {
            expect(registrations.filter(({ path, options }) =>
                path === firstHome.archivedSessions
                && options.recursive === true
            )).toHaveLength(2);
        });
        expect(registrations.filter(({ path, options }) =>
            path === firstHome.sessions && options.recursive === true
        )).toHaveLength(1);

        await rm(firstHome.sessions, { recursive: true });
        firstParentRegistration?.listener('rename', 'sessions');
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(registrations.filter(({ path, options }) =>
            path === firstHome.sessions && options.recursive === true
        )).toHaveLength(1);

        const outside = join(firstHome.home, 'outside');
        await mkdir(outside);
        await symlink(outside, firstHome.sessions, 'dir');
        firstParentRegistration?.listener('rename', 'sessions');
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(registrations.filter(({ path, options }) =>
            path === firstHome.sessions && options.recursive === true
        )).toHaveLength(1);

        await rm(firstHome.sessions);
        await mkdir(firstHome.sessions);
        firstParentRegistration?.listener('rename', 'sessions');
        await vi.waitFor(() => {
            expect(registrations.filter(({ path, options }) =>
                path === firstHome.sessions && options.recursive === true
            )).toHaveLength(2);
        });

        const secondHome = await createHome('two');
        const secondLink = await addHome(reconciler, secondHome, 2);
        await vi.waitFor(() => {
            expect(registrations.filter(({ path, options }) =>
                path === secondHome.home && options.recursive !== true
            )).toHaveLength(1);
            expect(registrations.filter(({ path, options }) =>
                (
                    path === secondHome.sessions
                    || path === secondHome.archivedSessions
                )
                && options.recursive === true
            )).toHaveLength(2);
        });

        await reconciler.removeLink(firstLink);
        await reconciler.removeLink(secondLink);
        await reconciler.dispose();
        await reconciler.dispose();
        for (const registration of registrations) {
            expect(registration.close).toHaveBeenCalledTimes(1);
        }

        const reconciliationCountAfterDispose =
            reconcileResource.mock.calls.length;
        for (const registration of registrations) {
            registration.listener('rename', 'late.jsonl');
            for (const onError of registration.errorListeners) {
                onError(new Error('late watcher error'));
            }
        }
        const registrationCountAfterDispose = registrations.length;
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(registrations).toHaveLength(registrationCountAfterDispose);
        expect(reconcileResource).toHaveBeenCalledTimes(
            reconciliationCountAfterDispose,
        );
    });
});
