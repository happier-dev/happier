import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

// Load the real row graph during collection, so cold source transforms do not consume an interaction's deadline.
const { CapabilityRow } = await import('./CapabilityRow');

afterEach(() => {
    standardCleanup();
});

const facts = { presentation: 'row' as const, source: { kind: 'git' as const, label: 'anthropics/skills' }, trust: 'runs_scripts' as const };

function texts(screen: Awaited<ReturnType<typeof renderScreen>>): string {
    return screen.getTextContent();
}

describe('CapabilityRow', () => {
    it.each(['page', 'rail'] as const)('uses the canonical status tone and independent fix in %s rows', async (density) => {
        const { StatusPill, StatusWord } = await import('@/components/ui/status/StatusPill');
        const { presentCapabilityStatus } = await import('../status/capabilityStatusPresentation');
        const onOpenOrToggle = vi.fn();
        for (const kind of ['cantrun', 'masked', 'revoked'] as const) {
            const onFix = vi.fn();
            const status = { kind, fix: { kind: 'compare' as const, onPress: onFix } };
            const expected = presentCapabilityStatus(status);
            const screen = await renderScreen(<CapabilityRow title="github" description="Issues and pull requests."
                status={status} density={density} checked={false} onPress={onOpenOrToggle} testID="row" />);
            expect(texts(screen)).toContain(expected.pill!.label);
            // One status word with the canonical tone: inline at the head of line 2, or the chip when it has a reason.
            const words = [...screen.findAllByType(StatusPill), ...screen.findAllByType(StatusWord)];
            expect(words).toHaveLength(1);
            expect(words[0]!.props.variant).toBe(expected.pill!.variant);
            expect(screen.findHostByTestId('row:status:fix')).not.toBeNull();
            await screen.pressByTestIdAsync('row:status:fix');
            expect(onFix).toHaveBeenCalledOnce();
            expect(onOpenOrToggle).not.toHaveBeenCalled();
            let ancestor = screen.findHostByTestId('row:status:fix')!.parent;
            while (ancestor) {
                expect(ancestor).not.toBe(screen.findHostByTestId('row'));
                ancestor = ancestor.parent;
            }
            await screen.unmount();
        }
    });

    it('keeps the full description in its accessible name when a rail fix takes the visible description slot', async () => {
        const screen = await renderScreen(<CapabilityRow title="github" description="Issues and pull requests."
            whereSummary="In payments" count={41} density="rail" onPress={() => {}}
            status={{ kind: 'signin', fix: { kind: 'sign_in', onPress: () => {} } }} testID="row" />);
        const row = screen.findHostByTestId('row')!;
        expect(row.props.accessibilityLabel ?? row.props['aria-label'] ?? '').toContain('Issues and pull requests.');
        expect(texts(screen)).toContain('41');
    });

    it.each(['page', 'rail'] as const)('admits the tool count once and no legacy facts line in %s catalog rows', async (density) => {
        for (const status of [undefined, { kind: 'ready' as const }, { kind: 'error' as const }]) {
            const screen = await renderScreen(<CapabilityRow title="docx" description="Word documents." density={density}
                count={41} facts={{ ...facts, cost: { toolCount: 41 } }} status={status} testID="row" />);
            expect(texts(screen).match(/41/g)).toHaveLength(1);
            expect(texts(screen)).not.toContain('anthropics/skills');
            expect(texts(screen)).not.toContain('41 tools');
            await screen.unmount();
        }
    });

    it('keeps a quiet consequence ("Runs scripts") on line 2 beside a speaking status, on the page and on a narrow rail with a fix', async () => {
        const { presentCapabilityStatus } = await import('../status/capabilityStatusPresentation');
        const quiet = await renderScreen(<CapabilityRow title="db-seed" description="Seed a local Postgres." lead="Runs scripts" testID="row" />);
        expect(texts(quiet)).toContain('Runs scripts');
        for (const [density, status] of [
            ['page', { kind: 'error' as const }],
            ['rail', { kind: 'signin' as const, fix: { kind: 'sign_in' as const, onPress: () => {} } }],
        ] as const) {
            const screen = await renderScreen(<CapabilityRow title="db-seed" description="Seed a local Postgres." lead="Runs scripts"
                status={status} density={density} onPress={() => {}} testID="row" />);
            expect(texts(screen)).toContain(presentCapabilityStatus(status).pill!.label);
            expect(texts(screen)).toContain('Runs scripts');
            await screen.unmount();
        }
    });

    it('moves a fix beneath the text only when its status word cannot fit whole beside it (large text, ST-5)', async () => {
        const { Item } = await import('@/components/ui/lists/Item');
        const { act } = await import('react-test-renderer');
        const status = { kind: 'signin' as const, fix: { kind: 'sign_in' as const, onPress: () => {} } };
        const screen = await renderScreen(<CapabilityRow title="docs-mcp" description="Remote MCP server for Tandem docs."
            status={status} density="rail" onPress={() => {}} testID="row" />);
        const layout = (width: number) => ({ nativeEvent: { layout: { x: 0, y: 0, width, height: 20 } } });
        const measured = (testID: string) => screen.findAll((node) => typeof node.type === 'string'
            && typeof node.props?.onLayout === 'function'
            && node.findAll((child) => child.props?.testID === testID).length > 0);
        const fixPlacement = () => {
            const item = screen.findByType(Item);
            return item.props.rightElement != null ? 'inline' : item.props.bottomElement != null ? 'beneath' : 'none';
        };
        const place = async (row: number, column: number | null, word: number) => {
            await act(async () => {
                measured('row:status:fix')[0]!.props.onLayout(layout(row));
                // The deepest box holding both the status word and its measure is the text column.
                if (column !== null) measured('row:status').filter((node) => node.findAll((child) => child.props?.testID === 'row:status:measure').length > 0)
                    .at(-1)!.props.onLayout(layout(column));
                measured('row:status:measure').at(-1)!.props.onLayout(layout(word));
            });
        };
        // A 300 px rail: the column beside the fix holds the word whole, so the pair shares the row.
        await place(300, 180, 90);
        expect(fixPlacement()).toBe('inline');
        // Large text: the same word no longer fits the room beside the fix, so the fix moves beneath the text.
        await place(300, null, 200);
        expect(fixPlacement()).toBe('beneath');
        expect(screen.findHostByTestId('row:status:fix')).not.toBeNull();
        // A wider row gives the word its room back beside the fix (judged by the inline room, so it never oscillates).
        // The fix returns beside the word, and the column the row then lays out (520 less the same 120) holds it.
        await place(520, 400, 200);
        expect(fixPlacement()).toBe('inline');
    });

    it('counts one tool in the singular and several in the plural', async () => {
        const one = await renderScreen(<CapabilityRow title="fetch" density="menu" facts={{ presentation: 'row', cost: { toolCount: 1 } }} testID="row" />);
        expect(texts(one)).toContain('1 tool');
        expect(texts(one)).not.toContain('1 tools');
        const many = await renderScreen(<CapabilityRow title="fetch" density="menu" facts={{ presentation: 'row', cost: { toolCount: 2 } }} testID="row" />);
        expect(texts(many)).toContain('2 tools');
    });

    it('draws the scope as its own column before the action in menu density, not on the title line', async () => {
        const { Text } = await import('@/components/ui/text/Text');
        const screen = await renderScreen(
            <CapabilityRow title="docx" whereSummary="Everywhere" action={<Text testID="action">Add</Text>} density="menu" testID="row" />,
        );
        const scope = screen.findAll((node) => node.props?.testID === 'row:scope');
        expect(scope.length).toBeGreaterThan(0);
        const columns = screen.findAll((node) => typeof node.type === 'string'
            && node.findAll((child) => child.props?.testID === 'row:scope').length > 0
            && node.findAll((child) => child.props?.testID === 'action').length > 0
            && node.findAll((child) => child.props?.children === 'docx').length === 0);
        expect(columns.length).toBeGreaterThan(0);
    });

    it('recomposes menu density on a narrow row: the status alone on line 2, the scope on line 3, the action still right', async () => {
        const { act } = await import('react');
        const { Text } = await import('@/components/ui/text/Text');
        const screen = await renderScreen(
            <CapabilityRow title="github" description="Issues and pull requests." whereSummary="Everywhere" status={{ kind: 'signin' }}
                action={<Text testID="action">Sign in</Text>} density="menu" testID="row" />,
        );
        const outer = screen.findAll((node) => typeof node.type === 'string' && typeof node.props?.onLayout === 'function'
            && node.findAll((child) => child.props?.testID === 'row:scope').length > 0)[0]!;
        await act(async () => {
            outer.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 360, height: 64 } } });
        });
        // No scope column beside the action any more.
        const columns = screen.findAll((node) => typeof node.type === 'string'
            && node.findAll((child) => child.props?.testID === 'row:scope').length > 0
            && node.findAll((child) => child.props?.testID === 'action').length > 0
            && node.findAll((child) => child.props?.children === 'github').length === 0);
        expect(columns).toHaveLength(0);
        // The status is the one line under the name (no description), and the scope follows it.
        expect(texts(screen)).not.toContain('Issues and pull requests.');
        const lines = screen.findAll((node) => typeof node.type === 'string'
            && node.findAll((child) => child.props?.testID === 'row:status').length > 0
            && node.findAll((child) => child.props?.testID === 'row:scope').length > 0)
            .at(-1)!;
        const order = lines.findAll((child) => child.props?.testID === 'row:status' || child.props?.testID === 'row:scope')
            .map((child) => child.props.testID as string);
        expect(order.indexOf('row:status')).toBeLessThan(order.indexOf('row:scope'));
        expect(screen.findAll((node) => node.props?.testID === 'action').length).toBeGreaterThan(0);
    });
    it('joins the scope to the facts on one narrow line, scope first ("Everywhere · 1.2k tokens")', async () => {
        const { act } = await import('react');
        const screen = await renderScreen(
            <CapabilityRow title="pdf" whereSummary="Everywhere" facts={{ presentation: 'row', cost: { tokensWhenUsed: 1200 } }} density="menu" testID="row" />,
        );
        const outer = screen.findAll((node) => typeof node.type === 'string' && typeof node.props?.onLayout === 'function')[0]!;
        await act(async () => {
            outer.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 360, height: 64 } } });
        });
        const words = texts(screen);
        expect(words).toContain('Everywhere');
        expect(words).toMatch(/tokens/);
        expect(words.indexOf('Everywhere')).toBeLessThan(words.search(/tokens/));
    });
    it('leaves no scope column and no separator when the scope is not known yet', async () => {
        const { act } = await import('react');
        const screen = await renderScreen(
            <CapabilityRow title="pdf" whereSummary="" facts={{ presentation: 'row', cost: { tokensWhenUsed: 1200 } }} density="menu" testID="row" />,
        );
        const outer = screen.findAll((node) => typeof node.type === 'string' && typeof node.props?.onLayout === 'function')[0]!;
        await act(async () => {
            outer.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 360, height: 64 } } });
        });
        expect(screen.findAll((node) => node.props?.testID === 'row:scope')).toHaveLength(0);
        expect(texts(screen)).not.toContain('·');
        expect(texts(screen)).toMatch(/tokens/);
    });
    it('says a stopped server short in its pill and its reason whole on the next line', async () => {
        const reason = "its sign-in couldn't be passed to this session";
        const screen = await renderScreen(
            <CapabilityRow title="linear" density="menu" status={{ kind: 'error', machineName: 'nl2', detail: reason }} testID="row" />,
        );
        const words = texts(screen);
        expect(words).toContain(reason);
        // The pill carries the short state only; the reason is not inside a one-line, truncating text.
        const truncating = screen.findAll((node) => node.props?.numberOfLines === 1 && JSON.stringify(node.props.children ?? '').includes(reason));
        expect(truncating).toHaveLength(0);
        expect(screen.findAll((node) => node.props?.children === reason && node.props.numberOfLines === undefined).length).toBeGreaterThan(0);
    });
});
