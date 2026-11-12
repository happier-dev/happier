import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';

import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { createDaemonPluginRegistryRuntimeLifecycle } from '@/plugins/runtime/reload/registryRuntimeLifecycle';
import { createPluginRegistryStateStore } from '@/plugins/store/registry/currentState';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import type { DaemonState } from '@/api/types';
import { createDaemonAdmissionDrain, waitForDaemonAdmission } from '@/daemon/lifecycle/admissionDrain';
import { createBeforeShutdownDrain } from '@/daemon/lifecycle/createBeforeShutdownDrain';
import { createDaemonPluginRegistryProjectionInvalidation } from '@/daemon/pluginRegistryProjectionInvalidation';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import { createDaemonPathPluginChangePreparer } from './pathChangePreparer';
import { createDaemonPluginChangeService } from './changeService';

const filesystemObservation = vi.hoisted((): { afterRealpath?: (path: unknown) => void } => ({}));
// The filesystem is the external boundary; all source admission, candidate
// preparation, review retention, registry mutation and cleanup remain real.
vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, realpath: async (...args: Parameters<typeof actual.realpath>) => {
        const result = await actual.realpath(...args);
        filesystemObservation.afterRealpath?.(args[0]);
        return result;
    } };
});

async function createFixture(onRegistryApplied?: () => void) {
    const root = await fs.mkdtemp(join(tmpdir(), 'plugin-change-cancellation-'));
    const happyHomeDir = join(root, 'home');
    const pluginRoot = join(root, 'source');
    await fs.mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
    await fs.writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify(createPluginManifestV2Fixture({
        id: 'acme.cancellation', entrypoints: undefined,
    })));
    const reloadController = createPluginReloadController({ happyHomeDir });
    const signal = new AbortController();
    const prepare = createDaemonPathPluginChangePreparer({ happyHomeDir,
        runtimeLifecycle: createDaemonPluginRegistryRuntimeLifecycle({ happyHomeDir, reloadController }),
        onRegistryApplied,
    });
    const service = createDaemonPluginChangeService({ prepare });
    return { root, happyHomeDir, pluginRoot, signal, service, reloadController,
        async close() {
            await service.shutdown();
            await reloadController.shutdown();
            await fs.rm(root, { recursive: true, force: true });
        },
    };
}

describe('plugin change cancellation through real path preparation', () => {
    it.each([false, true])('recovers an interrupted Action review only for the same candidate (changed=%s)', async changed => {
        const fixture = await createFixture();
        try {
            const abandoned = new AbortController();
            const request = { kind: 'installPath' as const, locator: fixture.pluginRoot };
            const first = await fixture.service.requestPluginChange(request, { retainReview: true, signal: abandoned.signal });
            if (first.kind !== 'reviewRequired') throw new Error('Expected an installation review');
            // The native review was prepared, but the invocation ended before
            // creating an approval Artifact or answering the retained decision.
            abandoned.abort();
            if (changed) {
                const manifestPath = join(fixture.pluginRoot, '.happier-plugin', 'plugin.json');
                const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
                await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, version: '1.1.0' }));
            }
            const retried = await fixture.service.requestPluginChange(request, { retainReview: true });
            expect(retried).toEqual(changed ? { kind: 'busy', pluginId: 'acme.cancellation' } : first);
            await expect(fixture.service.decidePluginChange({ pendingChangeId: first.pendingChangeId, decision: 'cancel' }))
                .resolves.toEqual({ kind: 'cancelled' });
            const next = await fixture.service.requestPluginChange(request, { retainReview: true });
            expect(next).toMatchObject({ kind: 'reviewRequired' });
            if (next.kind !== 'reviewRequired') throw new Error('Expected the next installation review');
            expect(next.pendingChangeId).not.toBe(first.pendingChangeId);
        } finally {
            await fixture.close();
        }
    });

    it('preserves real plugin decisions and publication through unused-stop, then disposes at final shutdown', async () => {
        let invalidateProjection = () => {};
        const fixture = await createFixture(() => invalidateProjection());
        // Compose the same lifecycle owners as startDaemon: admission includes
        // handoff, publication excludes unused-stop, and only final shutdown
        // retires decisions and disposes the runtime registry.
        const drain = createDaemonAdmissionDrain({ isPluginHandoffQuiescing: fixture.service.isQuiescing });
        const publications: DaemonState[] = [];
        let daemonState: DaemonState | null = null;
        const projection = createDaemonPluginRegistryProjectionInvalidation({
            getApiMachine: () => ({ updateDaemonState: async update => {
                daemonState = update(daemonState);
                publications.push(daemonState);
            } }),
            isDaemonQuiescing: drain.isPublicationQuiescing,
            onPublicationFailure: error => { throw error; },
        });
        invalidateProjection = projection.invalidateProjection;
        const shutdown = createBeforeShutdownDrain({
            admissionDrain: drain,
            pidToAwaiter: new Map(), pidToSpawnResultResolver: new Map(), pidToSpawnWebhookTimeout: new Map(),
            shutdownSpawnDrainGraceMs: 0, shutdownSpawnDrainPollMs: 10,
            getApiMachineForSessions: () => null,
            buildUnexpectedSpawnResult: errorMessage => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage }),
            drainBackgroundServerWork: fixture.service.shutdown,
            disposePluginRuntimeRegistry: fixture.reloadController.shutdown,
        });
        const cancellation = new AbortController();
        let admitted: Promise<unknown> | undefined;
        try {
            const review = await fixture.service.requestPluginChange({ kind: 'installPath', locator: fixture.pluginRoot });
            if (review.kind !== 'reviewRequired') throw new Error(`Expected installation review: ${JSON.stringify(review)}`);
            expect(publications).toEqual([]);
            drain.beginUnusedStopDrain();
            expect((await fixture.service.listPendingPluginChanges()).changes).toMatchObject([
                { pendingChangeId: review.pendingChangeId, kind: 'reviewRequired' },
            ]);
            let started = false;
            admitted = waitForDaemonAdmission(drain, cancellation.signal).then(async () => {
                started = true;
                return fixture.service.requestPluginChange({ kind: 'setUpdatePolicy', pluginId: 'acme.cancellation', policy: 'pinned' });
            });
            await Promise.resolve();
            expect(started).toBe(false);
            await expect(fixture.service.decidePluginChange({ pendingChangeId: review.pendingChangeId, decision: 'installAndTrust' }))
                .resolves.toMatchObject({ kind: 'committed', pluginId: 'acme.cancellation' });
            expect(publications).toContainEqual(expect.objectContaining({ contributionRegistryProjectionRevision: 1 }));
            const lease = fixture.reloadController.tryAcquireRuntimeRegistry();
            expect(lease).not.toBeNull();
            await lease?.release();
            expect(started).toBe(false);
            drain.resumeUnusedStop();
            await expect(admitted).resolves.toMatchObject({ kind: 'committed', pluginId: 'acme.cancellation' });
            expect((await createPluginRegistryStateStore({ happyHomeDir: fixture.happyHomeDir }).read()).plugins['acme.cancellation'])
                .toMatchObject({ install: { updatePolicy: 'pinned' } });

            // Handoff retains its distinct destructive decision semantics.
            const held = await fixture.service.requestPluginChange({ kind: 'installPath', locator: fixture.pluginRoot },
                { retainReview: true });
            if (held.kind !== 'reviewRequired') throw new Error(`Expected retained review: ${JSON.stringify(held)}`);
            const handoff = await fixture.service.quiesceForHandoff();
            expect(drain.isPublicationQuiescing()).toBe(true);
            handoff.resume();
            expect(await fixture.service.statusPluginChange({ pendingChangeId: held.pendingChangeId })).toEqual({ kind: 'expired' });
            const finalReview = await fixture.service.requestPluginChange({ kind: 'installPath', locator: fixture.pluginRoot },
                { retainReview: true });
            expect(finalReview.kind).toBe('reviewRequired');
            await shutdown();
            drain.resumeUnusedStop();
            expect(drain.isFinalShutdown()).toBe(true);
            expect((await fixture.service.listPendingPluginChanges()).changes).toEqual([]);
            expect(fixture.reloadController.tryAcquireRuntimeRegistry()).toBeNull();
            const publicationCount = publications.length;
            projection.invalidateProjection();
            expect(publications).toHaveLength(publicationCount);
            await shutdown();
        } finally {
            cancellation.abort();
            await admitted?.catch(() => {});
            await fixture.close();
        }
    });
    it.each(['before_work', 'during_preparation'] as const)('retires an uncommitted candidate when cancelled %s', async phase => {
        const fixture = await createFixture();
        if (phase === 'during_preparation') filesystemObservation.afterRealpath = path => {
            if (String(path) === fixture.pluginRoot) fixture.signal.abort();
        };
        if (phase === 'before_work') fixture.signal.abort();
        try {
            const result = await fixture.service.requestPluginChange({ kind: 'installPath', locator: fixture.pluginRoot },
                { signal: fixture.signal.signal });
            expect(fixture.signal.signal.aborted).toBe(true);
            expect(result).toEqual({ kind: 'cancelled' });
            expect((await fixture.service.listPendingPluginChanges()).changes).toEqual([]);
            expect((await createPluginRegistryStateStore({ happyHomeDir: fixture.happyHomeDir }).read()).plugins['acme.cancellation'])
                .toBeUndefined();
            const paths = resolvePluginStorePaths({ happyHomeDir: fixture.happyHomeDir });
            expect(await fs.readdir(paths.generationsDir).catch((error: unknown) => {
                if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
                throw error;
            })).toEqual([]);
            // An interrupted preparation must not reserve the plugin for the
            // rest of this daemon lifetime. Re-enter through the real preparer.
            filesystemObservation.afterRealpath = undefined;
            const next = await fixture.service.requestPluginChange({ kind: 'installPath', locator: fixture.pluginRoot });
            expect(next).toMatchObject({ kind: 'reviewRequired' });
            if (next.kind !== 'reviewRequired') throw new Error('Expected a fresh installation review');
            await expect(fixture.service.decidePluginChange({ pendingChangeId: next.pendingChangeId, decision: 'cancel' }))
                .resolves.toEqual({ kind: 'cancelled' });
        } finally {
            filesystemObservation.afterRealpath = undefined;
            await fixture.close();
        }
    });

    it('returns the actual committed outcome when cancellation arrives after mutation', async () => {
        const signal = new AbortController();
        let observeMutation = false;
        const fixture = await createFixture(() => { if (observeMutation) signal.abort(); });
        try {
            const review = await fixture.service.requestPluginChange({ kind: 'installPath', locator: fixture.pluginRoot });
            if (review.kind !== 'reviewRequired') throw new Error('Expected the real source installation review');
            await expect(fixture.service.decidePluginChange({ pendingChangeId: review.pendingChangeId, decision: 'installAndTrust' }))
                .resolves.toMatchObject({ kind: 'committed', pluginId: 'acme.cancellation' });
            observeMutation = true;
            await expect(fixture.service.requestPluginChange({ kind: 'setUpdatePolicy', pluginId: 'acme.cancellation', policy: 'pinned' },
                { signal: signal.signal })).resolves.toMatchObject({ kind: 'committed', pluginId: 'acme.cancellation' });
            expect(signal.signal.aborted).toBe(true);
            expect((await createPluginRegistryStateStore({ happyHomeDir: fixture.happyHomeDir }).read()).plugins['acme.cancellation'])
                .toMatchObject({ install: { updatePolicy: 'pinned' } });
        } finally {
            await fixture.close();
        }
    });
});
