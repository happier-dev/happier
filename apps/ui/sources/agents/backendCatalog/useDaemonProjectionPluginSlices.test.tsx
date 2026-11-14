import * as React from 'react';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DaemonContributionRegistryProjectionDescribeResponseSchema, buildDeferredDaemonProjectionSections,
    daemonProjectionPluginSectionId, DAEMON_PROJECTION_SESSION_PLUGINS } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { renderHook } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ getPreferredLanguage: () => 'en' });
});

// The real network boundary answers the daemon RPC; the loader, section reader,
// merge and cache publication below it stay real.
const network = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
const { loadDaemonMergedProjectionCacheEntry, readCachedDaemonMergedProjectionCacheEntry,
    clearDaemonMergedProjectionCacheForTests } = await import('./loadDaemonMergedProjectionInputs');
const { useDaemonProjectionPluginSlices } = await import('./useDaemonProjectionPluginSlices');
afterAll(() => network.dispose());

const lifetime: ActiveServerAccountScopeLifetime = Object.freeze({
    scope: Object.freeze({ serverId: 'server-1', accountId: 'account-a' }), isCurrent: () => true,
    isReleased: () => false, onRetire: () => Object.freeze({ dispose: () => {} }),
});

const action = (pluginId: string, id: string, scopes: readonly string[]) => [`${pluginId}/${id}`, { id, pluginId,
    occurrenceId: `${pluginId}:7`, title: id, scopes, surfaces: ['ui'], placementBindings: [], execution: { target: 'daemon' },
    dangerLevel: 'safe', available: true }] as const;

describe('Session plugin slices', () => {
    it('loads a missing plugin once and settles only after its holder committed the answer', async () => {
        clearDaemonMergedProjectionCacheForTests();
        network.setHttpResponder(async input => new URL(String(input)).pathname === '/v1/account/encryption'
            ? Response.json({ mode: 'plain', updatedAt: 0 }) : null);
        try { await network.addHome('https://server-1', 'account-a'); } catch { /* added by an earlier case */ }
        const snapshot = buildDeferredDaemonProjectionSections(DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
            protocolVersion: 1, projectionDigest: '7'.repeat(64), projection: { v: 2, generation: 7, actionsById: Object.fromEntries([
                action('qa.session', 'continue', ['session']), action('qa.other', 'export', ['global'])]) } }));
        let reads = 0;
        network.setRpcAckResponder(async request => {
            if (request.method !== RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
                return { ok: false, error: 'unsupported', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
            }
            const read = (request.payload as { sectionRead?: { digest: string; offset: number; includeDigests?: readonly string[] } }).sectionRead;
            if (!read) return { ok: true, result: snapshot.manifest };
            reads += 1;
            return { ok: true, result: snapshot.read(read.digest, read.offset, read.includeDigests) };
        });
        const params = { machineId: 'machine-1', serverId: 'server-1', accountLifetime: lifetime };
        const initial = await loadDaemonMergedProjectionCacheEntry({ ...params,
            sections: [daemonProjectionPluginSectionId('actionsById', DAEMON_PROJECTION_SESSION_PLUGINS)] });
        expect(initial?.kind).toBe('ready');

        // The holder records which Actions each committed render carried.
        const committed: string[][] = [];
        const hook = await renderHook(() => {
            const slices = useDaemonProjectionPluginSlices(params);
            const entry = readCachedDaemonMergedProjectionCacheEntry({ ...params, sections: [] });
            const actions = entry && entry.kind === 'ready' ? Object.keys(entry.inputs.pluginProjectionV2?.actionsById ?? {}) : [];
            React.useLayoutEffect(() => { committed.push(actions); });
            return slices;
        });
        try {
            const slices = hook.getCurrent()!;
            expect({ session: slices.isLoaded('qa.session'), other: slices.isLoaded('qa.other') }).toEqual({ session: true, other: false });
            expect(committed.at(-1)).toEqual(['qa.session/continue']);

            const before = reads;
            let seenAtSettle: string[] | undefined;
            await slices.load('qa.other').then(() => { seenAtSettle = committed.at(-1); });
            // One slice read, settled only once a commit carried the loaded plugin.
            expect(reads).toBeGreaterThan(before);
            expect(seenAtSettle).toEqual(expect.arrayContaining(['qa.other/export', 'qa.session/continue']));
            expect(slices.isLoaded('qa.other')).toBe(true);

            // A loaded plugin reads nothing and settles at once.
            const loaded = reads;
            await slices.load('qa.other');
            await slices.load('qa.session');
            expect(reads).toBe(loaded);
        } finally {
            await hook.unmount();
            clearDaemonMergedProjectionCacheForTests();
        }
    });
});
