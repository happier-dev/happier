import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';

import { AGENT_ACTIVITY_ROW_NO_ACTIONS, type AgentActivityRowEntry } from '../agentActivityRowEntry';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => false,
}));

const layoutMutations = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));

vi.mock('@/components/sessions/transcript/measurement/TranscriptRowLayoutMutationContext', () => ({
    useTranscriptRowLayoutMutation: () => (mutation: Record<string, unknown>) => {
        layoutMutations.calls.push(mutation);
    },
}));

function makeEntry(overrides: Partial<AgentActivityRowEntry> = {}): AgentActivityRowEntry {
    return {
        id: 'entry-1',
        status: 'succeeded',
        title: 'researcher',
        actions: AGENT_ACTIVITY_ROW_NO_ACTIONS,
        ...overrides,
    };
}

async function importDisclosure() {
    return (await import('./AgentActivityDisclosure')).AgentActivityDisclosure;
}

function findRowProps(screen: Awaited<ReturnType<typeof renderScreen>>): Record<string, unknown> {
    const matches = screen.tree.root.findAll((node) => {
        const nodeProps = node.props as Record<string, unknown> | undefined;
        return nodeProps != null
            && 'showChevron' in nodeProps
            && 'iconBoxSize' in nodeProps
            && 'subtitleLines' in nodeProps;
    });
    expect(matches).toHaveLength(1);
    return matches[0].props as Record<string, unknown>;
}

async function pressRow(screen: Awaited<ReturnType<typeof renderScreen>>) {
    const pressable = screen.tree.root
        .findAllByProps({ testID: 'row' })
        .find((node) => typeof (node.props as { onPress?: unknown }).onPress === 'function');
    await pressTestInstanceAsync(pressable, 'agent activity disclosure row');
}

describe('AgentActivityDisclosure', () => {
    beforeEach(() => {
        layoutMutations.calls = [];
    });

    it('renders a plain read-only row when there is nothing to disclose', async () => {
        const AgentActivityDisclosure = await importDisclosure();
        const screen = await renderScreen(
            <AgentActivityDisclosure entry={makeEntry()} testID="row" />,
        );

        const rowProps = findRowProps(screen);
        // No caret, no press target, no expanded state: the affordance is the presence of a body,
        // never a flag, so a row with no body cannot advertise one.
        expect(rowProps.onPress).toBeUndefined();
        expect((rowProps.accessibilityState as Record<string, unknown>).expanded).toBeUndefined();

        act(() => screen.tree.unmount());
    });

    it('discloses the host body on press and hides it again', async () => {
        const AgentActivityDisclosure = await importDisclosure();
        const screen = await renderScreen(
            <AgentActivityDisclosure
                entry={makeEntry()}
                body={<Body />}
                testID="row"
            />,
        );

        expect(screen.tree.root.findAllByProps({ testID: 'disclosed-body' })).toHaveLength(0);
        expect((findRowProps(screen).accessibilityState as Record<string, unknown>).expanded).toBe(false);

        await pressRow(screen);

        expect(screen.tree.root.findAllByProps({ testID: 'disclosed-body' }).length).toBeGreaterThan(0);
        expect((findRowProps(screen).accessibilityState as Record<string, unknown>).expanded).toBe(true);

        await pressRow(screen);

        expect(screen.tree.root.findAllByProps({ testID: 'disclosed-body' })).toHaveLength(0);

        act(() => screen.tree.unmount());
    });

    it('tells the transcript measurement owner that the row height changed', async () => {
        const AgentActivityDisclosure = await importDisclosure();
        const screen = await renderScreen(
            <AgentActivityDisclosure entry={makeEntry()} body={<Body />} testID="row" />,
        );

        await pressRow(screen);
        await pressRow(screen);

        // Without this the transcript's cached row height outlives the expansion and the list
        // scrolls to the wrong place — the exact defect the context exists to prevent.
        expect(layoutMutations.calls).toEqual([
            { reason: 'expand', sourceId: 'entry-1' },
            { reason: 'collapse', sourceId: 'entry-1' },
        ]);

        act(() => screen.tree.unmount());
    });

    it('keeps the row one line: the body is a sibling, never the row subtitle', async () => {
        const AgentActivityDisclosure = await importDisclosure();
        const screen = await renderScreen(
            <AgentActivityDisclosure
                entry={makeEntry({ metaDetail: '1.2k tokens' })}
                body={<Body />}
                metaPlacement="inline"
                testID="row"
            />,
        );

        await pressRow(screen);

        const rowProps = findRowProps(screen);
        expect(rowProps.subtitle).toBeNull();
        expect(rowProps.detail).toBe('1.2k tokens');

        act(() => screen.tree.unmount());
    });

    it('suppresses the row divider while expanded so the row and its body read as one block', async () => {
        const AgentActivityDisclosure = await importDisclosure();
        const screen = await renderScreen(
            <AgentActivityDisclosure entry={makeEntry()} body={<Body />} showDivider testID="row" />,
        );

        expect(findRowProps(screen).showDivider).toBe(true);

        await pressRow(screen);

        expect(findRowProps(screen).showDivider).toBe(false);

        act(() => screen.tree.unmount());
    });
});

function Body() {
    return React.createElement('DisclosedBody', { testID: 'disclosed-body' });
}
