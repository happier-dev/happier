import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { MemoryDocumentSource, MemoryDocumentView } from './useMemoryDocument';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
const execute = vi.hoisted(() => vi.fn());
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: navigation }).module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});
// The Action executor is the surface's outward write boundary; everything beneath the section is real.
vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
    createDefaultActionExecutor: () => ({ execute }),
}));

afterEach(() => {
    standardCleanup();
    navigation.push.mockClear();
    execute.mockReset();
});

const { MemoryDocumentBody } = await import('./MemoryDocumentBody');

const ref = { kind: 'doc', serverId: 'home-a', artifactId: 'memory-doc' } as const;
const revision = { headerVersion: 1, bodyVersion: 4 };
const fact = (id: string, text: string) => ({ id, text, createdAtMs: 1_000, sourceSessionRef: null });
function sourceOf(view: Partial<MemoryDocumentView> | null, overrides: Partial<MemoryDocumentSource> = {}): MemoryDocumentSource {
    const full = view ? {
        artifactId: ref.artifactId, title: 'Account memory', revision, facts: [], topics: [], topic: null, ...view,
    } : null;
    return {
        status: full ? 'ready' : 'none',
        view: full,
        stale: false,
        target: full ? { ref, serverId: 'home-a', expectedRevision: revision, ...(full.topic ? { topic: full.topic.title } : {}) } : null,
        refresh: vi.fn(async () => {}),
        ...overrides,
    };
}

function Host(props: Readonly<{ source: MemoryDocumentSource; composing?: boolean; collapsed?: number; sessionTarget?: Parameters<typeof MemoryDocumentBody>[0]['sessionTarget'] }>) {
    const [composing, setComposing] = React.useState(props.composing ?? false);
    return (
        <MemoryDocumentBody
            testID="memory"
            source={props.source}
            serverId="home-a"
            collapsedFactCount={props.collapsed}
            composing={composing}
            onComposingChange={setComposing}
            sessionTarget={props.sessionTarget}
            emptyText="empty"
        />
    );
}

/** The Action runs behind a lazy import; let it and the state it settles land. */
async function settled() {
    await React.act(async () => { await vi.waitFor(() => expect(execute).toHaveBeenCalled()); });
    await React.act(async () => { await Promise.resolve(); });
}

describe('MemoryDocumentBody', () => {
    it('shows the index first — key facts, then topics — and a topic opens its own page', async () => {
        const screen = await renderScreen(<Host
            collapsed={1}
            source={sourceOf({
                facts: [fact('f1', 'Releases ship from release/0.3.'), fact('f2', 'Changelog order: Features, Fixes.')],
                topics: [{ title: 'releases', summary: 'How releases are cut.' }, { title: 'archive', summary: 'x' }],
            })}
        />);
        expect(screen.findByTestId('memory.fact.f1')).toBeTruthy();
        // Past the collapsed count, facts wait behind "Show all" on the document's page.
        expect(screen.findByTestId('memory.fact.f2')).toBeNull();
        await screen.pressByTestIdAsync('memory.showAll');
        expect(navigation.push).toHaveBeenLastCalledWith('/settings/prompts/memory/memory-doc?serverId=home-a');
        await screen.pressByTestIdAsync('memory.topic.releases');
        expect(navigation.push).toHaveBeenLastCalledWith('/settings/prompts/memory/memory-doc?serverId=home-a&topic=releases');
        expect(screen.findByTestId('memory.topic.archive')).toBeTruthy();
    });

    it('remembers into an optional topic through memory.remember at the reviewed revision, then re-reads', async () => {
        execute.mockResolvedValue({ ok: true, result: { ok: true, artifactId: ref.artifactId, factId: 'new' } });
        const source = sourceOf({ facts: [] });
        const screen = await renderScreen(<Host source={source} composing />);
        await React.act(async () => { screen.changeTextByTestId('memory.draft', '  Ana reviews sync changes.  '); });
        await React.act(async () => { screen.changeTextByTestId('memory.draftTopic', 'reviews'); });
        await screen.pressByTestIdAsync('memory.draft.save');
        await settled();
        expect(execute).toHaveBeenCalledWith('memory.remember', {
            ref, expectedRevision: revision, topic: 'reviews', text: 'Ana reviews sync changes.',
        }, expect.objectContaining({ serverId: 'home-a', surface: 'ui' }));
        expect(source.refresh).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('memory.draft')).toBeNull();
    });

    it('with no document yet, the first fact goes to the Session target the host resolves', async () => {
        execute.mockResolvedValue({ ok: true, result: { ok: true, artifactId: 'created', factId: 'new' } });
        const sessionTarget = { sessionId: 's1', serverId: 'home-a', expectedMetadataRevision: 7 };
        const screen = await renderScreen(<Host source={sourceOf(null)} composing sessionTarget={sessionTarget} />);
        await React.act(async () => { screen.changeTextByTestId('memory.draft', 'Prefers short commits.'); });
        await screen.pressByTestIdAsync('memory.draft.save');
        await settled();
        expect(execute).toHaveBeenCalledWith('memory.remember', {
            sessionRef: { serverId: 'home-a', sessionId: 's1' }, expectedMetadataRevision: 7, text: 'Prefers short commits.',
        }, expect.anything());
    });

    it('a write conflict shows the current version and keeps what was typed', async () => {
        execute.mockResolvedValue({ ok: false, errorCode: 'version_mismatch', error: 'version_mismatch' });
        const source = sourceOf({ facts: [fact('f1', 'Old fact')] });
        const screen = await renderScreen(<Host source={source} composing />);
        await React.act(async () => { screen.changeTextByTestId('memory.draft', 'A newer fact'); });
        await screen.pressByTestIdAsync('memory.draft.save');
        await settled();
        expect(screen.findByTestId('memory.conflict')).toBeTruthy();
        expect(source.refresh).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('memory.draft')?.props.value).toBe('A newer fact');
    });

    it('archived facts are read-only', async () => {
        const screen = await renderScreen(<Host source={sourceOf({
            facts: [fact('old', 'Changelog order: Features, Fixes.')], topic: { title: 'archive', summary: 's' },
        })} />);
        expect(screen.findByTestId('memory.fact.old')).toBeTruthy();
        expect(screen.findByTestId('memory.fact.old.more')).toBeNull();
    });
});
