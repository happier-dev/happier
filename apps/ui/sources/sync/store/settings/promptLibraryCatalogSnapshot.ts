import type { PromptLibraryCatalogSnapshotV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { readPromptLibraryCatalogRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PromptLibraryCatalogKeyV1Schema, type PromptLibraryCatalogKeyV1, type PromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createRowInventoryReceiptOrdering } from './rowInventoryReceiptOrdering';
import type { ReachRulesV1 } from '@happier-dev/protocol/reach/reachRuleV1';

export type PromptLibraryValueV1<K extends PromptLibraryCatalogKeyV1> = Extract<PromptLibraryRecordV1, { key: K }>['value'];
export type PromptLibraryCatalogValueSnapshot<K extends PromptLibraryCatalogKeyV1> = Readonly<{
    status: 'loading' | 'ready' | 'unavailable'; value: PromptLibraryValueV1<K> | null;
    revision: number | 'absent'; sourceSettingsVersion: number | null; stale: boolean; reason?: string;
}>;
export type PromptLibraryCatalogProjection = Readonly<{
    catalog: PromptLibraryCatalogSnapshotV1; rawSettings: Readonly<Record<string, unknown>>; sourceSettingsVersion: number;
}>;
type StoredSnapshot = Readonly<{ scope: ServerAccountScope; projection: PromptLibraryCatalogProjection;
    values: ReadonlyMap<PromptLibraryCatalogKeyV1, PromptLibraryCatalogValueSnapshot<PromptLibraryCatalogKeyV1>>;
    skillRuleDrafts?: ReadonlyMap<string, ReachRulesV1>;
    skillRulesView?: PromptLibraryCatalogValueSnapshot<'skill-rules'> }>;
const snapshots = new Map<string, StoredSnapshot>();
const receiptOrdering = createRowInventoryReceiptOrdering();
const listeners = new Set<() => void>();
const admissionLossReasons = ['account-mode-mismatch', 'encryption-material-unavailable', 'unauthorized', 'forbidden',
    'account-not-found', 'account-inconsistent', 'invalid-stored-content'];
const loading = Object.freeze({ status: 'loading', value: null, revision: 'absent', sourceSettingsVersion: null, stale: true } as const);
export function subscribePromptLibraryCatalogSnapshots(listener: () => void): () => void {
    listeners.add(listener); return () => { listeners.delete(listener); };
}
export function subscribePromptLibraryCatalogRow(scope: ServerAccountScope, key: PromptLibraryCatalogKeyV1, listener: () => void): () => void {
    let previous = getPromptLibraryCatalogValue(scope, key);
    return subscribePromptLibraryCatalogSnapshots(() => {
        const next = getPromptLibraryCatalogValue(scope, key);
        if (previous === next) return;
        previous = next;
        listener();
    });
}
export function getPromptLibraryCatalogValue<K extends PromptLibraryCatalogKeyV1>(scope: ServerAccountScope | null | undefined, key: K): PromptLibraryCatalogValueSnapshot<K> {
    const snapshot = scope ? snapshots.get(serverAccountScopeKeySuffix(scope)) : undefined;
    // Each entry is produced at the same validated key below; the generic preserves caller narrowing.
    return (key === 'skill-rules' ? snapshot?.skillRulesView ?? snapshot?.values.get(key) ?? loading
        : snapshot?.values.get(key) ?? loading) as PromptLibraryCatalogValueSnapshot<K>;
}
/** Mutation bases remain received rows; drafts are display projections, never CAS authority. */
export function getAcknowledgedPromptLibraryCatalogValue<K extends PromptLibraryCatalogKeyV1>(scope: ServerAccountScope | null | undefined, key: K): PromptLibraryCatalogValueSnapshot<K> {
    return (scope ? snapshots.get(serverAccountScopeKeySuffix(scope))?.values.get(key) ?? loading : loading) as PromptLibraryCatalogValueSnapshot<K>;
}
function withSkillRuleDrafts(snapshot: StoredSnapshot, drafts = snapshot.skillRuleDrafts): StoredSnapshot {
    const base = snapshot.values.get('skill-rules') as PromptLibraryCatalogValueSnapshot<'skill-rules'> | undefined;
    if (!base?.value || !drafts?.size) return { ...snapshot, skillRuleDrafts: drafts, skillRulesView: base };
    const rules = [...base.value.rules.filter(rule => !drafts.has(rule.skillId)),
        ...[...drafts].flatMap(([skillId, rules]) => rules.map(rule => ({ ...rule, skillId })))];
    const value = { ...base.value, rules };
    const previousValue = snapshot.skillRulesView?.value;
    const next = { ...base, value: previousValue && JSON.stringify(previousValue) === JSON.stringify(value) ? previousValue : value };
    const view = snapshot.skillRulesView && JSON.stringify(snapshot.skillRulesView) === JSON.stringify(next) ? snapshot.skillRulesView : next;
    return { ...snapshot, skillRuleDrafts: drafts, skillRulesView: view };
}
/** The existing catalog publishes one item's pending reach to every mounted consumer. */
export function publishPromptLibrarySkillRulesDraft(scope: ServerAccountScope, skillId: string, rules: ReachRulesV1 | null): void {
    const key = serverAccountScopeKeySuffix(scope);
    const previous = snapshots.get(key);
    if (!previous || !previous.values.get('skill-rules')?.value) return;
    const drafts = new Map(previous.skillRuleDrafts);
    if (rules === null) drafts.delete(skillId); else drafts.set(skillId, rules);
    const next = withSkillRuleDrafts(previous, drafts);
    snapshots.set(key, next);
    if (next.skillRulesView === previous.skillRulesView) return;
    for (const listener of [...listeners]) listener();
}
export function getPromptLibraryCatalogSnapshot(scope: ServerAccountScope): PromptLibraryCatalogProjection | null {
    return snapshots.get(serverAccountScopeKeySuffix(scope))?.projection ?? null;
}
/** A received CAS confirms this row, not the freshness of the rest of the catalog. */
export function applyPromptLibraryCatalogAcknowledgedRecord(scope: ServerAccountScope, record: PromptLibraryRecordV1,
    revision: number, current: boolean): void {
    if (!current) return;
    const scopeKey = serverAccountScopeKeySuffix(scope);
    const previous = snapshots.get(scopeKey);
    const catalog = previous?.projection.catalog;
    if (!receiptOrdering.admit(scope, record.key, revision)) return;
    const values = new Map(previous?.values);
    values.set(record.key, { status: 'ready', value: record.value,
        revision, sourceSettingsVersion: null, stale: false });
    const nextCatalog: PromptLibraryCatalogSnapshotV1 = catalog?.status === 'ready' || catalog?.status === 'partial'
        ? { ...catalog, rows: [...catalog.rows.filter(row => row.record.key !== record.key), { record, revision }],
            tombstones: catalog.tombstones.filter(row => row.key !== record.key),
            diagnostics: catalog.diagnostics.filter(row => row.key !== record.key) }
        : { status: 'partial', rows: [{ record, revision }], tombstones: [], diagnostics: [] };
    snapshots.set(scopeKey, withSkillRuleDrafts({ scope, values, skillRuleDrafts: previous?.skillRuleDrafts,
        skillRulesView: previous?.skillRulesView, projection: { catalog: nextCatalog,
        rawSettings: previous?.projection.rawSettings ?? {}, sourceSettingsVersion: previous?.projection.sourceSettingsVersion ?? 0 } }));
    for (const listener of [...listeners]) listener();
}
/** Account admission and read freshness are separate: stale data can display, but grants no row write authority. */
export function applyPromptLibraryCatalogSnapshot(scope: ServerAccountScope, projection: PromptLibraryCatalogProjection, current: boolean,
    changedKeys?: readonly PromptLibraryCatalogKeyV1[], stale = false): void {
    if (!current) return;
    const scopeKey = serverAccountScopeKeySuffix(scope);
    const previous = snapshots.get(scopeKey);
    const before = previous?.projection.catalog;
    const incoming = projection.catalog;
    if ((before?.status === 'ready' || before?.status === 'partial') && (incoming.status === 'ready' || incoming.status === 'partial')) {
        // A read started before a received CAS can enrich siblings, but cannot roll that row back.
        const newerRows = before.rows.filter(row => {
            const key = row.record.key;
            const readRevision = incoming.rows.find(next => next.record.key === key)?.revision
                ?? incoming.tombstones.find(next => next.key === key)?.revision
                ?? incoming.diagnostics.find(next => next.key === key)?.revision;
            return typeof readRevision === 'number' && row.revision > readRevision;
        });
        if (newerRows.length) {
            const keys = new Set(newerRows.map(row => row.record.key));
            projection = { ...projection, catalog: { ...incoming,
                rows: [...incoming.rows.filter(row => !keys.has(row.record.key)), ...newerRows],
                tombstones: incoming.tombstones.filter(row => !keys.has(row.key)),
                diagnostics: incoming.diagnostics.filter(row => !keys.has(row.key)) } };
        }
    }
    if (projection.catalog.status === 'unavailable' && projection.catalog.reason === 'scope-retired') {
        receiptOrdering.clearScope(scope);
        return;
    }
    if (projection.catalog.status === 'unavailable' && admissionLossReasons.includes(projection.catalog.reason)) {
        receiptOrdering.clearScope(scope);
    } else if (projection.catalog.status === 'ready' || projection.catalog.status === 'partial') {
        for (const row of projection.catalog.rows) receiptOrdering.retain(scope, row.record.key, row.revision);
        for (const row of projection.catalog.tombstones) receiptOrdering.retain(scope, row.key, row.revision);
        for (const row of projection.catalog.diagnostics) {
            if (typeof row.revision === 'number') receiptOrdering.retain(scope, row.key, row.revision);
        }
    }
    const values = new Map<PromptLibraryCatalogKeyV1, PromptLibraryCatalogValueSnapshot<PromptLibraryCatalogKeyV1>>();
    let changed = !previous;
    for (const key of PromptLibraryCatalogKeyV1Schema.options) {
        const old = previous?.values.get(key);
        if (changedKeys && !changedKeys.includes(key)) {
            if (old) values.set(key, old);
            continue;
        }
        const read = readPromptLibraryCatalogRecordV1({ catalog: projection.catalog, key, rawSettings: projection.rawSettings });
        let next: PromptLibraryCatalogValueSnapshot<PromptLibraryCatalogKeyV1>;
        if (read.status === 'ready') {
            if (typeof old?.revision === 'number' && typeof read.revision === 'number' && old.revision > read.revision) {
                values.set(key, old);
                continue;
            }
            const value = old?.value && JSON.stringify(old.value) === JSON.stringify(read.record.value) ? old.value : read.record.value;
            next = { status: stale ? 'loading' : 'ready', value, revision: read.revision,
                sourceSettingsVersion: read.authority === 'inactive' ? projection.sourceSettingsVersion : null, stale,
                ...(stale ? { reason: 'loading' } : {}) };
        } else {
            const withdraw = admissionLossReasons.includes(read.reason);
            next = { status: read.reason === 'loading' ? 'loading' : 'unavailable', value: withdraw ? null : old?.value ?? null,
                revision: old?.revision ?? 'absent', sourceSettingsVersion: old?.sourceSettingsVersion ?? null,
                stale: true, reason: read.reason };
        }
        if (old && JSON.stringify(old) === JSON.stringify(next)) next = old;
        changed ||= next !== old;
        values.set(key, next);
    }
    snapshots.set(scopeKey, withSkillRuleDrafts({ scope, projection, values, skillRuleDrafts: values.get('skill-rules')?.value ? previous?.skillRuleDrafts : undefined,
        skillRulesView: previous?.skillRulesView }));
    if (!changed) return;
    for (const listener of [...listeners]) listener();
}
/** Targeted refreshes retain sibling authority and never start catalog maintenance. */
export function beginPromptLibraryCatalogRowsLoad(scope: ServerAccountScope, keys: readonly PromptLibraryCatalogKeyV1[]): void {
    const scopeKey = serverAccountScopeKeySuffix(scope);
    const previous = snapshots.get(scopeKey);
    if (!previous) return;
    const values = new Map(previous.values);
    let changed = false;
    for (const key of keys) {
        const old = values.get(key);
        if (!old || old.status === 'loading' && old.stale && old.reason === 'loading') continue;
        values.set(key, { ...old, status: 'loading', stale: true, reason: 'loading' });
        changed = true;
    }
    if (!changed) return;
    snapshots.set(scopeKey, withSkillRuleDrafts({ ...previous, values }));
    for (const listener of [...listeners]) listener();
}
export function applyPromptLibraryCatalogRowsSnapshot(scope: ServerAccountScope, keys: readonly PromptLibraryCatalogKeyV1[],
    projection: PromptLibraryCatalogProjection, current: boolean, stale = false): void {
    if (!current) return;
    const previous = getPromptLibraryCatalogSnapshot(scope);
    const base = previous?.catalog.status === 'ready' || previous?.catalog.status === 'partial' ? previous.catalog : null;
    const incoming = projection.catalog;
    if (incoming.status === 'unavailable' && (incoming.reason === 'scope-retired' || admissionLossReasons.includes(incoming.reason))) {
        // Admission loss withdraws the complete Account projection, even on a single-row read.
        applyPromptLibraryCatalogSnapshot(scope, projection, current);
        return;
    }
    if (incoming.status !== 'ready' && incoming.status !== 'partial') {
        applyPromptLibraryCatalogSnapshot(scope, { ...projection, rawSettings: previous?.rawSettings ?? {},
            sourceSettingsVersion: previous?.sourceSettingsVersion ?? 0 }, current, keys, stale);
        return;
    }
    const rows = [...(base?.rows ?? []).filter(row => !keys.includes(row.record.key)),
        ...incoming.rows.filter(row => keys.includes(row.record.key))];
    const tombstones = [...(base?.tombstones ?? []).filter(row => !keys.includes(row.key)),
        ...incoming.tombstones.filter(row => keys.includes(row.key))];
    const diagnostics = [...(base?.diagnostics ?? []).filter(row => !keys.includes(row.key)),
        ...incoming.diagnostics.filter(row => keys.includes(row.key))];
    // A demanded row cannot establish the exhaustive base or its retained Settings authority.
    applyPromptLibraryCatalogSnapshot(scope, { rawSettings: previous?.rawSettings ?? {}, sourceSettingsVersion: previous?.sourceSettingsVersion ?? 0, catalog: { ...base,
        status: !base || diagnostics.length ? 'partial' : base.status, rows, tombstones, diagnostics } }, current, keys, stale);
}
export function beginPromptLibraryCatalogLoad(scope: ServerAccountScope): void {
    const previous = getPromptLibraryCatalogSnapshot(scope);
    applyPromptLibraryCatalogSnapshot(scope, { catalog: { status: 'loading' }, rawSettings: previous?.rawSettings ?? {},
        sourceSettingsVersion: previous?.sourceSettingsVersion ?? 0 }, true);
}
export function invalidatePromptLibraryCatalogsForServer(serverId: string): void {
    for (const snapshot of snapshots.values()) if (snapshot.scope.serverId === serverId) beginPromptLibraryCatalogLoad(snapshot.scope);
}
export function resetPromptLibraryCatalogSnapshotsForTests(): void { snapshots.clear(); receiptOrdering.reset(); listeners.clear(); }
