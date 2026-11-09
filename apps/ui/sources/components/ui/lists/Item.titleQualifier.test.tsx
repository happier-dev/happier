import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

afterEach(() => standardCleanup());

// Cold compilation belongs to collection, outside the per-test timeout.
const { Item } = await import('./Item');

/** The rendered title text's line budget (the node that carries the title string itself). */
async function titleLines(props: Readonly<{ titleQualifier?: string }>) {
    const screen = await renderScreen(
        <Item rowRole="catalogRow" title="NLDW6-3-11-20" subtitle="Offline · last seen 3 h ago" onPress={() => {}} {...props} />,
    );
    try {
        const title = screen.findAll(node => [node.props.children].flat()[0] === 'NLDW6-3-11-20' && 'numberOfLines' in node.props)[0];
        if (!title) throw new Error('title text not found');
        return title.props.numberOfLines as number | undefined;
    } finally {
        await screen.unmount();
    }
}

describe('Item titleQualifier', () => {
    it('keeps a qualified catalog title on one line so the telling suffix sits beside the whole name', async () => {
        // Two same-named machines are told apart by the suffix: the name shortens on its one line, it never breaks
        // into "NLDW6-3-11-" / "20" with the suffix squeezed beside the first half.
        expect(await titleLines({ titleQualifier: '0b83' })).toBe(1);
        // An unqualified catalog title keeps the catalog row's own wrapping.
        expect(await titleLines({})).toBeUndefined();
    });
    it('flows a wrapping title\'s qualifier after its last word instead of floating it to the line end (STORE N4)', async () => {
        const screen = await renderScreen(
            <Item rowRole="catalogRow" title="N1-QA · QA20 plugin review" titleQualifier="Plugin" titleLines={0} onPress={() => {}} />,
        );
        try {
            const title = screen.findAll(node => [node.props.children].flat()[0] === 'N1-QA · QA20 plugin review' && 'numberOfLines' in node.props)[0];
            // The qualifier is a run inside the title's own text, so it follows the wrapped name's last line.
            expect(title?.findAll(node => typeof node.props.children === 'string' && node.props.children.endsWith('Plugin')).length)
                .toBeGreaterThan(0);
            expect(screen.findAll(node => typeof node.props.children === 'string' && node.props.children === 'Plugin')).toHaveLength(0);
        } finally {
            await screen.unmount();
        }
    });
});
