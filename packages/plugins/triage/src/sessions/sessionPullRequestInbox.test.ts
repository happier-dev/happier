import { createPluginTestkit, createTestResourceInvocationContext } from '@happier-dev/plugin-sdk/testing';
import { describe, expect, it } from 'vitest';
import { PluginSessionInboxRowPageV1Schema } from '@happier-dev/protocol/plugins/contributions/ui/sessionInbox';
import { resolvePluginLocalizedStringV2Text } from '@happier-dev/protocol/plugins/contributions/public-types';
import type { PluginDynamicResourceInvocationOptionsV1 } from '@happier-dev/plugin-sdk/resources';

import { PLUGIN_MANIFEST, TRIAGE_PLUGIN } from '../manifest.js';

const id = 'session-pull-request-inbox-v1';
const detailId = 'session-pull-request-status-v1';
const execution = { artifactId: 'triage-account-runtime', exportName: 'activate' };

async function registeredIndex() {
    const testkit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: TRIAGE_PLUGIN });
    const declaration = PLUGIN_MANIFEST.contributes.resources.find(resource => resource.id === id);
    expect(declaration).toMatchObject({ scope: 'surface', sessionInbox: { detailResourceId: detailId },
        execution: { target: 'account', account: execution } });
    const runtime = testkit.registration('resources', id);
    if (!runtime) throw new Error('Declared Inbox index was not registered');
    return { runtime, dispose: () => testkit.dispose() };
}

function session(index: number) {
    return { session: { serverId: 'home-a', sessionId: `session-${index}` }, bindings: [{
        bindingId: `binding-${index}`, revision: 1,
        link: { provider: 'github', repository: 'example/repository', number: index + 1,
            url: `https://github.com/example/repository/pull/${index + 1}` },
        watch: { policy: { mode: 'notify', archiveAfterMerge: false },
            reason: null, fixAttemptLimit: 3, roundsStarted: 0, watchingMachine: null }, latestUpdate: null,
    }] };
}

// Cross-plugin Action invocation is the transport boundary; declaration,
// registration, input/result admission and row mapping remain real.
function options(result: unknown, cursor: string | null = null) {
    const calls: unknown[] = [];
    let invalidation: (() => void) | undefined;
    let disposed = 0;
    const controller = new AbortController();
    const value: PluginDynamicResourceInvocationOptionsV1 = createTestResourceInvocationContext({
        context: { kind: 'surface', mountInstanceKey: 'happier:session-inbox', launchInput: { cursor } },
        signal: controller.signal,
        async readAction(ref, input) { calls.push({ ref, input }); return { ok: true, result }; },
        async observeAction(ref, input, notify) {
            calls.push({ observed: ref, input }); invalidation = notify;
            return { dispose() { disposed += 1; } };
        },
    });
    return { value, calls, controller, changed: () => invalidation?.(), disposed: () => disposed };
}

describe('the declared PR Session Inbox index', () => {
    it('carries the first open retained PR into Landing without deriving state from a URL or watch policy', async () => {
        const index = await registeredIndex();
        try {
            const group = session(0);
            const first = group.bindings[0]!;
            const open = { ...first, bindingId: 'open', link: { ...first.link, number: 2,
                url: 'https://github.com/example/repository/pull/2', state: 'open', observedAt: 20 } };
            const fixture = options({ kind: 'ready', sessions: [{ ...group, bindings: [
                first, { ...first, bindingId: 'merged', link: { ...first.link, state: 'merged', observedAt: 10 } }, open,
            ] }], nextCursor: null });
            const page = PluginSessionInboxRowPageV1Schema.parse(JSON.parse(String(await index.runtime.read(fixture.value))));
            expect(page).toMatchObject({ kind: 'ready', rows: [{ landing: {
                number: 2, url: open.link.url, state: 'open', observedAt: 20,
            } }] });
            expect(fixture.calls).toHaveLength(1);
            const { state: _openState, ...unobservedLink } = open.link;
            for (const state of ['merged', 'closed', 'unknown', undefined]) {
                const terminal = options({ kind: 'ready', sessions: [{ ...group, bindings: [
                    { ...open, link: { ...unobservedLink, ...(state === undefined ? {} : { state }) } },
                ] }], nextCursor: null });
                const value = PluginSessionInboxRowPageV1Schema.parse(JSON.parse(String(await index.runtime.read(terminal.value))));
                if (value.kind !== 'ready') throw new Error('Expected retained metadata');
                expect(value.rows[0]).not.toHaveProperty('landing');
            }
        } finally { await index.dispose(); }
    });

    it('pages complete Session metadata through the same Account watch owner without native reads', async () => {
        const index = await registeredIndex();
        try {
            const fixture = options({ kind: 'ready', sessions: Array.from({ length: 1000 }, (_, i) => session(i)), nextCursor: 'next' }, 'page-two');
            const bytes = await index.runtime.read(fixture.value);
            const page = PluginSessionInboxRowPageV1Schema.parse(JSON.parse(typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes)));
            expect(page.kind).toBe('ready');
            if (page.kind !== 'ready') throw new Error('Expected admitted rows');
            expect(page.rows).toHaveLength(1000);
            expect(page.nextCursor).toBe('next');
            expect(page.rows[0]).toEqual({ id: 'session-0', session: session(0).session,
                title: 'example/repository#1', detail: null,
                detailResource: { pluginId: PLUGIN_MANIFEST.id, resourceId: detailId } });
            expect(fixture.calls).toEqual([{ ref: { pluginId: 'happier.channels', localId: 'session-pull-request-watch-v1' },
                input: { kind: 'list', cursor: 'page-two' } }]);
        } finally { await index.dispose(); }
    });

    it('keeps unavailable metadata explicit and observes only that admitted page until disposal', async () => {
        const index = await registeredIndex();
        try {
            const fixture = options({ kind: 'unavailable', reason: 'locked' });
            expect(JSON.parse(String(await index.runtime.read(fixture.value)))).toEqual({ kind: 'unavailable', reason: 'locked' });
            let changes = 0;
            const observation = await index.runtime.observe(() => { changes += 1; }, fixture.value);
            fixture.changed();
            expect(changes).toBe(1);
            fixture.controller.abort();
            fixture.changed();
            expect(changes).toBe(1);
            await observation.dispose();
            expect(fixture.disposed()).toBe(1);
            expect(fixture.calls).toEqual([
                { ref: { pluginId: 'happier.channels', localId: 'session-pull-request-watch-v1' }, input: { kind: 'list' } },
                { observed: { pluginId: 'happier.channels', localId: 'session-pull-request-watch-v1' }, input: { kind: 'list' } },
            ]);
        } finally { await index.dispose(); }
    });

    it('summarizes several retained links once and keeps latest provider text as inert data', async () => {
        const index = await registeredIndex();
        try {
            const group = session(0);
            const newest = { occurrenceId: 'batch-new', occurredAtMs: 20, kinds: ['comment'],
                summary: 'Untrusted provider text', summaryTruncated: false,
                location: { kind: 'provider', url: group.bindings[0]!.link.url } };
            const fixture = options({ kind: 'ready', sessions: [{ ...group, bindings: [
                { ...group.bindings[0], latestUpdate: newest },
                { ...session(1).bindings[0], latestUpdate: { ...newest, occurrenceId: 'batch-old', occurredAtMs: 10, summary: 'Older' } },
                { ...group.bindings[0], bindingId: 'duplicate-link', latestUpdate: null },
            ] }, { session: { serverId: 'home-a', sessionId: 'unlinked' }, bindings: [] }], nextCursor: null });
            const page = PluginSessionInboxRowPageV1Schema.parse(JSON.parse(String(await index.runtime.read(fixture.value))));
            expect(page).toMatchObject({ kind: 'ready', rows: [{ id: 'session-0',
                title: 'example/repository#1, example/repository#2', detail: newest.summary }], nextCursor: null });
            if (page.kind !== 'ready') throw new Error('Expected metadata page');
            expect(page.rows).toHaveLength(1);
            expect(fixture.calls).toHaveLength(1);
        } finally { await index.dispose(); }
    });

    it('publishes viewer-dispatched Continue and Stop only for each exact exhausted binding', async () => {
        const index = await registeredIndex();
        try {
            const group = session(0);
            const binding = group.bindings[0]!;
            const exhausted = { ...binding, bindingId: 'exhausted-a', revision: 42,
                watch: { ...binding.watch, reason: 'exhausted', roundsStarted: 3, fixAttemptLimit: 7,
                    policy: { mode: 'address', archiveAfterMerge: true } } };
            const fixture = options({ kind: 'ready', sessions: [{ ...group, bindings: [exhausted,
                { ...exhausted, bindingId: 'exhausted-b', revision: 43,
                    link: { ...session(1).bindings[0]!.link, repository: 'another/repository',
                        url: 'https://github.com/another/repository/pull/2' },
                    watch: { ...exhausted.watch, policy: { ...exhausted.watch.policy, mode: 'autoFix' } } },
                ...['paused', 'credentials', 'terminal', null].map(reason => ({ ...exhausted,
                    bindingId: `cold-${reason}`, watch: { ...exhausted.watch, reason } })),
            ] }], nextCursor: null });
            const page = PluginSessionInboxRowPageV1Schema.parse(JSON.parse(String(await index.runtime.read(fixture.value))));
            if (page.kind !== 'ready') throw new Error('Expected metadata page');
            const controls = page.rows[0]!.controls;
            expect(controls).toHaveLength(4);
            expect(new Set(controls!.map(control => control.id)).size).toBe(4);
            expect(controls!.map(control => control.label)).toEqual([
                expect.objectContaining({ params: { count: 7, pullRequest: 'example/repository#1' } }),
                expect.objectContaining({ params: { pullRequest: 'example/repository#1' } }),
                expect.objectContaining({ params: { count: 7, pullRequest: 'another/repository#2' } }),
                expect.objectContaining({ params: { pullRequest: 'another/repository#2' } }),
            ]);
            expect(controls!.map(control => resolvePluginLocalizedStringV2Text(control.label))).toEqual([
                'Continue 7 more · example/repository#1', 'Stop watching · example/repository#1',
                'Continue 7 more · another/repository#2', 'Stop watching · another/repository#2',
            ]);
            expect(controls!.map(control => control.effect)).toEqual(['exhausted-a', 'exhausted-b'].flatMap((bindingId, i) => [
                { kind: 'action', invocation: { action: { pluginId: 'happier.channels', localId: 'session-pull-request-watch-v1' },
                    input: { kind: 'retryFix', sessionId: 'session-0', bindingId, expectedRevision: 42 + i } } },
                { kind: 'action', invocation: { action: { pluginId: 'happier.channels', localId: 'session-pull-request-watch-v1' },
                    input: { kind: 'configure', sessionId: 'session-0', bindingId, expectedRevision: 42 + i,
                        policy: { mode: 'off', archiveAfterMerge: true } } } },
            ]));
            expect(fixture.calls).toHaveLength(1);
        } finally { await index.dispose(); }
    });

    it('does not offer continuation when the effective Account limit is unlimited', async () => {
        const index = await registeredIndex();
        try {
            const group = session(0);
            const binding = group.bindings[0]!;
            for (const reason of [null, 'exhausted']) {
                const fixture = options({ kind: 'ready', sessions: [{ ...group, bindings: [{ ...binding,
                    watch: { ...binding.watch, reason, fixAttemptLimit: null, roundsStarted: 3 },
                }] }], nextCursor: null });
                const page = PluginSessionInboxRowPageV1Schema.parse(JSON.parse(String(await index.runtime.read(fixture.value))));
                if (page.kind !== 'ready') throw new Error('Expected metadata page');
                expect(page.rows[0]).not.toHaveProperty('controls');
                expect(fixture.calls).toHaveLength(1);
            }
        } finally { await index.dispose(); }
    });

    it('rejects missing host context and malformed metadata before publishing a ready page', async () => {
        const index = await registeredIndex();
        try {
            const fixture = options({ kind: 'ready', sessions: [], nextCursor: null });
            await expect(index.runtime.read(createTestResourceInvocationContext({ ...fixture.value, context: { kind: 'global' } }))).rejects.toThrow();
            expect(fixture.calls).toEqual([]);
            const unauthenticated = createTestResourceInvocationContext({ ...fixture.value,
                async readAction() { return { ok: false, errorCode: 'not_authenticated', error: 'Sign in required' }; },
            });
            await expect(index.runtime.read(unauthenticated)).rejects.toMatchObject({ code: 'not_authenticated' });
            const corrupt = options({ kind: 'ready', sessions: [{ ...session(0), extra: 'undeclared' }], nextCursor: null });
            await expect(index.runtime.read(corrupt.value)).rejects.toThrow();
        } finally { await index.dispose(); }
    });
});
