import {
    ForgeReleaseActionResultSchemasV1, type ForgeReleaseActionInputByOperationV1, type ForgeReleaseActionResultByOperationV1,
    type ForgeReleaseAssetPageV1, type ForgeReleasePageV1, type ForgeReleaseV1,
} from '@happier-dev/triage-protocol/releases/v1';
import { reconcileReleaseAssetsV1, reconcileReleasePageV1, reconcileReleaseV1 } from './mapping.js';
import { forgeCiInvocationFailureV1 } from '@happier-dev/forge-ci/runtime';
import { MAX_TRIAGE_FAILURE_DETAIL_UTF8_BYTES_V1, normalizeTriageSingleLineV1, truncateTriageUtf8V1 } from '@happier-dev/triage-protocol/v1';

export type ReleaseReadOperationV1 = 'listReleases' | 'readLatestRelease' | 'readRelease' | 'listAssets';
type ReadInput<K extends ReleaseReadOperationV1> = ForgeReleaseActionInputByOperationV1[K];
type ReadResult<K extends ReleaseReadOperationV1> = ForgeReleaseActionResultByOperationV1[K];
type Unavailable = Extract<ReadResult<'readRelease'>, { kind: 'unavailable' }>;
type Value = ForgeReleaseV1 | ForgeReleasePageV1 | ForgeReleaseAssetPageV1 | null;
type Semantic = Readonly<{ kind: 'value'; value: Value }>;
type Cell = { operation: ReleaseReadOperationV1; value?: Semantic; validator?: string;
    input: ReadInput<ReleaseReadOperationV1>; pending?: Promise<Semantic | Unavailable>; controller?: AbortController;
    waiters: number; listeners: Set<() => void>; invalidators: Set<() => void> };
const unavailable = (code: string): Unavailable => ({ kind: 'unavailable', failure: { class: 'unsupportedContract', code } });
export const releaseReadQueryKeyV1 = (op: ReleaseReadOperationV1, input: ReadInput<ReleaseReadOperationV1>) => JSON.stringify([op,
    input.repository.kind, input.repository.deployment, input.repository.repository, input.repositoryId,
    'releaseId' in input ? input.releaseId : null, 'cursor' in input ? input.cursor ?? null : null, input.validator ?? null]);

/** One admitted ephemeral lifetime. No provider imports, polling, settled transport cache or durable state. */
export function createGithubReleaseReadsV1(options: Readonly<{
    invoke: (operation: ReleaseReadOperationV1, input: ReadInput<ReleaseReadOperationV1>, signal?: AbortSignal) => Promise<unknown>;
}>) {
    const cells = new Map<string, Cell>();
    // References into this same producer's retained values, shared across matching list/detail/latest coverage.
    const entities = new Map<string, ForgeReleaseV1>();
    let retired = false;
    const cellFor = (op: ReleaseReadOperationV1, input: ReadInput<ReleaseReadOperationV1>) => {
        const key = releaseReadQueryKeyV1(op, input); let cell = cells.get(key);
        if (!cell) { cell = { operation: op, input, waiters: 0, listeners: new Set(), invalidators: new Set() }; cells.set(key, cell); }
        return cell;
    };
    const entity = (incoming: ForgeReleaseV1) => {
        const key = JSON.stringify([incoming.repositoryId, incoming.releaseId]);
        const value = reconcileReleaseV1(entities.get(key), incoming); entities.set(key, value); return value;
    };
    async function invoke(operation: ReleaseReadOperationV1, input: ReadInput<ReleaseReadOperationV1>, signal: AbortSignal,
        transport: typeof options.invoke) {
        let raw: unknown;
        try { raw = await transport(operation, input, signal); }
        catch (error) { return { kind: 'unavailable', failure: forgeCiInvocationFailureV1(error, 'github_release_invocation_failed') } as const; }
        const result = ForgeReleaseActionResultSchemasV1[operation].safeParse(raw);
        if (result.success) return result.data;
        // Schema paths/codes identify the broken contract; never retain result values or error messages.
        const detail = truncateTriageUtf8V1(normalizeTriageSingleLineV1(`${operation}: ${result.error.issues
            .map(issue => `${issue.path.join('.')}:${issue.code}`).join('; ')}`), MAX_TRIAGE_FAILURE_DETAIL_UTF8_BYTES_V1).value;
        return { kind: 'unavailable', failure: { class: 'unsupportedContract', code: 'github_release_invalid_result', detail } } as const;
    }
    async function produce(operation: ReleaseReadOperationV1, input: ReadInput<ReleaseReadOperationV1>, cell: Cell,
        controller: AbortController, transport: typeof options.invoke): Promise<Semantic | Unavailable> {
        const request = { ...input, ...(cell.validator === undefined ? {} : { validator: cell.validator }) };
        let result = await invoke(operation, request, controller.signal, transport);
        if (result.kind === 'notModified' && cell.value === undefined) {
            const { validator: _validator, ...cold } = input;
            result = await invoke(operation, cold, controller.signal, transport);
            if (result.kind === 'notModified') return unavailable('github_release_cold_not_modified');
        }
        if (retired || controller.signal.aborted) return unavailable('github_release_scope_retired');
        if (result.kind === 'unavailable') return result;
        if (result.kind === 'notModified') {
            if (result.validator !== undefined) cell.validator = result.validator;
            return cell.value!;
        }
        // A 200 without a validator retires an older validator instead of reusing stale evidence.
        cell.validator = result.validator;
        const previous = cell.value;
        let value: Value;
        // The exact operation schema above proves the type in each indexed branch.
        if (operation === 'listReleases') {
            const page = result.value as ForgeReleasePageV1;
            value = reconcileReleasePageV1(previous?.value as ForgeReleasePageV1 | undefined, { ...page, rows: page.rows.map(entity) });
        } else if (operation === 'listAssets') value = reconcileReleaseAssetsV1(previous?.value as ForgeReleaseAssetPageV1 | undefined, result.value as ForgeReleaseAssetPageV1);
        else value = result.value === null ? null : entity(result.value as ForgeReleaseV1);
        if (previous?.value === value) return previous;
        const semantic: Semantic = { kind: 'value', value }; cell.value = semantic;
        for (const listener of cell.listeners) listener();
        return semantic;
    }
    // A shared corpus owns values/in-flight work, not a physical mount's authority.
    // Mounted consumers supply their current transport when starting a new read.
    async function read<K extends ReleaseReadOperationV1>(operation: K, input: ReadInput<K>, signal?: AbortSignal,
        transport: typeof options.invoke = options.invoke): Promise<ReadResult<K>> {
        if (retired || signal?.aborted) return unavailable('github_release_scope_retired') as ReadResult<K>;
        const cell = cellFor(operation, input);
        if (!cell.pending) {
            const controller = new AbortController(); cell.controller = controller;
            const pending = produce(operation, input, cell, controller, transport); cell.pending = pending;
            void pending.then(() => { if (cell.pending === pending) { cell.pending = undefined; cell.controller = undefined; } });
        }
        const pending = cell.pending;
        cell.waiters++;
        let abort: (() => void) | undefined;
        try {
            const result = signal ? await Promise.race([pending, new Promise<Unavailable>(resolve => {
                abort = () => resolve(unavailable('github_release_read_cancelled'));
                signal.addEventListener('abort', abort, { once: true });
                if (signal.aborted) abort();
            })]) : await pending;
            return result as ReadResult<K>;
        } finally {
            if (abort) signal?.removeEventListener('abort', abort);
            if (--cell.waiters === 0 && cell.pending === pending) cell.controller?.abort();
        }
    }
    return {
        read,
        subscribeSemantic<K extends ReleaseReadOperationV1>(operation: K, input: ReadInput<K>, listener: () => void) {
            if (retired) return () => {};
            const cell = cellFor(operation, input); cell.listeners.add(listener); return () => { cell.listeners.delete(listener); };
        },
        peek<K extends ReleaseReadOperationV1>(operation: K, input: ReadInput<K>): ReadResult<K> | undefined {
            return retired ? undefined : cells.get(releaseReadQueryKeyV1(operation, input))?.value as ReadResult<K> | undefined;
        },
        subscribeInvalidation<K extends ReleaseReadOperationV1>(operation: K, input: ReadInput<K>, listener: () => void) {
            if (retired) return () => {};
            const cell = cellFor(operation, input); cell.invalidators.add(listener); return () => { cell.invalidators.delete(listener); };
        },
        /** Only real affected facts notify presented demand; there is no background refresher. */
        invalidateRelease(releaseId: string, effect: 'created' | 'edited' | 'published') {
            for (const cell of cells.values()) {
                const listContains = cell.operation === 'listReleases' && (effect !== 'edited' || cell.value === undefined
                    || (cell.value.value as ForgeReleasePageV1).rows.some(row => row.releaseId === releaseId));
                const affects = listContains || (cell.operation === 'readLatestRelease' && effect === 'published')
                    || (cell.operation === 'readRelease' && 'releaseId' in cell.input && cell.input.releaseId === releaseId);
                if (!affects) continue;
                cell.validator = undefined;
                const notify = () => { if (!retired) for (const listener of cell.invalidators) listener(); };
                if (cell.pending) { cell.controller?.abort(); void cell.pending.then(notify); } else notify();
            }
        },
        dispose() { retired = true; for (const cell of cells.values()) { cell.controller?.abort(); cell.value = undefined;
            for (const listener of cell.listeners) listener();
            cell.listeners.clear(); cell.invalidators.clear(); } cells.clear(); entities.clear(); },
    };
}
export type GithubReleaseReadsV1 = ReturnType<typeof createGithubReleaseReadsV1>;
