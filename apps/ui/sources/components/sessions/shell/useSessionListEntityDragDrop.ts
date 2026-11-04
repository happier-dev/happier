import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type {
    EntityDragItemV1,
    EntityDragScopeV1,
    EntityDropAdmissionV1,
    EntityDropEffectV1,
    EntityDropOutcomeV1,
    PluginUiJsonValueV1,
} from '@happier-dev/protocol/plugins/ui';
import * as React from 'react';
import { useSessionListAttentionActivity } from './useSessionListAttentionInteraction';

import {
    createEntityDragGestureAdapter,
    useEntityDragDropRuntime,
    type EntityDragDropRuntime,
    type EntityDropResolveContext,
    type TreeDropVisualGeometry,
    type TreeInstructionVisual,
    type WindowBounds,
    type WindowPointer,
} from '@/components/ui/treeDragDrop';
import { projectActionOutcome } from './dropPreview/sessionListActionOutcome';
export { projectActionOutcome } from './dropPreview/sessionListActionOutcome';
import { resolvePutUnderEligibility } from '@/components/sessions/work/putUnderCandidates';
import { selectSessionRelationRecords } from '@/components/sessions/work/reportSubtree';
import { getStorage } from '@/sync/domains/state/storage';
import { readSessionPresentationRecord, readSessionPresentationInputDisplay, readSessionPresentationInputSource, type SessionRelationRecord } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import {
    loadSessionManagerEligibility,
    type SessionManagerEligibilitySnapshot,
} from '@/sync/ops/relations/sessionManagerEligibility';
import { useServerCredentialAccountScopeBindings, type ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { SessionOrganizationMutationScope } from '@/sync/ops/sessionOrganization';
import { t } from '@/text';
import { parseToken } from '@/utils/auth/parseToken';
import { getSessionCarriedLine, getSessionName } from '@/utils/sessions/sessionUtils';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { AgentIcon } from '@/agents/registry/AgentIcon';

import { resolveSessionListDragTree, type CommitSessionListDragIntentContext, type SessionListDragAdmission } from './drag/commitSessionListDragIntent';
import type { SessionListDragIntent, SessionListDragSnapshot, SessionListFolderAssignmentDestination, SessionListSpaceMembershipDestination } from './drag/_types';
import { listSessionListEntityDropDestinations, readSessionListFolderAssignmentDestination, resolveSessionListFolderAssignmentDrop,
    readSessionListSpaceMembershipDestination, resolveSessionListSpaceMembershipDrop, resolveSessionListEntityDrop } from './drag/resolveSessionListEntityDrop';
import {
    createSessionListOrganizationActionAdapter,
    registerMountedSessionListOrganizationAction,
} from './drag/sessionListOrganizationAction';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { buildSessionListDragSnapshot } from './drag/sessionListDragSnapshot';
import { buildSessionListDragSourceId, treeRowId } from './drop-resolution/treeRowId';
import { buildSessionListDragIntent } from './drag/sessionListDragIntent';
import type { SessionListTreeRowMetadata } from './drop-resolution/sessionListTreeTypes';
import {
    describeSessionListDropPreview,
    describeSessionListDropReason,
    describeSessionListRefusedPutUnder,
    SESSION_LIST_NO_TARGET_CODE,
} from './dropPreview/sessionListDropPresentation';
import type { UseSessionInlineDragResolvedDrop } from './useSessionInlineDrag';

/**
 * The Session list's binding to the ONE entity drag owner (`components/ui/treeDragDrop`).
 *
 * The list is one source-scoped mounted collection: its pointer geometry (tree thirds and
 * container zones) selects a semantic intent, the Session domain resolver admits it, and the owner's
 * canonical relation, Section and organization Actions execute it. A row carry
 * is a source the list registers for exactly as long as it is carried. Feedback leaves read the
 * owner's snapshot; only refusal-free targets draw a line or outline.
 */

export type SessionListBaseCommitContext = Omit<CommitSessionListDragIntentContext, 'scope' | 'resolvePutSessionUnder'>;

export type UseSessionListEntityDragDropInput = Readonly<{
    /** Existing view/filter scope, excluding live row arrivals and status. */
    presentationScopeKey?: string;
    /** The list's pointer geometry strategy (tree thirds, container zones) for the current snapshot. */
    resolvePointerGeometry: (pointer: WindowPointer | null) => UseSessionInlineDragResolvedDrop;
    getCommitContext: (mutationScope?: SessionOrganizationMutationScope) => SessionListBaseCommitContext;
    getListBounds: () => WindowBounds | null;
    getSourceBounds?: (rowId: string) => WindowBounds | null;
    resolveKeyboardGeometry?: (visual: TreeInstructionVisual) => TreeDropVisualGeometry;
    onKeyboardGeometry?: (geometry: TreeDropVisualGeometry) => void;
    /** Release held presentation positions before the admitted effect publishes its mutation. */
    onCarryDispatched?: () => void;
    onCarryRetired?: () => void;
}>;

export type SessionListCarry = Readonly<{
    sourceId: string;
    move: (pointer: WindowPointer | null) => TreeDropVisualGeometry;
    /** Keyboard/chooser: stage a semantic destination (the same intent pointer geometry produces). */
    choose: (destination: SessionListDragIntent | SessionListFolderAssignmentDestination | SessionListSpaceMembershipDestination) => void;
    end: (success: boolean, pointer: WindowPointer | null) => Promise<void>;
    cancel: () => void;
}>;

const NO_GEOMETRY: TreeDropVisualGeometry = Object.freeze({ kind: 'none' });
const ACCEPTED_KINDS = Object.freeze(['session', 'session-folder', 'session-workspace'] as const);

function sessionsRecord(serverId: string | null): Readonly<Record<string, SessionRelationRecord>> {
    const state = getStorage().getState();
    return selectSessionRelationRecords(state.sessions, serverId, state.sessionListRowsByServerId);
}

function rowName(metadata: SessionListTreeRowMetadata | undefined): string {
    if (!metadata) return '';
    if (metadata.kind === 'session' && metadata.sessionId) {
        const session = sessionsRecord(metadata.serverId)[metadata.sessionId];
        return session ? getSessionName(readSessionPresentationInputDisplay(session), metadata.serverId) : metadata.sessionId;
    }
    const item = metadata.item;
    return item.type === 'header' ? item.title : '';
}

function itemForSnapshot(snapshot: SessionListDragSnapshot, scope: EntityDragScopeV1): EntityDragItemV1 | null {
    const metadata = snapshot.source.treeSource.metadata as SessionListTreeRowMetadata;
    if (metadata.serverId && metadata.serverId !== scope.serverId) return null;
    if (metadata.kind === 'session' && metadata.sessionId && metadata.serverId) {
        return { kind: 'session', scope, address: { serverId: metadata.serverId, sessionId: metadata.sessionId } };
    }
    if (metadata.kind === 'folder' && metadata.folderId) return { kind: 'session-folder', scope, folderId: metadata.folderId };
    if (metadata.kind === 'workspace-root') {
        try {
            const tuple = JSON.parse(metadata.rowId) as unknown[];
            const workspaceId = typeof tuple[1] === 'string' ? tuple[1] : '';
            return workspaceId ? { kind: 'session-workspace', scope, workspaceId } : null;
        } catch {
            return null;
        }
    }
    return null;
}

/** Keyboard and chooser destinations carry the same semantic intent the pointer geometry produces. */
export function readSessionListDestinationIntent(destination: PluginUiJsonValueV1 | null | undefined, scope: EntityDragScopeV1): SessionListDragIntent | null {
    if (!destination || typeof destination !== 'object' || Array.isArray(destination)) return null;
    const value = destination as Readonly<Record<string, unknown>>;
    if (typeof value.sourceRowId !== 'string' || typeof value.instructionKind !== 'string') return null;
    const text = (key: string) => (typeof value[key] === 'string' ? value[key] as string : null);
    const blockedReason = text('blockedReason');
    return {
        scope,
        sourceRowId: value.sourceRowId,
        sourceKind: value.sourceKind as SessionListDragIntent['sourceKind'],
        instructionKind: value.instructionKind as SessionListDragIntent['instructionKind'],
        ...(value.instructionKind === 'blocked' && blockedReason ? { blockedReason } : {}),
        targetRowId: text('targetRowId'),
        containerId: text('containerId'),
        parentRowId: text('parentRowId'),
        depth: typeof value.depth === 'number' ? value.depth : null,
        edge: value.edge === 'top' || value.edge === 'bottom' ? value.edge : null,
        sourceSnapshotSignature: `keyboard:${value.sourceRowId}`,
    };
}

function previewForFolderAssignment(folderName: string | null) {
    return folderName === null ? describeSessionListDropPreview({ kind: 'project' })
        : describeSessionListDropPreview({ kind: 'folder', folderName });
}

function previewForSpaceMembership(spaceName: string, operation: SessionListSpaceMembershipDestination['operation']) {
    return describeSessionListDropPreview({ kind: 'space-membership', spaceName, operation });
}

function previewForDestination(intent: Pick<SessionListDragIntent, 'instructionKind'>, target: SessionListTreeRowMetadata | null) {
    if (intent.instructionKind === 'nest-into') {
        return target?.kind === 'session'
            ? describeSessionListDropPreview({ kind: 'put-under', leadName: rowName(target) })
            : describeSessionListDropPreview({ kind: 'folder', folderName: rowName(target ?? undefined) });
    }
    if (intent.instructionKind === 'reorder-before' || intent.instructionKind === 'reorder-after') {
        return describeSessionListDropPreview({
            kind: 'reorder',
            edge: intent.instructionKind === 'reorder-before' ? 'above' : 'below',
            siblingName: rowName(target ?? undefined),
        });
    }
    return describeSessionListDropPreview({ kind: 'top-level' });
}

function previewForAdmission(admission: Extract<SessionListDragAdmission, { ok: true }>) {
    if (admission.effect === 'manager') return describeSessionListDropPreview({ kind: 'put-under', leadName: rowName(admission.lead) });
    const instruction = admission.result.instruction;
    const target = 'targetId' in instruction ? admission.tree.rowMetadataById.get(instruction.targetId) ?? null : null;
    return previewForDestination({ instructionKind: instruction.kind }, target);
}

export function useSessionListEntityDragDrop(input: UseSessionListEntityDragDropInput): Readonly<{
    runtime: EntityDragDropRuntime;
    targetId: string;
    beginCarry: (snapshot: SessionListDragSnapshot, mode: 'pointer' | 'keyboard') => SessionListCarry | null;
    prepareSource: (request: SessionListDragSnapshot | Readonly<{ sourceRowId: string }>) => Readonly<{ sourceId: string; scope: EntityDragScopeV1; dispose: () => void }> | null;
}> {
    const setAttentionMoveHeld = useSessionListAttentionActivity();
    const runtime = useEntityDragDropRuntime();
    const targetId = `session-list:${React.useId()}`;
    const bindings = useServerCredentialAccountScopeBindings(input.getCommitContext().latestItems.map(item => item.serverId));
    const bindingsRef = React.useRef(bindings);
    bindingsRef.current = bindings;
    const inputRef = React.useRef(input);
    inputRef.current = input;
    const factsRef = React.useRef<SessionManagerEligibilitySnapshot | null>(null);
    const destinationKeysRef = React.useRef(new WeakMap<EntityDropEffectV1, string | null>());
    const pointerVisualRef = React.useRef<TreeDropVisualGeometry>(NO_GEOMETRY);
    /** The topology the current carry started from (pointer or keyboard). */
    const carriedSnapshotRef = React.useRef<SessionListDragSnapshot | null>(null);
    const sourceRef = React.useRef<Readonly<{ sourceId: string; scope: EntityDragScopeV1; dispose: () => void }> | null>(null);
    // The invocation supplies its captured credential lifetime, never the focused Home.
    const { executeCaptured: executeMountedAction } = useMountedActionExecution(null);
    const bindingForScope = React.useCallback((scope: EntityDragScopeV1): ServerCredentialAccountScopeBinding | null => {
        const binding = bindingsRef.current.get(scope.serverId);
        return binding?.accountId === scope.accountId && binding.isCurrent() ? binding : null;
    }, []);

    const buildContext = React.useCallback((current: EntityDragScopeV1, mutationScope?: SessionOrganizationMutationScope): CommitSessionListDragIntentContext | null => {
        if (!bindingForScope(current)) return null;
        return {
            ...inputRef.current.getCommitContext(mutationScope),
            scope: current,
            resolvePutSessionUnder: ({ serverId, sessionId, managerSessionId }) => {
                const verdict = resolvePutUnderEligibility(sessionsRecord(current.serverId), sessionId, managerSessionId, factsRef.current, {
                    serverId,
                    accountId: current.accountId,
                });
                return verdict.allowed ? { allowed: true, expectedManagerSessionId: verdict.expectedManagerSessionId } : { allowed: false, reason: verdict.reason };
            },
        };
    }, [bindingForScope]);

    // The mounted list answers `session.organization.move` for menus, keyboard and agents alike.
    const buildActionContext = React.useCallback((mutationScope: SessionOrganizationMutationScope) => {
        const accountId = parseToken(mutationScope.credentials.token);
        const binding = [...bindingsRef.current.values()].find(candidate => candidate.accountId === accountId
            && (mutationScope.serverId === candidate.serverId || mutationScope.serverIdAliases.includes(candidate.serverId)));
        return binding ? buildContext(binding.scope, mutationScope) : null;
    }, [buildContext]);
    React.useEffect(() => registerMountedSessionListOrganizationAction(createSessionListOrganizationActionAdapter(buildActionContext)), [buildActionContext]);

    const resolve = React.useCallback((context: EntityDropResolveContext): EntityDropAdmissionV1 => {
        if (context.input === 'keyboard') inputRef.current.onKeyboardGeometry?.(NO_GEOMETRY);
        const current = context.item.scope;
        const refuse = (code: string): EntityDropAdmissionV1 => ({ status: 'refused', reason: describeSessionListDropReason(code) });
        const commitContext = buildContext(current);
        if (!commitContext) return refuse('scope-mismatch');
        let intent: SessionListDragIntent | null;
        let geometry: TreeDropVisualGeometry = NO_GEOMETRY;
        if (context.input === 'pointer') {
            const snapshot = carriedSnapshotRef.current;
            if (!snapshot) return refuse('source-missing');
            const resolved = inputRef.current.resolvePointerGeometry(context.pointer);
            const instruction = resolved.result.instruction;
            if (instruction.kind === 'idle') {
                pointerVisualRef.current = NO_GEOMETRY;
                return refuse(SESSION_LIST_NO_TARGET_CODE);
            }
            if (instruction.kind === 'blocked') {
                // Over its own place there is nothing to say; any other structural block says why.
                pointerVisualRef.current = NO_GEOMETRY;
                return refuse(instruction.reason === 'same-position' || instruction.reason === 'no-target'
                    ? SESSION_LIST_NO_TARGET_CODE
                    : resolved.result.sessionListBlockReason ?? instruction.reason);
            }
            geometry = resolved.geometry;
            intent = buildSessionListDragIntent({
                result: resolved.result,
                sourceRowId: snapshot.source.sourceRowId,
                sourceKind: snapshot.source.kind,
                snapshotSignature: snapshot.signature,
                scope: current,
            });
        } else {
            const membership = context.item.kind === 'session'
                ? readSessionListSpaceMembershipDestination(context.destination, context.item.address.sessionId) : null;
            if (membership) {
                const admission = resolveSessionListSpaceMembershipDrop({ item: context.item, input: membership,
                    context: commitContext, preview: previewForSpaceMembership, reason: describeSessionListDropReason });
                if (admission.status === 'allowed') destinationKeysRef.current.set(admission.effect, JSON.stringify(membership));
                return admission;
            }
            const assignment = readSessionListFolderAssignmentDestination(context.destination);
            if (assignment) {
                const admission = resolveSessionListFolderAssignmentDrop({ item: context.item, folderId: assignment.folderId,
                    context: commitContext, preview: previewForFolderAssignment, reason: describeSessionListDropReason });
                if (admission.status === 'allowed') destinationKeysRef.current.set(admission.effect,
                    JSON.stringify(['folder-assignment', assignment.folderId]));
                return admission;
            }
            intent = readSessionListDestinationIntent(context.destination, current);
        }
        if (!intent || intent.instructionKind === 'idle') return refuse(SESSION_LIST_NO_TARGET_CODE);
        let destinationKey: string | null = null;
        const admission = resolveSessionListEntityDrop({
            item: context.item,
            intent,
            context: commitContext,
            preview: admitted => {
                destinationKey = admitted.destinationKey;
                if (context.input === 'keyboard') {
                    const visual: TreeInstructionVisual = admitted.effect === 'manager'
                        ? { kind: 'outline', targetId: admitted.lead.rowId } : admitted.result.visual;
                    inputRef.current.onKeyboardGeometry?.(inputRef.current.resolveKeyboardGeometry?.(visual) ?? NO_GEOMETRY);
                }
                return previewForAdmission(admitted);
            },
            refusedPreview: ({ intent, target }) => intent.instructionKind === 'nest-into' && target?.kind === 'session'
                ? describeSessionListRefusedPutUnder(rowName(target)) : undefined,
            reason: describeSessionListDropReason,
        });
        if (admission.status === 'allowed') destinationKeysRef.current.set(admission.effect, destinationKey);
        // Refusals light nothing: only an admitted place draws its line or outline.
        if (context.input === 'pointer') pointerVisualRef.current = admission.status === 'allowed' ? geometry : NO_GEOMETRY;
        return admission;
    }, [buildContext]);

    const execute = React.useCallback(async (effect: EntityDropEffectV1, context: EntityDropResolveContext): Promise<EntityDropOutcomeV1> => {
        const binding = bindingForScope(context.item.scope);
        if (!binding) return { status: 'refused', reason: describeSessionListDropReason('scope-mismatch') };
        const result = await executeMountedAction(binding, effect.actionId as ActionId, effect.input);
        return projectActionOutcome(effect.actionId, result);
    }, [bindingForScope, executeMountedAction]);

    React.useEffect(() => {
        return runtime.registerTarget({
            id: targetId,
            scopeMode: 'source',
            acceptedKinds: ACCEPTED_KINDS,
            getBounds: () => inputRef.current.getListBounds(),
            listDestinations: (item) => {
                const context = buildContext(item.scope);
                return context ? listSessionListEntityDropDestinations({ item, context, preview: previewForDestination,
                    folderPreview: previewForFolderAssignment, spacePreview: previewForSpaceMembership }) : [];
            },
            resolve,
            getDestinationKey: (_context, admission) => destinationKeysRef.current.get(admission.effect) ?? null,
            execute,
        });
    }, [buildContext, execute, resolve, runtime, targetId]);

    const prepareSource = React.useCallback((request: SessionListDragSnapshot | Readonly<{ sourceRowId: string }>) => {
        if (runtime.getSnapshot().phase === 'pending') return null;
        sourceRef.current?.dispose();
        const context = inputRef.current.getCommitContext();
        const sourceRowId = 'source' in request ? request.source.sourceRowId : request.sourceRowId;
        const semanticRow = 'source' in request ? null : context.latestItems.find(
            (candidate): candidate is Extract<SessionListIndexItem, { type: 'session' }> => candidate.type === 'session'
                && typeof candidate.serverId === 'string'
                && treeRowId.session(candidate.serverId, candidate.sessionId, candidate.keyParts, candidate.occurrenceRole) === sourceRowId,
        );
        const serverId = 'source' in request ? request.source.treeSource.metadata.serverId
            : semanticRow?.serverId ?? resolveSessionListDragTree(context).rowMetadataById.get(sourceRowId)?.serverId;
        const binding = serverId ? bindingsRef.current.get(serverId) : null;
        if (!binding?.isCurrent()) return null;
        const current = binding.scope;
        const snapshot = 'source' in request ? request : semanticRow ? null : buildSessionListDragSnapshot({
            items: context.latestItems, viewItems: context.latestItems, sessionDragKey: sourceRowId,
            foldersFeatureEnabled: context.isFolderOrganizationEnabled?.(current.serverId) === true,
        });
        const item: EntityDragItemV1 | null = semanticRow
            ? { kind: 'session', scope: current, address: { serverId: current.serverId, sessionId: semanticRow.sessionId } }
            : snapshot ? itemForSnapshot(snapshot, current) : null;
        if (!item) return null;
        const sourceId = buildSessionListDragSourceId(current, sourceRowId);
        let live = true;
        carriedSnapshotRef.current = snapshot;
        const sourceMetadata = snapshot?.source.treeSource.metadata as SessionListTreeRowMetadata | undefined;
        const retireSource = runtime.registerSource({
            id: sourceId,
            scope: current,
            getItem: () => item,
            isCurrent: () => {
                if (!live || !binding.isCurrent()) return false;
                const context = buildContext(current);
                if (!context) return false;
                if (!sourceMetadata && item.kind === 'session') return context.latestItems.some(candidate => candidate.type === 'session'
                    && candidate.serverId === item.address.serverId && candidate.sessionId === item.address.sessionId);
                if (!sourceMetadata) return false;
                const row = resolveSessionListDragTree(context).rowMetadataById.get(sourceMetadata.rowId);
                return row?.kind === sourceMetadata.kind && row.serverId === sourceMetadata.serverId;
            },
            describe: () => {
                const session = item.kind === 'session' ? sessionsRecord(item.address.serverId)[item.address.sessionId] : undefined;
                const display = session ? readSessionPresentationInputDisplay(session) : undefined;
                const record = session ? readSessionPresentationRecord(session) : undefined;
                const source = session ? readSessionPresentationInputSource(session) : undefined;
                const title = sourceMetadata ? rowName(sourceMetadata)
                    : display ? getSessionName(display, current.serverId) : semanticRow?.sessionId ?? '';
                if (!title) return null;
                // A Session carries its mark and its state line, as the lab's carried card does.
                const subtitle = record ? getSessionCarriedLine(record, current.serverId, source) : null;
                const agentId = display ? readSessionPresentationAgentId(display) : null;
                return { title, ...(subtitle ? { subtitle } : {}),
                    ...(agentId ? { renderMark: (size: number) => React.createElement(AgentIcon, { agentId, size }) } : {}) };
            },
            getBounds: () => inputRef.current.getSourceBounds?.(sourceRowId) ?? null,
        });
        const abort = new AbortController();
        factsRef.current?.dispose();
        factsRef.current = null;
        if (item.kind === 'session') {
            const candidateSessionIds = Object.values(sessionsRecord(item.address.serverId))
                .map(readSessionPresentationRecord)
                .filter((session) => session.id !== item.address.sessionId)
                .map((session) => session.id);
            void loadSessionManagerEligibility({ serverId: item.address.serverId, sessionId: item.address.sessionId,
                candidateSessionIds, signal: abort.signal }).then((facts) => {
                if (abort.signal.aborted || carriedSnapshotRef.current !== snapshot) { facts?.dispose(); return; }
                factsRef.current = facts;
                runtime.refresh();
            });
        }
        let unsubscribe = () => {};
        let retirement: Readonly<{ dispose(): void }> | undefined;
        const source = { sourceId, scope: current, dispose: () => {
            if (!live) return;
            live = false;
            unsubscribe();
            retirement?.dispose();
            abort.abort();
            if (carriedSnapshotRef.current === snapshot) {
                carriedSnapshotRef.current = null;
                factsRef.current?.dispose();
                factsRef.current = null;
                pointerVisualRef.current = NO_GEOMETRY;
                inputRef.current.onKeyboardGeometry?.(NO_GEOMETRY);
                inputRef.current.onCarryRetired?.();
            }
            if (sourceRef.current === source) sourceRef.current = null;
            setAttentionMoveHeld(false);
            retireSource();
        } };
        sourceRef.current = source;
        setAttentionMoveHeld(true);
        retirement = binding.onRetire(source.dispose);
        let engaged = false;
        unsubscribe = runtime.subscribe(() => {
            const state = runtime.getSnapshot();
            if (state.sourceId === sourceId && (state.phase === 'carrying' || state.phase === 'pending')) {
                engaged = true;
                // The entity owner publishes pending before executing the effect. Follow live
                // placement from this point, but keep the captured source alive until settlement.
                if (state.phase === 'pending') inputRef.current.onCarryDispatched?.();
            }
            else if (engaged) source.dispose();
        });
        return source;
    }, [buildContext, runtime, setAttentionMoveHeld]);

    // A person's new view must not paint or operate the previous scope's carry.
    React.useLayoutEffect(() => () => sourceRef.current?.dispose(), [runtime, input.presentationScopeKey]);
    // Current list membership is read through the source descriptor, including while the pointer is still.
    React.useEffect(() => { runtime.refresh(); });

    const beginCarry = React.useCallback((snapshot: SessionListDragSnapshot, mode: 'pointer' | 'keyboard'): SessionListCarry | null => {
        const source = prepareSource(snapshot);
        if (!source) return null;
        const carry = runtime.begin(source.sourceId, mode);
        if (!carry) { source.dispose(); return null; }
        const adapter = createEntityDragGestureAdapter(carry);
        if (mode === 'keyboard' && targetId) carry.choose(targetId);
        return {
            sourceId: source.sourceId,
            move: (pointer) => {
                adapter.update(pointer);
                return runtime.getSnapshot().targetId === targetId ? pointerVisualRef.current : NO_GEOMETRY;
            },
            choose: (destination) => {
                if (!targetId) return;
                if ('kind' in destination) {
                    carry.choose(targetId, destination);
                    return;
                }
                const { scope: _scope, ...semantic } = destination;
                carry.choose(targetId, semantic as unknown as PluginUiJsonValueV1);
            },
            end: async (success, pointer) => {
                inputRef.current.onKeyboardGeometry?.(NO_GEOMETRY);
                // A late refusal or an unknown result stays on the source row's line (lab ST4), not in an alert.
                await adapter.end(success, pointer);
                source.dispose();
            },
            cancel: () => adapter.cancel(),
        };
    }, [prepareSource, runtime, targetId]);

    // Row callbacks depend on this binding. Unchanged list refreshes must not
    // invalidate every mounted row merely by allocating a new binding object.
    return React.useMemo(() => ({ runtime, targetId, beginCarry, prepareSource }),
        [runtime, targetId, beginCarry, prepareSource]);
}
