import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ScmLogEntry } from '@happier-dev/protocol';

import { renderScreen } from '@/dev/testkit';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
const textMock = createTextModuleMock({ translate: (key: string) => key });
vi.mock('@/text', () => textMock);
// Cold module transformation is collection, not the first rendered timeline interaction.
const { GitTimelineSection, resolveTimelineFillDelays } = await import('./GitTimelineSection');

function commit(shortSha: string, minutesAgo: number): ScmLogEntry {
    return {
        sha: `${shortSha}${'0'.repeat(33)}`,
        shortSha,
        authorName: 'Leeroy',
        authorEmail: '',
        timestamp: Date.now() - minutesAgo * 60_000,
        subject: `subject ${shortSha}`,
        body: '',
    };
}

const LOCAL_A = commit('aaaaaaa', 1);
const LOCAL_B = commit('bbbbbbb', 2);
const SHARED = commit('ccccccc', 3);
const INCOMING = commit('ddddddd', 0);

/** The ids of the timeline's rows, in reading order: commits by short SHA, origin as `origin`. */
async function readOrder(props: Partial<React.ComponentProps<typeof import('./GitTimelineSection').GitTimelineSection>>) {
    const screen = await renderScreen(
        <GitTimelineSection
            changedCount={2}
            selectedCount={0}
            ahead={0}
            behind={0}
            upstream="origin/v0.3"
            entries={[LOCAL_A, LOCAL_B, SHARED]}
            incoming={null}
            loading={false}
            hasMore={false}
            onLoadMore={() => {}}
            onOpenCommit={() => {}}
            landedSha={null}
            {...props}
        />,
    );
    const ids: string[] = [];
    for (const node of screen.root.findAll((candidate) => typeof candidate.props.testID === 'string' && typeof candidate.type === 'string')) {
        const testID = node.props.testID as string;
        const commitMatch = /^scm-commit-entry-([0-9a-f]{7})0+$/.exec(testID);
        if (commitMatch && !ids.includes(commitMatch[1]!)) ids.push(commitMatch[1]!);
        if (testID === 'session-git-timeline-origin' && !ids.includes('origin')) ids.push('origin');
    }
    return { ids, screen };
}

describe('GitTimelineSection (Git lab A/HI/S)', () => {
    it('puts origin right after the commits only this machine has', async () => {
        expect((await readOrder({ ahead: 2 })).ids).toEqual(['aaaaaaa', 'bbbbbbb', 'origin', 'ccccccc']);
        expect((await readOrder({ ahead: 0 })).ids).toEqual(['origin', 'aaaaaaa', 'bbbbbbb', 'ccccccc']);
    });

    it('draws what origin has above the branch, marked to pull, with origin at its tip', async () => {
        const { ids, screen } = await readOrder({ behind: 1, incoming: [INCOMING] });
        expect(ids).toEqual(['origin', 'ddddddd', 'aaaaaaa', 'bbbbbbb', 'ccccccc']);
        expect(screen.root.findAll((node) => node.props.testID === `scm-commit-entry-${INCOMING.sha}-tag-to-pull`).length).toBeGreaterThan(0);
    });

    it('marks the commit that just landed from the pane', async () => {
        const { screen } = await readOrder({ ahead: 2, landedSha: LOCAL_A.sha });
        expect(screen.root.findAll((node) => node.props.testID === `scm-commit-entry-${LOCAL_A.sha}-tag-just-now`).length).toBeGreaterThan(0);
        expect(screen.root.findAll((node) => node.props.testID === `scm-commit-entry-${LOCAL_B.sha}-tag-just-now`)).toHaveLength(0);
    });

    it('fills pushed nodes bottom-up and solidifies pulled ones top-down, and nothing on first sight', async () => {
        const newestFirst = [
            { sha: 'n3', relation: 'shared' as const },
            { sha: 'n2', relation: 'shared' as const },
            { sha: 'n1', relation: 'shared' as const },
            { sha: 'old', relation: 'shared' as const },
        ];
        expect([...resolveTimelineFillDelays(null, newestFirst)]).toEqual([]);
        const pushed = resolveTimelineFillDelays(new Map([['n3', 'local'], ['n2', 'local'], ['n1', 'local'], ['old', 'shared']]), newestFirst);
        expect([...pushed]).toEqual([['n1', 0], ['n2', 40], ['n3', 80]]);
        const pulled = resolveTimelineFillDelays(new Map([['n3', 'incoming'], ['n2', 'incoming'], ['n1', 'shared'], ['old', 'shared']]), newestFirst);
        expect([...pulled]).toEqual([['n3', 0], ['n2', 120]]);
    });
});
