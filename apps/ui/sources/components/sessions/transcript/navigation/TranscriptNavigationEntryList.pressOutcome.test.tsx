import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installNavigationCommonModuleMocks } from '@/components/ui/navigation/navigationTestHelpers';
import type {
    TranscriptNavigationEntry,
    TranscriptNavigationEntryJumpOutcome,
} from './transcriptNavigationTypes';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

installNavigationCommonModuleMocks();

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

function entry(overrides: Partial<TranscriptNavigationEntry> & Pick<TranscriptNavigationEntry, 'id' | 'seq'>): TranscriptNavigationEntry {
    return {
        id: overrides.id,
        sessionId: 's1',
        seq: overrides.seq,
        routeMessageId: overrides.routeMessageId ?? `server:${overrides.id}`,
        transcriptBlockIndex: null,
        kind: overrides.kind ?? 'user-turn',
        role: overrides.role ?? 'user',
        label: overrides.label ?? `Prompt ${overrides.id}`,
        promptPreview: overrides.promptPreview ?? `Prompt ${overrides.id}`,
        responsePreview: overrides.responsePreview ?? null,
        createdAtMs: overrides.createdAtMs ?? Number(overrides.seq ?? 0) * 100,
        pinned: overrides.pinned ?? false,
        pinnedAtMs: overrides.pinnedAtMs ?? null,
        loaded: overrides.loaded ?? true,
    };
}

type Deferred = Readonly<{
    promise: Promise<TranscriptNavigationEntryJumpOutcome | void>;
    resolve: (outcome: TranscriptNavigationEntryJumpOutcome | void) => void;
    reject: (error: unknown) => void;
}>;

function deferred(): Deferred {
    let resolve!: Deferred['resolve'];
    let reject!: Deferred['reject'];
    const promise = new Promise<TranscriptNavigationEntryJumpOutcome | void>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

async function renderList(params: Readonly<{
    entries: readonly TranscriptNavigationEntry[];
    onEntryPress: (entry: TranscriptNavigationEntry) => unknown;
}>) {
    const { TranscriptNavigationEntryList } = await import('./TranscriptNavigationEntryList');
    return renderScreen(
        <TranscriptNavigationEntryList
            entries={params.entries}
            activeEntryId={null}
            onEntryPress={params.onEntryPress as never}
            testIDPrefix="nav"
        />,
    );
}

describe('TranscriptNavigationEntryList press outcomes', () => {
    it('shows an inline error with a retry affordance when the jump resolves not-found, and clears it after a successful retry', async () => {
        standardCleanup();
        const outcomes: Array<TranscriptNavigationEntryJumpOutcome> = [
            { status: 'not-found' },
            { status: 'scrolled' },
        ];
        const onEntryPress = vi.fn(async () => outcomes.shift());
        const screen = await renderList({
            entries: [entry({ id: 'turn-1', seq: 1 })],
            onEntryPress,
        });

        expect(screen.findByTestId('nav-entry-error:turn-1')).toBeNull();

        await screen.pressByTestIdAsync('nav-entry:turn-1');

        expect(onEntryPress).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('nav-entry-error:turn-1')).toBeTruthy();
        expect(screen.getTextContent()).toContain('session.transcriptNavigation.jumpFailed');
        expect(screen.findByTestId('nav-entry-retry:turn-1')).toBeTruthy();

        await screen.pressByTestIdAsync('nav-entry-retry:turn-1');

        expect(onEntryPress).toHaveBeenCalledTimes(2);
        expect(screen.findByTestId('nav-entry-error:turn-1')).toBeNull();
        expect(screen.findByTestId('nav-entry-retry:turn-1')).toBeNull();
    });

    it('shows an inline error when the jump promise rejects', async () => {
        standardCleanup();
        const onEntryPress = vi.fn(async () => {
            throw new Error('boom');
        });
        const screen = await renderList({
            entries: [entry({ id: 'turn-1', seq: 1 })],
            onEntryPress,
        });

        await screen.pressByTestIdAsync('nav-entry:turn-1');

        expect(screen.findByTestId('nav-entry-error:turn-1')).toBeTruthy();
        expect(screen.findByTestId('nav-entry-retry:turn-1')).toBeTruthy();
    });

    it('shows a pending indicator only for unloaded entries while the jump promise is in flight', async () => {
        standardCleanup();
        const unloadedJump = deferred();
        const screen = await renderList({
            entries: [
                entry({ id: 'turn-1', seq: 1, loaded: false }),
                entry({ id: 'turn-2', seq: 2, loaded: true }),
            ],
            onEntryPress: () => unloadedJump.promise,
        });

        await screen.pressByTestIdAsync('nav-entry:turn-1');
        expect(screen.findByTestId('nav-entry-pending:turn-1')).toBeTruthy();

        await act(async () => {
            unloadedJump.resolve({ status: 'window-rendered' });
            await unloadedJump.promise;
        });
        expect(screen.findByTestId('nav-entry-pending:turn-1')).toBeNull();
        expect(screen.findByTestId('nav-entry-error:turn-1')).toBeNull();

        const loadedJump = deferred();
        const loadedScreen = await renderList({
            entries: [entry({ id: 'turn-2', seq: 2, loaded: true })],
            onEntryPress: () => loadedJump.promise,
        });
        await loadedScreen.pressByTestIdAsync('nav-entry:turn-2');
        expect(loadedScreen.findByTestId('nav-entry-pending:turn-2')).toBeNull();
        await act(async () => {
            loadedJump.resolve({ status: 'scrolled' });
            await loadedJump.promise;
        });
    });

    it('clears silently on aborted outcomes and keeps supporting void-returning handlers', async () => {
        standardCleanup();
        const onAbortedPress = vi.fn(async (): Promise<TranscriptNavigationEntryJumpOutcome> => ({ status: 'aborted' }));
        const screen = await renderList({
            entries: [entry({ id: 'turn-1', seq: 1, loaded: false })],
            onEntryPress: onAbortedPress,
        });
        await screen.pressByTestIdAsync('nav-entry:turn-1');
        expect(screen.findByTestId('nav-entry-error:turn-1')).toBeNull();
        expect(screen.findByTestId('nav-entry-pending:turn-1')).toBeNull();

        const onVoidPress = vi.fn(() => undefined);
        const voidScreen = await renderList({
            entries: [entry({ id: 'turn-1', seq: 1 })],
            onEntryPress: onVoidPress,
        });
        await voidScreen.pressByTestIdAsync('nav-entry:turn-1');
        expect(onVoidPress).toHaveBeenCalledTimes(1);
        expect(voidScreen.findByTestId('nav-entry-error:turn-1')).toBeNull();
        expect(voidScreen.findByTestId('nav-entry-pending:turn-1')).toBeNull();
    });

    it('ignores a stale outcome when the entry is pressed again before the first jump settles', async () => {
        standardCleanup();
        const first = deferred();
        const second = deferred();
        const results = [first.promise, second.promise];
        const onEntryPress = vi.fn(() => results.shift());
        const screen = await renderList({
            entries: [entry({ id: 'turn-1', seq: 1, loaded: false })],
            onEntryPress,
        });

        await screen.pressByTestIdAsync('nav-entry:turn-1');
        await screen.pressByTestIdAsync('nav-entry:turn-1');

        await act(async () => {
            first.resolve({ status: 'not-found' });
            await first.promise;
        });
        // The stale first outcome must not surface an error for the superseding press.
        expect(screen.findByTestId('nav-entry-error:turn-1')).toBeNull();
        expect(screen.findByTestId('nav-entry-pending:turn-1')).toBeTruthy();

        await act(async () => {
            second.resolve({ status: 'window-rendered' });
            await second.promise;
        });
        expect(screen.findByTestId('nav-entry-pending:turn-1')).toBeNull();
        expect(screen.findByTestId('nav-entry-error:turn-1')).toBeNull();
    });
});
