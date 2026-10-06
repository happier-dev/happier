import { z } from 'zod';
import { EntityDragScopeV1Schema, EntityDragSessionAddressV1Schema, entityDragScopesEqualV1, type EntityDragScopeV1 } from '@happier-dev/protocol/plugins/ui/entityDragDrop';
import type { TabGroupState } from '@/components/appShell/workspace/tabGroups/tabGroupTransitions';
import type { SplitCanvasLeafNode, SplitCanvasNode, SplitCanvasState } from '@/components/appShell/splitCanvas/model/splitCanvasTypes';
import { collectSplitCanvasLeaves } from '@/components/appShell/splitCanvas/model/splitCanvasTree';
import { areAccountSettingsJsonValuesEqual } from '@/sync/domains/settings/accountSettingsStructuralEquality';
import type { Settings } from '@/sync/domains/settings/settings';

export type SessionCanvasTab = Readonly<{
    id: string;
    scope: EntityDragScopeV1;
    address: Readonly<{ serverId: string; sessionId: string }>;
    pinned: boolean;
    preview: boolean;
}>;
export type SessionSplitCanvasLeafPayload = Readonly<{
    group: TabGroupState;
    tabs: Readonly<Record<string, SessionCanvasTab>>;
}>;
export type SessionSplitCanvasPersistenceSnapshot = Readonly<{
    version: 1;
    scope: EntityDragScopeV1;
    root: SplitCanvasNode<SessionSplitCanvasLeafPayload> | null;
    focusedLeafId: string | null;
    maximizedLeafId: string | null;
}>;

const id = z.string().trim().min(1);
const StoredScopeSchema = EntityDragScopeV1Schema.strip();
const StoredSessionAddressSchema = EntityDragSessionAddressV1Schema.strip();
const SessionCanvasTabSchema = z.object({
    id, scope: StoredScopeSchema, address: StoredSessionAddressSchema,
    pinned: z.boolean(), preview: z.boolean(),
});
const GroupSchema = z.object({ id, tabIds: z.array(id).nonempty(), activeTabId: id, mru: z.array(id) });
const PayloadSchema = z.object({ group: GroupSchema, tabs: z.record(id, SessionCanvasTabSchema) });
const NodeSchema: z.ZodType<SplitCanvasNode<SessionSplitCanvasLeafPayload>> = z.lazy(() => z.union([
    z.object({ id, kind: z.literal('leaf'), leafKind: z.literal('session'), payload: PayloadSchema }),
    z.object({ id, kind: z.literal('split'), axis: z.enum(['row', 'column']), ratio: z.number().finite().min(0).max(1), first: NodeSchema, second: NodeSchema }),
]));
export const SessionSplitCanvasPersistenceSnapshotSchema: z.ZodType<SessionSplitCanvasPersistenceSnapshot> = z.object({
    version: z.literal(1), scope: StoredScopeSchema, root: NodeSchema.nullable(),
    focusedLeafId: id.nullable(), maximizedLeafId: id.nullable(),
}).superRefine((snapshot, context) => {
    const leaves = collectSplitCanvasLeaves(snapshot.root);
    const leafIds = new Set(leaves.map(leaf => leaf.id));
    const nodeIds = new Set<string>();
    const inspectNode = (node: SplitCanvasNode<SessionSplitCanvasLeafPayload> | null): boolean => {
        if (!node) return true;
        if (nodeIds.has(node.id)) return false;
        nodeIds.add(node.id);
        return node.kind === 'leaf' || (inspectNode(node.first) && inspectNode(node.second));
    };
    const tabIds = new Set<string>();
    let valid = inspectNode(snapshot.root)
        && (!snapshot.focusedLeafId || leafIds.has(snapshot.focusedLeafId))
        && (!snapshot.maximizedLeafId || leafIds.has(snapshot.maximizedLeafId));
    for (const leaf of leaves) {
        const { group, tabs } = leaf.payload;
        valid = valid && group.id === leaf.id && group.tabIds.includes(group.activeTabId!)
            && new Set(group.tabIds).size === group.tabIds.length
            && Object.keys(tabs).length === group.tabIds.length
            && new Set(group.mru).size === group.mru.length && group.mru.every(tabId => group.tabIds.includes(tabId));
        for (const tabId of group.tabIds) {
            const tab = Object.hasOwn(tabs, tabId) ? tabs[tabId] : undefined;
            valid = valid && !tabIds.has(tabId) && !!tab && tab.id === tabId
                && entityDragScopesEqualV1(tab.scope, snapshot.scope)
                && tab.address.serverId === snapshot.scope.serverId
                && tab.id === sessionCanvasTabId(tab.scope, tab.address.sessionId);
            tabIds.add(tabId);
        }
    }
    if (!valid) context.addIssue({ code: 'custom', message: 'Invalid qualified Session canvas membership.' });
});
export const SessionSplitCanvasLayoutsSchema = z.record(z.string(), SessionSplitCanvasPersistenceSnapshotSchema).default({});

export function sessionCanvasTabId(scope: EntityDragScopeV1, sessionId: string): string {
    return JSON.stringify([scope.serverId, scope.accountId, sessionId]);
}
export function createSessionCanvasTab(sessionId: string, scope: EntityDragScopeV1): SessionCanvasTab {
    return { id: sessionCanvasTabId(scope, sessionId), scope, address: { serverId: scope.serverId, sessionId }, pinned: false, preview: false };
}
export function createSessionSplitCanvasLeafNode(sessionId: string, scope: EntityDragScopeV1): SplitCanvasLeafNode<SessionSplitCanvasLeafPayload> {
    const tab = createSessionCanvasTab(sessionId, scope);
    const leafId = `session-leaf:${tab.id}`;
    return { id: leafId, kind: 'leaf', leafKind: 'session', payload: {
        group: { id: leafId, tabIds: [tab.id], activeTabId: tab.id, mru: [tab.id] }, tabs: { [tab.id]: tab },
    } };
}
export function createInitialSessionSplitCanvasSnapshot(input: Readonly<{ sessionId: string; scope: EntityDragScopeV1 }>): SessionSplitCanvasPersistenceSnapshot {
    const root = createSessionSplitCanvasLeafNode(input.sessionId, input.scope);
    return { version: 1, scope: input.scope, root, focusedLeafId: root.id, maximizedLeafId: null };
}
export function createSessionSplitCanvasPersistenceSnapshot(state: SplitCanvasState<SessionSplitCanvasLeafPayload> & Readonly<{ scope: EntityDragScopeV1 }>): SessionSplitCanvasPersistenceSnapshot {
    return { version: 1, scope: state.scope, root: state.root, focusedLeafId: state.focusedLeafId, maximizedLeafId: state.maximizedLeafId };
}
export function readPersistedSessionSplitCanvasSnapshot(input: Readonly<{
    settings: Pick<Settings, 'sessionSplitCanvasLayoutsV1'>; scopeKey: string | null | undefined;
}>): SessionSplitCanvasPersistenceSnapshot | null {
    const key = input.scopeKey?.trim();
    if (!key) return null;
    const parsed = SessionSplitCanvasPersistenceSnapshotSchema.safeParse(input.settings.sessionSplitCanvasLayoutsV1?.[key]);
    return parsed.success ? parsed.data : null;
}
export const areSessionSplitCanvasSnapshotsEqual = areAccountSettingsJsonValuesEqual;

function routeOnly(value: unknown, sessionId: string): boolean {
    const parsed = SessionSplitCanvasPersistenceSnapshotSchema.safeParse(value);
    if (!parsed.success) return false;
    const { root, focusedLeafId, maximizedLeafId } = parsed.data;
    return !!root && root.kind === 'leaf' && focusedLeafId === root.id && maximizedLeafId === null
        && root.payload.group.tabIds.length === 1
        && root.payload.tabs[root.payload.group.tabIds[0]].address.sessionId === sessionId;
}
export function shouldPersistSessionSplitCanvasSnapshot(input: Readonly<{
    persisted: unknown; snapshot: SessionSplitCanvasPersistenceSnapshot; routeSessionId: string;
}>): boolean {
    if (areSessionSplitCanvasSnapshotsEqual(input.persisted, input.snapshot)) return false;
    return !(input.persisted == null && routeOnly(input.snapshot, input.routeSessionId));
}
export function writePersistedSessionSplitCanvasSnapshot(input: Readonly<{
    settings: Pick<Settings, 'sessionSplitCanvasLayoutsV1'>; scopeKey: string; snapshot: SessionSplitCanvasPersistenceSnapshot;
}>): Pick<Settings, 'sessionSplitCanvasLayoutsV1'> {
    const key = input.scopeKey.trim();
    if (!key) return { sessionSplitCanvasLayoutsV1: input.settings.sessionSplitCanvasLayoutsV1 };
    return { sessionSplitCanvasLayoutsV1: { ...input.settings.sessionSplitCanvasLayoutsV1, [key]: SessionSplitCanvasPersistenceSnapshotSchema.parse(input.snapshot) } };
}
