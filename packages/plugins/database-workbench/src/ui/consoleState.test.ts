import { expect, it } from 'vitest';
import { createConsoleState, type ConsoleState } from './consoleState.js';

it('persists only SQL/history and restores on demand without storing parameters or row values', async () => {
    let stored: ConsoleState | null = null;
    let reads = 0;
    const storage = { read: async () => { reads++; return stored; }, write: async (value: ConsoleState) => { stored = value; } };
    const console = createConsoleState(storage);
    expect(reads).toBe(0);
    await console.edit('select $1');
    await console.record({ sql: 'select $1', parameters: ['private'] } as { sql: string });
    expect(stored).toEqual({ sql: 'select $1', history: [{ sql: 'select $1' }] });
    const reopened = createConsoleState(storage);
    await reopened.load();
    expect(reopened.get()).toEqual(stored);
    await reopened.clearHistory();
    expect(stored).toEqual({ sql: 'select $1', history: [] });
});

it('preserves local input and surfaces storage errors for visible recovery', async () => {
    const console = createConsoleState({ read: async () => null, write: async () => { throw new Error('storage unavailable'); } });
    await expect(console.edit('select 1')).rejects.toThrow('storage unavailable');
    expect(console.get().sql).toBe('select 1');
});

it('records a transaction history in one publication and one device write', async () => {
    const writes: ConsoleState[] = [];
    const console = createConsoleState({ read: async () => null, write: async state => { writes.push(state); } });
    let publications = 0;
    console.subscribe(() => publications++);
    await console.recordMany([{ sql: 'update first_table set value = $1', parameters: ['private'] } as { sql: string },
        { sql: 'update second_table set value = $1' }]);
    expect(console.get().history).toEqual([{ sql: 'update first_table set value = $1' }, { sql: 'update second_table set value = $1' }]);
    expect(publications).toBe(1);
    expect(writes).toEqual([console.get()]);
});

it('hydrates once and merges typing and recorded SQL before persisting', async () => {
    let resolveRead!: (state: ConsoleState) => void;
    const delayed = new Promise<ConsoleState>(resolve => { resolveRead = resolve; });
    const writes: ConsoleState[] = [];
    let reads = 0;
    const console = createConsoleState({ read: () => { reads++; return delayed; }, write: async value => { writes.push(value); } });
    const firstLoad = console.load();
    const secondLoad = console.load();
    const edited = console.edit('select typed');
    const recorded = console.record({ sql: 'select recorded' });
    await Promise.resolve();
    expect(reads).toBe(1);
    expect(writes).toEqual([]);
    expect(console.get().sql).toBe('select typed');
    resolveRead({ sql: 'select saved', history: [{ sql: 'select old' }] });
    await Promise.all([firstLoad, secondLoad, edited, recorded]);
    expect(console.get()).toEqual({ sql: 'select typed', history: [{ sql: 'select old' }, { sql: 'select recorded' }] });
    expect(writes).toEqual([
        { sql: 'select typed', history: [{ sql: 'select old' }] },
        console.get(),
    ]);
});

it('honours clear before hydration and retains only subsequent history', async () => {
    let resolveRead!: (state: ConsoleState) => void;
    const delayed = new Promise<ConsoleState>(resolve => { resolveRead = resolve; });
    const writes: ConsoleState[] = [];
    const console = createConsoleState({ read: () => delayed, write: async value => { writes.push(value); } });
    const loaded = console.load();
    const cleared = console.clearHistory();
    const recorded = console.record({ sql: 'select after_clear' });
    resolveRead({ sql: 'select saved', history: [{ sql: 'select old' }] });
    await Promise.all([loaded, cleared, recorded]);
    expect(console.get()).toEqual({ sql: 'select saved', history: [{ sql: 'select after_clear' }] });
    expect(writes).toEqual([
        { sql: 'select saved', history: [] },
        console.get(),
    ]);
});

it('preserves hydrated history and early edits when a device write fails', async () => {
    let resolveRead!: (state: ConsoleState) => void;
    const delayed = new Promise<ConsoleState>(resolve => { resolveRead = resolve; });
    const writes: ConsoleState[] = [];
    let attempts = 0;
    const console = createConsoleState({ read: () => delayed, write: async value => {
        if (attempts++ === 0) throw new Error('storage unavailable');
        writes.push(value);
    } });
    const loaded = console.load();
    const failed = expect(console.edit('select typed')).rejects.toThrow('storage unavailable');
    const recorded = console.record({ sql: 'select after_failure' });
    resolveRead({ sql: 'select saved', history: [{ sql: 'select old' }] });
    await Promise.all([loaded, failed, recorded]);
    expect(console.get()).toEqual({ sql: 'select typed', history: [{ sql: 'select old' }, { sql: 'select after_failure' }] });
    expect(writes).toEqual([console.get()]);
});

it('reports a failed hydration without writing an empty replacement', async () => {
    let rejectRead!: (error: Error) => void;
    const delayed = new Promise<ConsoleState>((_resolve, reject) => { rejectRead = reject; });
    const writes: ConsoleState[] = [];
    const console = createConsoleState({ read: () => delayed, write: async value => { writes.push(value); } });
    const loaded = expect(console.load()).rejects.toThrow('read unavailable');
    const edited = expect(console.edit('select typed')).rejects.toThrow('read unavailable');
    rejectRead(new Error('read unavailable'));
    await Promise.all([loaded, edited]);
    expect(writes).toEqual([]);
    expect(console.get().sql).toBe('select typed');
});
