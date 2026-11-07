import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useExecutePluginAction, usePluginSurfaceActivity, usePluginUiEphemeralSharedScope } from '@happier-dev/plugin-ui/hostApi';
import type { ForgeReleaseActionInputByOperationV1 } from '@happier-dev/triage-protocol/releases/v1';
import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';
import { createGithubReleaseReadsV1, releaseReadQueryKeyV1, type GithubReleaseReadsV1, type ReleaseReadOperationV1 } from '../../releases/reads.js';
import { createReleaseEditorV1, type ReleaseEditorV1 } from './editor.js';
import type { ForgeReleaseV1 } from '@happier-dev/triage-protocol/releases/v1';
import { GITHUB_RELEASE_ACTION_REFS_V1 } from './model.js';
import type { PluginUiHostApi, RenderContext } from '@happier-dev/plugin-sdk/ui';
import { createReleaseAssetDownloadsV1, type ReleaseAssetDownloadsV1 } from './downloads.js';

const noSubscription = () => () => {};
const noValue = () => undefined;

/** The same admitted authority and transport for the Releases page and the existing Overview widget. */
export function useGithubReleaseBindingV1(context: RenderContext) {
    const target = context.surface.target;
    const repository = target.kind === 'project' && target.repository?.kind === 'github' ? target.repository : null;
    const authorityKey = JSON.stringify([context.surface.accountScope?.serverId ?? null, context.surface.accountScope?.accountId ?? null,
        repository?.kind ?? null, repository?.deployment ?? null, repository?.repository ?? null,
        target.kind === 'project' ? target.checkout?.machineId ?? null : null]);
    const host = context.hostApi;
    const invoke = useCallback<Parameters<typeof createGithubReleaseReadsV1>[0]['invoke']>((operation, input, signal) =>
        host.executeAction(GITHUB_RELEASE_ACTION_REFS_V1[operation], input as never, signal ? { signal } : undefined), [host]);
    const reads = useGithubReleaseReadsV1({ authorityKey, invoke });
    return { repository, authorityKey, reads };
}

export function useGithubLatestReleaseV1(context: RenderContext) {
    const binding = useGithubReleaseBindingV1(context);
    const query = useGithubReleaseQueryV1(binding.reads, 'readLatestRelease', binding.repository ? { repository: binding.repository } : null);
    return { ...binding, ...query, release: query.value?.kind === 'value' ? query.value.value : null };
}

/** Uses the existing host Action executor for admission, approval, cancellation and uncertain-result classification. */
export function useReleaseEditorInvokerV1(): Parameters<typeof createReleaseEditorV1>[0]['invoke'] {
    const generate = useExecutePluginAction(GITHUB_RELEASE_ACTION_REFS_V1.generateReleaseNotes);
    const create = useExecutePluginAction(GITHUB_RELEASE_ACTION_REFS_V1.createReleaseDraft);
    const edit = useExecutePluginAction(GITHUB_RELEASE_ACTION_REFS_V1.editReleaseDraft);
    const publish = useExecutePluginAction(GITHUB_RELEASE_ACTION_REFS_V1.publishReleaseDraft);
    const read = useExecutePluginAction(GITHUB_RELEASE_ACTION_REFS_V1.readRelease);
    const assets = useExecutePluginAction(GITHUB_RELEASE_ACTION_REFS_V1.listAssets);
    return useCallback<Parameters<typeof createReleaseEditorV1>[0]['invoke']>((operation, input) => {
        switch (operation) {
            case 'generateReleaseNotes': return generate.execute(input);
            case 'createReleaseDraft': return create.execute(input);
            case 'editReleaseDraft': return edit.execute(input);
            case 'publishReleaseDraft': return publish.execute(input);
            case 'readRelease': return read.execute(input);
            case 'listAssets': return assets.execute(input);
        }
    }, [generate.execute, create.execute, edit.execute, publish.execute, read.execute, assets.execute]);
}

/** authorityKey comes from the admitted account/binding/executor/repository, never a display name. */
export function useGithubReleaseReadsV1(options: Readonly<{
    authorityKey: string; invoke: Parameters<typeof createGithubReleaseReadsV1>[0]['invoke'];
}>): GithubReleaseReadsV1 | null {
    const scope = usePluginUiEphemeralSharedScope();
    const invokeRef = useRef(options.invoke); invokeRef.current = options.invoke;
    const [held, setHeld] = useState<{ scope: typeof scope; key: string; reads: GithubReleaseReadsV1 } | null>(null);
    useEffect(() => {
        const create = () => {
            const reads = createGithubReleaseReadsV1({ invoke: (operation, input, signal) => invokeRef.current(operation, input, signal) });
            return { value: reads, dispose: () => reads.dispose(), onExecutionOriginChange: () => reads.dispose() };
        };
        const lease = scope?.acquire(`github.release-reads.v1:${options.authorityKey}`, create) ?? null;
        if (scope && !lease) { setHeld(null); return; }
        const local = scope ? null : create();
        setHeld({ scope, key: options.authorityKey, reads: lease?.value ?? local!.value });
        return () => { lease?.release(); local?.dispose(); };
    }, [scope, options.authorityKey]);
    const reads = held?.scope === scope && held.key === options.authorityKey ? held.reads : null;
    // Sharing values must not borrow the creator mount's retired Host API.
    // As with CI's per-mount demand facade, each new read uses its caller's
    // current transport; pending reads and semantic subscriptions stay shared.
    return useMemo(() => reads ? {
        ...reads,
        read: (operation, input, signal) => reads.read(operation, input, signal,
            (operation, input, signal) => invokeRef.current(operation, input, signal)),
    } satisfies GithubReleaseReadsV1 : null, [reads]);
}

/** Semantic values subscribe independently from busy/failure facts. Disabled/hidden demand makes zero reads. */
export function useGithubReleaseQueryV1<K extends ReleaseReadOperationV1>(reads: GithubReleaseReadsV1 | null,
    operation: K, input: ForgeReleaseActionInputByOperationV1[K] | null, enabled = true) {
    const { active } = usePluginSurfaceActivity();
    const key = input === null ? null : releaseReadQueryKeyV1(operation, input);
    type Status = Readonly<{ pending: boolean; failure: TriageSourceFailureV1 | null }>;
    const [statusRecord, setStatusRecord] = useState<Readonly<{ reads: GithubReleaseReadsV1 | null; key: string | null; status: Status }> | null>(null);
    const subscribe = useCallback((listener: () => void) => reads && input && enabled && active
        ? reads.subscribeSemantic(operation, input, listener) : noSubscription(), [reads, operation, key, enabled, active]);
    const getValue = useCallback(() => reads && input ? reads.peek(operation, input) : undefined, [reads, operation, key]);
    const value = useSyncExternalStore(subscribe, getValue, noValue);
    const refreshRef = useRef<() => Promise<void>>(async () => {});
    useEffect(() => {
        const setStatus = (status: Status) => setStatusRecord({ reads, key, status });
        if (!reads || !input || !enabled || !active) { setStatus({ pending: false, failure: null }); return; }
        const controller = new AbortController();
        const refresh = async () => {
            if (controller.signal.aborted) return;
            setStatus({ pending: true, failure: null });
            const result = await reads.read(operation, input, controller.signal);
            if (!controller.signal.aborted) setStatus({ pending: false, failure: result.kind === 'unavailable' ? result.failure : null });
        };
        refreshRef.current = refresh;
        const unsubscribe = reads.subscribeInvalidation(operation, input, () => { void refresh(); });
        void refresh();
        return () => { refreshRef.current = async () => {}; controller.abort(); unsubscribe(); };
    }, [reads, operation, key, enabled, active]);
    const refresh = useCallback(() => refreshRef.current(), []);
    // Authority/query replacement must not briefly show another query's account-repair or failure state.
    const status: Status = statusRecord?.reads === reads && statusRecord.key === key
        ? statusRecord.status : { pending: enabled && active && reads !== null && input !== null, failure: null };
    return { value, status, refresh };
}

export function useReleaseEditorSnapshotV1(editor: ReleaseEditorV1 | null) {
    return useSyncExternalStore(editor?.subscribe ?? noSubscription, editor?.getSnapshot ?? (() => null), editor?.getSnapshot ?? (() => null));
}

/** Own real editor instances at page/authority lifetime, not at the route-conditioned visual leaf. */
export function useReleaseEditorLifetimeV1(options: Readonly<{
    authorityKey: string; signal: AbortSignal; target: Parameters<typeof createReleaseEditorV1>[0]['target'];
    selected: 'compose' | ForgeReleaseV1 | null; seed: Readonly<{ tagName: string; targetCommitish: string; previousTagName: string }>;
    onSaved: NonNullable<Parameters<typeof createReleaseEditorV1>[0]['onSaved']>;
}>) {
    const invoke = useReleaseEditorInvokerV1();
    const latest = useRef({ ...options, invoke }); latest.current = { ...options, invoke };
    const [held, setHeld] = useState<Readonly<{ authorityKey: string; signal: AbortSignal; editors: Map<string, ReleaseEditorV1> }> | null>(null);
    useEffect(() => {
        if (options.signal.aborted) return;
        const editors = new Map<string, ReleaseEditorV1>();
        const dispose = () => { for (const editor of editors.values()) editor.dispose(); editors.clear(); };
        options.signal.addEventListener('abort', dispose, { once: true });
        setHeld({ authorityKey: options.authorityKey, signal: options.signal, editors });
        return () => { options.signal.removeEventListener('abort', dispose); dispose(); };
    }, [options.authorityKey, options.signal]);
    const owner = held?.authorityKey === options.authorityKey && held.signal === options.signal && !options.signal.aborted ? held : null;
    const key = options.selected === null ? null : options.selected === 'compose' ? 'compose' : options.selected.releaseId;
    const [selected, setSelected] = useState<Readonly<{ owner: typeof owner; key: string; editor: ReleaseEditorV1 }> | null>(null);
    useEffect(() => {
        const current = latest.current;
        if (!owner || key === null) { setSelected(null); return; }
        let editor = owner.editors.get(key);
        const initial = current.selected === null || current.selected === 'compose' ? undefined : current.selected;
        if (!editor) {
            editor = createReleaseEditorV1({ target: current.target, ...(initial ? { initial } : {}),
                invoke: (operation, input) => latest.current.invoke(operation, input),
                onSaved: (release, effect) => {
                    if (effect === 'created' && editor) { owner.editors.set(release.releaseId, editor); owner.editors.delete('compose'); }
                    latest.current.onSaved(release, effect);
                } });
            if (!initial) {
                for (const field of ['tagName', 'targetCommitish', 'previousTagName'] as const)
                    if (current.seed[field]) void editor.invoke({ kind: 'setField', field, value: current.seed[field] });
                if (/-(rc|beta|alpha|pre)/iu.test(current.seed.tagName)) void editor.invoke({ kind: 'setPrerelease', value: true });
            }
            owner.editors.set(key, editor);
        } else if (initial) editor.receive(initial);
        setSelected({ owner, key, editor });
    }, [owner, key, options.selected]);
    return owner && selected?.owner === owner && selected.key === key ? selected.editor : null;
}

/** Both the page and its editor consume this one authority-scoped canonical-result binding. */
export function useReleaseAssetDownloadsV1(host: Pick<PluginUiHostApi, 'downloadFile'>, authorityKey: string): ReleaseAssetDownloadsV1 {
    const [held, setHeld] = useState<Readonly<{ host: typeof host; key: string; controller: ReturnType<typeof createReleaseAssetDownloadsV1> }> | null>(null);
    useEffect(() => {
        const controller = createReleaseAssetDownloadsV1(host);
        setHeld({ host, key: authorityKey, controller });
        return () => controller.dispose();
    }, [host, authorityKey]);
    const controller = held?.host === host && held.key === authorityKey ? held.controller : null;
    const state = useSyncExternalStore(controller?.subscribe ?? noSubscription, controller?.getSnapshot ?? emptyDownloads, emptyDownloads);
    const download = useCallback<ReleaseAssetDownloadsV1['download']>(async (release, asset) => { await controller?.download(release, asset); }, [controller]);
    return { state, download };
}
const EMPTY_DOWNLOADS: ReleaseAssetDownloadsV1['state'] = new Map();
const emptyDownloads = () => EMPTY_DOWNLOADS;
/** Markdown consumers can subscribe just to fields; preview/busy/freshness keep the same admitted text inputs. */
export function useReleaseEditorFieldsV1(editor: ReleaseEditorV1 | null) {
    const getFields = useCallback(() => editor?.getSnapshot()?.fields ?? null, [editor]);
    return useSyncExternalStore(editor?.subscribe ?? noSubscription, getFields, getFields);
}
