import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, renderScreen } from '@/dev/testkit';

import type { SessionSelectionRow } from './projectSessionSelectionRows';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});
vi.mock('@/components/ui/popover', async (importOriginal) => ({
    ...await importOriginal<object>(),
    Popover: (props: { open: boolean; children: (render: { maxHeight: number }) => React.ReactNode }) => props.open ? props.children({ maxHeight: 400 }) : null,
}));

const { SessionChooser } = await import('./SessionChooser');

const row = (sessionId: string, extra: Partial<SessionSelectionRow> = {}): SessionSelectionRow => ({
    id: `dev:${sessionId}`, address: { serverId: 'dev', sessionId }, label: sessionId, subtitle: '~/x', agentId: 'claude', machineId: null,
    machineName: 'Mac', place: 'x · Mac', working: false, statusText: '', statusTone: 'neutral', activityLabel: '', group: 'recent', ...extra,
});

async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }

describe('SessionChooser', () => {
    it('reads one page on open and one per query, and keeps only the newest answer', async () => {
        const answers: ((rows: readonly SessionSelectionRow[]) => void)[] = [];
        const readPage = vi.fn(() => new Promise<{ rows: readonly SessionSelectionRow[]; total: number }>((resolve) => {
            answers.push((rows) => resolve({ rows, total: rows.length }));
        }));
        const screen = await renderScreen(
            <SessionChooser open anchorRef={{ current: null }} readPage={readPage} selected={null} title="t" enterHint="here" onSelect={() => {}} onClose={() => {}} />,
        );
        await flush();
        expect(readPage).toHaveBeenCalledTimes(1);
        expect(readPage).toHaveBeenLastCalledWith({ query: '', offset: 0, limit: expect.any(Number) });
        const input = screen.root.findAll((node) => typeof node.props.onChangeText === 'function')[0];
        await act(async () => { input?.props.onChangeText('re'); });
        await flush();
        expect(readPage).toHaveBeenCalledTimes(2);
        await act(async () => { answers[1]?.([row('newest')]); });
        await flush();
        await act(async () => { answers[0]?.([row('stale')]); });
        await flush();
        const list = screen.root.findAll((node) => Array.isArray(node.props.rows))[0];
        expect(list?.props.rows.map((shown: SessionSelectionRow) => shown.label)).toEqual(['newest']);
    });

    it('offers New session only when the host can start one, pinned outside the rows', async () => {
        const readPage = vi.fn(async () => ({ rows: [row('one')], total: 1 }));
        const onNewSession = vi.fn();
        const screen = await renderScreen(
            <SessionChooser open anchorRef={{ current: null }} readPage={readPage} selected={null} title="t" enterHint="here" onSelect={() => {}} onNewSession={onNewSession} newSessionContext="x · Mac" onClose={() => {}} />,
        );
        await flush();
        const pressable = screen.root.findAll((node) => node.props.testID === 'session-chooser-new-session')[0];
        expect(pressable).toBeDefined();
        await act(async () => { pressable?.props.onPress(); });
        expect(onNewSession).toHaveBeenCalledTimes(1);
    });
});
