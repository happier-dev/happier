import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createThemeFixture } from '@/dev/testkit/fixtures/themeFixtures';

import { MachinesNeedsYouList } from './MachinesNeedsYouList';
import type { MachineAttentionEntry } from './collectMachineAttention';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
afterEach(async () => { await standardCleanup(); });

function entry(level: 'needs_you' | 'look'): MachineAttentionEntry {
    return {
        key: level, serverId: 'home-a', machineId: level, name: `build-box ${level}`, online: true, lastAutomaticAction: null,
        attention: { level, reasons: [{ key: 'memory', metric: 'memory', kind: 'memory_pressure', since: 1, level, nextStep: 'review_processes',
            pressure: level === 'needs_you' ? 'critical' : 'elevated', swapping: false }] },
    } as MachineAttentionEntry;
}

const theme = createThemeFixture() as unknown as { colors: { state: { attention: { textForeground: string }; danger: { textForeground: string } } } };
const colorsOf = (node: { props: { style?: unknown } }): unknown[] => [node.props.style].flat(Infinity as 1)
    .map(style => (style as { color?: unknown } | null)?.color).filter(Boolean);

describe('Machines needing you', () => {
    it('draws the reason word in the one attention amber at both levels, never the failure rose', async () => {
        const screen = await renderScreen(<MachinesNeedsYouList entries={[entry('needs_you'), entry('look')]} nowMs={Date.now()} onOpen={() => {}} />);
        const words = screen.findAllByType('Text').filter(node => /memory/i.test(String(node.props.children)) && colorsOf(node).length > 0);
        expect(words.length).toBeGreaterThanOrEqual(2);
        for (const word of words) {
            expect(colorsOf(word)).toContain(theme.colors.state.attention.textForeground);
            expect(colorsOf(word)).not.toContain(theme.colors.state.danger.textForeground);
        }
    });

    it('names a machine whose only problem is failing services, and opens its Services (TH MB-2)', async () => {
        const opened: unknown[] = [];
        const failing = { ...entry('look'), key: 'eadc', machineId: 'eadc', name: 'eadc', attention: { level: 'calm', reasons: [] }, failingServices: 8 } as MachineAttentionEntry;
        const screen = await renderScreen(<MachinesNeedsYouList entries={[entry('needs_you'), failing]} nowMs={Date.now()} onOpen={(_entry, tab) => opened.push(tab)} />);
        expect(screen.findByTestId('machines.needs-you.home-a.eadc')).not.toBeNull();
        await screen.pressByTestIdAsync('machines.needs-you.home-a.eadc.action');
        expect(opened).toEqual([{ id: 'services' }]);
    });

    it('says a machine\'s failing services beside its resource reason, so they are counted where it is listed (TH MB-2)', async () => {
        const both = { ...entry('look'), key: 'eadc', machineId: 'eadc', name: 'eadc', failingServices: 8 } as MachineAttentionEntry;
        const screen = await renderScreen(<MachinesNeedsYouList entries={[both]} nowMs={Date.now()} onOpen={() => {}} />);
        const row = screen.findByTestId('machines.needs-you.home-a.eadc');
        expect(row).not.toBeNull();
        expect(String(row!.props.accessibilityLabel)).toContain('machineAttention.words.servicesFailing');
    });

    it('on a phone keeps each row light: the row opens its reason\'s tab and no bordered button stands under it', async () => {
        const opened: unknown[] = [];
        const screen = await renderScreen(<MachinesNeedsYouList entries={[entry('needs_you'), entry('look')]} nowMs={Date.now()} compact
            onOpen={(_entry, tab) => opened.push(tab)} />);
        expect(screen.findByTestId('machines.needs-you.home-a.needs_you.action')).toBeNull();
        await screen.pressByTestIdAsync('machines.needs-you.home-a.needs_you');
        expect(opened).toEqual([{ id: 'processes', sort: 'memory' }]);
    });
});
