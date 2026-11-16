import * as React from 'react';
import { PluginSessionInboxRowPageV1Schema, type PluginSessionInboxRowV1 } from '@happier-dev/protocol/plugins/contributions/ui/sessionInbox';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { PluginUiResourceEntry } from '@happier-dev/plugin-ui/advanced';
import type { PluginUiResourceSnapshot } from '@happier-dev/plugin-ui/hostApi';
import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { useLayoutPresentationSignal } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { acquirePluginContextualResourceStore, type PluginContextualResourceBinding } from '@/components/plugins/surfaces/PluginContextualResourceStoreProvider';
import { resolvePluginContextualResourceBinding } from '@/components/plugins/surfaces/pluginResourceBinding';
import { readPluginUiResourceProjection, type PluginUiResourceProjection } from '@/sync/domains/plugins/ui/projection';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { InboxPluginSessionRow } from '@/components/inbox/inboxItemProjection';
import { useInboxPluginSessionControls } from './useInboxPluginSessionControls';
import type { InboxPluginSessionControlInvoker } from './useInboxPluginSessionControls';
type Source = Readonly<{ rows: readonly InboxPluginSessionRow[]; loading: boolean; failed: boolean }>;
const EMPTY: Source = Object.freeze({ rows: Object.freeze([]), loading: false, failed: false });
type Page = {
    cursor: string | null;
    entry: PluginUiResourceEntry;
    release(): void;
    dispose(): void;
    value?: PluginUiResourceSnapshot['value'];
    rows: readonly InboxPluginSessionRow[];
    next: Page | null;
    nextCursor: string | null;
    loading: boolean;
    failed: boolean;
};

/** Paging is presentation demand over the incumbent Resource store, not another loader/watch owner. */
function observeIndex(input: Readonly<{
    index: PluginUiResourceProjection;
    detail: PluginUiResourceProjection;
    binding: PluginContextualResourceBinding;
    detailBinding(row: PluginSessionInboxRowV1): PluginContextualResourceBinding | null;
    publish(source: Source): void;
}>): () => void {
    let disposed = false;
    let root: Page | null = null;
    let previous = EMPTY;
    const retained = new Map<string, InboxPluginSessionRow>();
    const disposePage = (page: Page | null): void => {
        if (!page) return;
        disposePage(page.next);
        page.release(); page.dispose();
    };
    const publish = () => {
        if (disposed || !root) return;
        const rows: InboxPluginSessionRow[] = [];
        const ids = new Set<string>();
        let loading = false;
        let failed = false;
        for (let page: Page | null = root; page; page = page.next) {
            loading ||= page.loading;
            failed ||= page.failed;
            for (const row of page.rows) {
                if (ids.has(row.key)) { failed = true; continue; }
                ids.add(row.key); rows.push(row);
            }
        }
        const nextRows = rows.length === previous.rows.length && rows.every((row, i) => row === previous.rows[i]) ? previous.rows : rows;
        if (nextRows !== previous.rows || loading !== previous.loading || failed !== previous.failed) {
            previous = { rows: nextRows, loading, failed }; input.publish(previous);
        }
        for (const key of retained.keys()) if (!ids.has(key)) retained.delete(key);
    };
    const addPage = (cursor: string | null, ancestors: readonly (string | null)[]): Page | null => {
        const binding = { ...input.binding, context: { kind: 'surface' as const,
            mountInstanceKey: 'happier:session-inbox', launchInput: { cursor, serverId: input.binding.accountLifetime.scope.serverId } } };
        const lease = acquirePluginContextualResourceStore(binding);
        if (!lease) return null;
        const entry = lease.store.getEntry(input.index.id);
        const page: Page = { cursor, entry, dispose: lease.dispose, release: () => {},
            rows: [], next: null, nextCursor: null, loading: true, failed: false };
        const update = () => {
            if (disposed) return;
            const snapshot = entry.getSnapshot();
            page.loading = snapshot.pending !== 'idle' && !snapshot.value;
            page.failed = Boolean(snapshot.error);
            if (snapshot.value && page.value !== snapshot.value) {
                page.value = snapshot.value;
                try {
                    if (snapshot.value.contentType !== 'application/json') throw new Error('invalid_content_type');
                    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(snapshot.value.bytes));
                    const parsed = PluginSessionInboxRowPageV1Schema.parse(value);
                    if (parsed.kind !== 'ready') throw new Error(parsed.reason);
                    page.rows = parsed.rows.map(candidate => {
                        if (candidate.detailResource.pluginId !== input.index.pluginId || candidate.detailResource.resourceId !== input.detail.id
                            || !areServerProfileIdentifiersEquivalent(candidate.session.serverId, binding.accountLifetime.scope.serverId)) throw new Error('invalid_reference');
                        const row = { ...candidate, session: { ...candidate.session, serverId: binding.accountLifetime.scope.serverId } };
                        const detailBinding = input.detailBinding(row);
                        if (!detailBinding) throw new Error('unavailable_detail');
                        const key = JSON.stringify([input.index.pluginId, input.index.id, row.id]);
                        const before = retained.get(key);
                        const next = before && sameStrictJsonValue(before.row, row) ? before
                            : { key, pluginId: input.index.pluginId, indexResourceId: input.index.id, row, detailBinding };
                        retained.set(key, next);
                        return next;
                    });
                    if (parsed.nextCursor !== null && [...ancestors, cursor].includes(parsed.nextCursor)) throw new Error('invalid_cursor');
                    if (page.nextCursor !== parsed.nextCursor) {
                        disposePage(page.next); page.next = null; page.nextCursor = parsed.nextCursor;
                        if (parsed.nextCursor !== null) page.next = addPage(parsed.nextCursor, [...ancestors, cursor]);
                    }
                } catch {
                    page.rows = []; page.failed = true;
                    disposePage(page.next); page.next = null; page.nextCursor = null;
                }
            }
            publish();
        };
        page.release = entry.subscribe(update, true);
        update();
        return page;
    };
    root = addPage(null, []);
    if (!root) input.publish({ rows: [], loading: false, failed: true }); else publish();
    return () => { disposed = true; disposePage(root); retained.clear(); };
}

/** Mounted Inbox demand only. Unrelated Account/store arrivals do not enter this Resource path. */
export function useInboxPluginSessionRows(): Source & Readonly<{ invokeControl: InboxPluginSessionControlInvoker }> {
    const runtime = useAppShellPluginUiProjection();
    const presentedSignal = useLayoutPresentationSignal();
    const [source, setSource] = React.useState<Source>(EMPTY);
    const handles = React.useRef(new Map<string, { index: PluginUiResourceProjection; detail: PluginUiResourceProjection;
        lifetime: typeof runtime.accountLifetime; binding: PluginContextualResourceBinding; source: Source; dispose(): void }>());
    const lifetime = runtime.accountLifetime;
    const sourceLifetime = React.useRef(lifetime);
    const projection = runtime.pluginUiProjection;
    React.useEffect(() => {
        // Presentation only starts and stops this work: a subscription, so a show/hide renders nothing here.
        const start = (presented: boolean): (() => void) | void => {
            const active = presented && runtime.phase === 'current' && runtime.interactionEnabled && lifetime?.isCurrent();
            let unavailable = false;
            const publish = () => {
                const sources = [...handles.current.values()].map(handle => handle.source);
                const rows = sources.flatMap(value => value.rows);
                setSource(previous => {
                    const loading = sources.some(value => value.loading);
                    const failed = unavailable || sources.some(value => value.failed);
                    sourceLifetime.current = lifetime;
                    return rows.length === previous.rows.length && rows.every((row, i) => row === previous.rows[i])
                        && loading === previous.loading && failed === previous.failed ? previous : { rows, loading, failed };
                });
            };
            const wanted = new Set<string>();
            if (active && lifetime) for (const index of Object.values(projection?.resourcesById ?? {})) {
                if (!index.sessionInbox) continue;
                const key = buildQualifiedPluginContributionKey({ pluginId: index.pluginId, localId: index.id });
                const detail = readPluginUiResourceProjection(projection?.resourcesById,
                    { pluginId: index.pluginId, localId: index.sessionInbox.detailResourceId });
                if (!detail || index.scope !== 'surface' || detail.scope !== 'session') { unavailable = true; continue; }
                const admission = { projection, machineId: runtime.machineId, serverId: runtime.serverId,
                    accountLifetime: lifetime, requireReadAuthority: true, isCurrent: lifetime.isCurrent };
                const binding = resolvePluginContextualResourceBinding(admission, index,
                    { kind: 'surface', mountInstanceKey: 'happier:session-inbox', launchInput: { cursor: null, serverId: lifetime.scope.serverId } });
                if (!binding) { unavailable = true; continue; }
                wanted.add(key);
                const existing = handles.current.get(key);
                if (existing?.index === index && existing.detail === detail && existing.lifetime === lifetime
                    && existing.binding.machineId === binding.machineId && existing.binding.serverId === binding.serverId
                    && existing.binding.expectedCallerOccurrenceId === binding.expectedCallerOccurrenceId) continue;
                existing?.dispose();
                const handle = { index, detail, lifetime, binding, source: { rows: [], loading: true, failed: false } as Source, dispose: () => {} };
                handles.current.set(key, handle);
                handle.dispose = observeIndex({ index, detail, binding,
                    detailBinding: row => resolvePluginContextualResourceBinding(admission, detail,
                        { kind: 'session', sessionId: row.session.sessionId }),
                    publish: value => { if (handles.current.get(key) === handle) { handle.source = value; publish(); } },
                });
            }
            for (const [key, handle] of handles.current) if (!wanted.has(key)) { handle.dispose(); handles.current.delete(key); }
            publish();
            const retirement = lifetime?.onRetire(() => {
                for (const handle of handles.current.values()) handle.dispose();
                handles.current.clear(); sourceLifetime.current = null; setSource(EMPTY);
            });
            return () => retirement?.dispose();
        };
        let current = presentedSignal.get();
        let stop = start(current);
        const unsubscribe = presentedSignal.subscribe(() => {
            if (presentedSignal.get() === current) return;
            current = presentedSignal.get();
            stop?.();
            stop = start(current);
        });
        return () => { unsubscribe(); stop?.(); };
    }, [runtime.phase, runtime.interactionEnabled, lifetime, projection?.resourcesById, projection?.installedPackagesById, runtime.machineId, runtime.serverId, presentedSignal]);
    React.useEffect(() => () => { for (const handle of handles.current.values()) handle.dispose(); handles.current.clear(); }, []);
    const current = sourceLifetime.current === lifetime && lifetime?.isCurrent() ? source : EMPTY;
    const controls = useInboxPluginSessionControls(current.rows);
    return React.useMemo(() => ({ ...current, rows: controls.rows, invokeControl: controls.invokeControl }), [current, controls]);
}
