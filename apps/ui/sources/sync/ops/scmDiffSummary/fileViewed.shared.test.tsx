/** @vitest-environment jsdom */
import * as React from 'react';
import { afterEach, expect, it } from 'vitest';
import { renderScreen, act, standardCleanup } from '@/dev/testkit';
import { acquireScmFileViewedSource } from './fileViewedSources';
import { useScmFileViewedFile } from '@/components/sessions/files/comparison/useScmFileViewedState';
import { useScmFileViewedFile as usePluginFileViewed } from '@happier-dev/plugin-ui/hostApi';
import { ScmComparisonSchema } from '@happier-dev/protocol/scm/comparison';

afterEach(standardCleanup);
const actions = {
    read: { action: { pluginId: 'example.forge', localId: 'read-viewed' }, input: { pr: '17' } },
    set: { action: { pluginId: 'example.forge', localId: 'set-viewed' }, input: { pr: '17' } },
};

it('shares one PR map and read between core and plugin consumers, including a later mount', async () => {
    let reads = 0;
    const execute: Parameters<typeof acquireScmFileViewedSource>[0]['execute'] = async invocation => {
        if (invocation.action.localId === actions.read.action.localId) {
            reads++;
            return { kind: 'ready', headOid: 'head', files: [
                { path: 'a.ts', state: 'unviewed' }, { path: 'b.ts', state: 'viewed' },
            ] };
        }
        return { kind: 'ready', path: 'a.ts', state: 'viewed' };
    };
    const params = { actions, execute, scopeKey: 'account-a', isCurrent: () => true };
    const coreLease = acquireScmFileViewedSource(params);
    const core = coreLease.source;
    coreLease.setActive(true);
    await core.refresh();
    const pluginLease = acquireScmFileViewedSource(params);
    const plugin = pluginLease.source;
    pluginLease.setActive(true);
    expect(reads).toBe(1);
    expect(plugin).toBe(core);
    let coreState: unknown;
    let pluginState: unknown;
    function Core() { coreState = useScmFileViewedFile(core, 'a.ts'); return null; }
    let unrelatedRenders = 0;
    function Plugin() { pluginState = usePluginFileViewed(plugin, 'a.ts'); return null; }
    function Unrelated() { usePluginFileViewed(plugin, 'b.ts'); unrelatedRenders++; return null; }
    await renderScreen(<><Core /><Plugin /><Unrelated /></>);
    const initialUnrelatedRenders = unrelatedRenders;
    const unchanged = core.getFile('b.ts');
    await act(async () => { await plugin.setViewed('a.ts', true); });
    expect(coreState).toBe(pluginState);
    expect(coreState).toMatchObject({ state: 'viewed' });
    expect(core.getFile('b.ts')).toBe(unchanged);
    expect(unrelatedRenders).toBe(initialUnrelatedRenders);
    expect(reads).toBe(1);
    coreLease.release();
    expect(plugin.getFile('a.ts').state).toBe('viewed');
    pluginLease.release();
    expect(plugin.getFile('a.ts').state).toBeNull();
});

it('keeps a held read for the remaining surface, cancels empty demand, and isolates Accounts', async () => {
    let finish!: (value: unknown) => void;
    let signal!: AbortSignal;
    let reads = 0;
    const params = { actions, scopeKey: 'held-account', isCurrent: () => true,
        execute: async (_: unknown, requestSignal: AbortSignal) => {
            reads++; signal = requestSignal;
            return new Promise(resolve => { finish = resolve; });
        } };
    const core = acquireScmFileViewedSource(params);
    const plugin = acquireScmFileViewedSource(params);
    try {
        core.setActive(true); plugin.setActive(true);
        const reading = plugin.source.refresh();
        core.release();
        expect(signal.aborted).toBe(false);
        finish({ kind: 'ready', headOid: 'head', files: [{ path: 'a.ts', state: 'viewed' }] });
        await reading;
        expect(plugin.source.getFile('a.ts').state).toBe('viewed');
        const other = acquireScmFileViewedSource({ ...params, scopeKey: 'other-account' });
        expect(other.source).not.toBe(plugin.source);
        expect(other.source.getFile('a.ts').state).toBeNull();
        other.release();
        plugin.setActive(false);
        expect(plugin.source.getFile('a.ts').state).toBe('viewed');
        plugin.setActive(true);
        const resumed = plugin.source.refresh();
        expect(reads).toBe(2);
        expect(signal.aborted).toBe(false);
        plugin.setActive(false);
        expect(signal.aborted).toBe(true);
        finish({ kind: 'ready', headOid: 'head', files: [{ path: 'a.ts', state: 'unviewed' }] });
        await resumed;
        expect(plugin.source.getFile('a.ts').state).toBe('viewed');
    } finally { core.release(); plugin.release(); }
});

it('refreshes the shared map when a newly opened capture names a newer head', async () => {
    let headOid = 'old-head';
    let reads = 0;
    const comparisonAt = (head: string) => ScmComparisonSchema.parse({ id: head,
        source: { kind: 'pullRequest', locator: { providerId: 'example.forge', repository: 'example/repo', number: 17,
            fileViewedActions: actions } }, repository: { rootPath: '/repo' }, endpoints: { after: head }, freshness: 'current',
        inventory: { state: 'complete', reasons: [], files: [] } });
    const params = { actions, scopeKey: 'new-head-account', isCurrent: () => true,
        execute: async () => { reads++; return { kind: 'ready', headOid, files: [{ path: 'a.ts', state: 'unviewed' }] }; } };
    const oldRequest = { ...params, comparison: comparisonAt(headOid) };
    const core = acquireScmFileViewedSource(oldRequest);
    let plugin: ReturnType<typeof acquireScmFileViewedSource> | undefined;
    try {
        core.setActive(true);
        await core.source.refresh();
        headOid = 'new-head';
        const newRequest = { ...params, comparison: comparisonAt(headOid) };
        plugin = acquireScmFileViewedSource(newRequest);
        plugin.setActive(true);
        expect(plugin.source).toBe(core.source);
        expect(reads).toBe(2);
        await plugin.source.refresh();
        expect(plugin.source.getSnapshot().headOid).toBe('new-head');
    } finally { plugin?.release(); core.release(); }
});
