import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// System boundary: the credential-bound Action executor. Its real contract returns a fresh
// result object on every render while `execute` keeps one identity per Account binding.
const execute = vi.fn(async () => ({ ok: true as const, result: { status: 'completed' } }));
vi.mock('@/components/approvals/useMountedActionExecution', () => ({
    useMountedActionExecution: () => ({ execute, approval: {}, isCurrent: () => true }),
}));

import { useCollectionSpaceEditing } from './useCollectionSpaceEditing';

const anchorRef = { current: null };
const currentFilter = {} as never;
const suggestion = { name: 'x', icon: { kind: 'icon', name: 'list' } } as never;
const summary: readonly string[] = [];
const spaces = [] as never;

let latest: ReturnType<typeof useCollectionSpaceEditing<'sessionWork'>> | null = null;
function Host(props: Readonly<{ tick: number }>) {
    void props.tick;
    latest = useCollectionSpaceEditing({
        entityKind: 'sessionWork', testIDPrefix: 'p', scope: { serverId: 'srv', accountId: 'account' }, spaces, selectedSpace: null,
        currentFilter, suggestion, summary, anchorRef,
    });
    return null;
}

describe('useCollectionSpaceEditing identity', () => {
    it('keeps its write entry points when only an unrelated parent render happens', async () => {
        const screen = await renderScreen(React.createElement(Host, { tick: 0 }));
        const first = latest!;
        await screen.update(React.createElement(Host, { tick: 1 }));
        expect(latest!.invoke).toBe(first.invoke);
        expect(latest!.saveChanges).toBe(first.saveChanges);
        expect(latest!.reorder).toBe(first.reorder);
        expect(latest!.selectSpace).toBe(first.selectSpace);
    });
});
