import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';

// The sync orchestrator reads and decrypts every session over the network; that is the boundary
// the sheet sits on. Each call records what it was asked for and reports progress like the real
// archive writer: one tick per hosted transcript, the failed ones counted.
type ExportCall = Readonly<{ format: string; includeSubagents: boolean; retrySessionIds?: readonly string[] }>;
const calls: ExportCall[] = [];
let failNext: readonly string[] = [];
vi.mock('@/sync/sync', () => ({
    sync: {
        exportAccountTranscripts: async (params: ExportCall & {
            write: (bytes: Uint8Array) => Promise<void>;
            onProgress?: (progress: { done: number; failed: number }) => void;
        }) => {
            calls.push({ format: params.format, includeSubagents: params.includeSubagents, retrySessionIds: params.retrySessionIds });
            const ids = params.retrySessionIds ?? ['a', 'b', 'c'];
            const failed = ids.filter((id) => failNext.includes(id));
            ids.forEach((_, index) => params.onProgress?.({ done: index + 1, failed: Math.min(failed.length, index + 1) }));
            await params.write(new Uint8Array(2048));
            failNext = [];
            return { failedSessionIds: failed, skippedExternalCount: 0 };
        },
    },
}));

// Saving is the platform's download / share sheet.
const saved: string[] = [];
let waitForSave: Promise<void> | undefined;
vi.mock('@/sync/runtime/files/saveFileBytes', () => ({
    saveFileStream: async (input: { name: string }, write: (sink: (bytes: Uint8Array) => Promise<void>) => Promise<unknown>) => {
        saved.push(input.name);
        const output = await write(async () => {});
        // The archive is handed to the platform after the last transcript is written.
        await waitForSave;
        return output;
    },
    saveFileBytes: async (input: { name: string }) => {
        saved.push(input.name);
        await waitForSave;
    },
}));

const flush = () => act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
});

type StepNode = Readonly<{ props: { testID?: unknown; accessibilityState?: { checked?: boolean; selected?: boolean } } }>;

/** Each export step's state as the timeline presents it: done, current, or still to come. */
function stepStates(screen: Readonly<{ root: { findAll: (predicate: (node: StepNode) => boolean) => StepNode[] } }>): Record<string, string> {
    const states: Record<string, string> = {};
    for (const node of screen.root.findAll((candidate) => String(candidate.props.testID ?? '').startsWith('export-step-') && candidate.props.accessibilityState !== undefined)) {
        const state = node.props.accessibilityState!;
        states[String(node.props.testID).slice('export-step-'.length)] = state.checked ? 'done' : state.selected ? 'current' : 'pending';
    }
    return states;
}

describe('ExportSheet', () => {
    beforeEach(() => {
        calls.length = 0;
        saved.length = 0;
        failNext = [];
        waitForSave = undefined;
    });

    it('exports everything with the chosen format and subagent choice, then retries only the sessions that failed', async () => {
        const { ExportSheet } = await import('./ExportSheet');
        const screen = await renderScreen(<ExportSheet onClose={() => {}} initialScope="everything" totalSessions={3} />);
        const press = async (testID: string) => {
            const node = screen.root.find((candidate) => candidate.props.testID === testID && typeof candidate.props.onPress === 'function');
            await act(async () => node.props.onPress());
        };

        // One scope from Settings: no scope switch, only format and subagents.
        expect(screen.root.findAll((node) => String(node.props.testID ?? '').startsWith('export-scope:'))).toHaveLength(0);
        await press('export-format:json');
        const subagents = screen.root.find((node) => node.props.accessibilityLabel !== undefined && typeof node.props.onValueChange === 'function');
        await act(async () => subagents.props.onValueChange(false));

        failNext = ['b'];
        await press('export-sheet-start');
        await flush();

        expect(calls).toEqual([{ format: 'json', includeSubagents: false, retrySessionIds: undefined }]);
        expect(saved).toHaveLength(1);
        expect(saved[0]).toMatch(/^happier-export-\d{4}-\d{2}-\d{2}\.zip$/);
        expect(screen.root.findAllByProps({ testID: 'export-sheet-failed' }).length).toBeGreaterThan(0);

        await press('export-sheet-retry-failed');
        await flush();

        expect(calls[1]).toEqual({ format: 'json', includeSubagents: false, retrySessionIds: ['b'] });
        expect(saved[1]).toMatch(/-retry\.zip$/);
        expect(screen.root.findAllByProps({ testID: 'export-sheet-failed' })).toHaveLength(0);
        expect(screen.root.findAllByProps({ testID: 'export-sheet-done' }).length).toBeGreaterThan(0);
    });

    it('offers the selection, the session and everything from a transcript selection, and saves only the selection without asking the server', async () => {
        const { ExportSheet } = await import('./ExportSheet');
        const selected = [{
            kind: 'user-text' as const,
            id: 'm1',
            localId: null,
            createdAt: 1,
            text: 'Fix the relay',
            displayText: 'Fix the relay',
        }];
        const screen = await renderScreen(
            <ExportSheet onClose={() => {}} initialScope="selection" sessionId="s-1" selectedMessages={selected as never} />,
        );
        const tabs = screen.root.findAll((node) => String(node.props.testID ?? '').startsWith('export-scope:') && typeof node.props.onPress === 'function');
        expect(tabs.map((node) => node.props.testID)).toEqual(['export-scope:selection', 'export-scope:session', 'export-scope:everything']);

        const start = screen.root.find((node) => node.props.testID === 'export-sheet-start' && typeof node.props.onPress === 'function');
        const save = createDeferred<void>();
        waitForSave = save.promise;
        await act(async () => start.props.onPress());
        await flush();

        expect(stepStates(screen)).toEqual({ format: 'done', save: 'current' });
        await act(async () => save.resolve());
        expect(screen.root.findAllByProps({ testID: 'export-sheet-done' }).length).toBeGreaterThan(0);
        expect(calls).toEqual([]);
        expect(saved).toEqual(['happier-s-1-selection.md']);
    });
    it('shows everything as reading the sessions, then zipping and saving, from the job’s own stages', async () => {
        const { ExportSheet } = await import('./ExportSheet');
        const screen = await renderScreen(<ExportSheet onClose={() => {}} initialScope="everything" totalSessions={3} />);
        const save = createDeferred<void>();
        waitForSave = save.promise;
        const start = screen.root.find((node) => node.props.testID === 'export-sheet-start' && typeof node.props.onPress === 'function');
        await act(async () => start.props.onPress());
        await flush();

        // Every transcript is read; the archive is now with the platform's save path.
        expect(stepStates(screen)).toEqual({ read: 'done', save: 'current' });
        await act(async () => save.resolve());
        expect(screen.root.findAllByProps({ testID: 'export-sheet-done' }).length).toBeGreaterThan(0);
    });
});
