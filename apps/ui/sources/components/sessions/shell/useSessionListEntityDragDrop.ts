import type { ActionId } from '@happier-dev/protocol';
import type {
    EntityDragItemV1,
    EntityDragScopeV1,
    EntityDropAdmissionV1,
    EntityDropEffectV1,
    EntityDropOutcomeV1,
    PluginUiJsonValueV1,
} from '@happier-dev/protocol/plugins/ui';
import * as React from 'react';

import {
    createEntityDragGestureAdapter,
    useEntityDragDropRuntime,
    type EntityDragDropRuntime,
    type EntityDropResolveContext,
    type TreeDropVisualGeometry,
    type WindowBounds,
    type WindowPointer,
} from '@/components/ui/treeDragDrop';
import { describeReportsToRefusal } from '@/components/sessions/work/putSessionUnderLead';
import { resolvePutUnderEligibility } from '@/components/sessions/work/putUnderCandidates';
import { Modal } from '@/modal';
import { getStorage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import {
    loadSessionReportsToEligibility,
    type SessionReportsToEligibilitySnapshot,
} from '@/sync/ops/relations/sessionReportsToEligibility';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import { t } from '@/text';
import { getSessionName } from '@/utils/sessions/sessionUtils';

import type { CommitSessionListDragIntentContext, SessionListDragAdmission } from './drag/commitSessionListDragIntent';
import type { SessionListDragIntent, SessionListDragSnapshot } from './drag/_types';
import { listSessionListEntityDropDestinations, resolveSessionListEntityDrop } from './drag/resolveSessionListEntityDrop';
import {
    createSessionListOrganizationActionAdapter,
    registerMountedSessionListOrganizationAction,
} from './drag/sessionListOrganizationAction';
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
 * The list is one mounted drop target for the active Home: its pointer geometry (tree thirds and
 * container zones) selects a semantic intent, the Session domain resolver admits it, and the owner's
 * canonical Actions (`session.reports_to.set`, `session.organization.move`) execute it. A row carry
 * is a source the list registers for exactly as long as it is carried. Feedback leaves read the
 * owner's snapshot; only refusal-free targets draw a line or outline.
 */

export type SessionListBaseCommitContext = Omit<CommitSessionListDragIntentContext, 'scope' | 'resolvePutSessionUnder'>;

export type UseSessionListEntityDragDropInput = Readonly<{
    /** The list's pointer geometry strategy (tree thirds, container zones) for the current snapshot. */
    resolvePointerGeometry: (pointer: WindowPointer | null) => UseSessionInlineDragResolvedDrop;
    getCommitContext: () => SessionListBaseCommitContext;
    getListBounds: () => WindowBounds | null;
}>;

export type SessionListCarry = Readonly<{
    move: (pointer: WindowPointer | null) => TreeDropVisualGeometry;
    /** Keyboard/chooser: stage a semantic destination (the same intent pointer geometry produces). */
    choose: (destination: SessionListDragIntent) => void;
    end: (success: boolean, pointer: WindowPointer | null) => Promise<void>;
    cancel: () => void;
}>;

const NO_GEOMETRY: TreeDropVisualGeometry = Object.freeze({ kind: 'none' });
const ACCEPTED_KINDS = Object.freeze(['session', 'session-folder', 'session-workspace'] as const);
const RELATION_REFUSAL_CODES = new Set(['reports_to_cycle', 'reports_to_cas_conflict', 'reports_to_forbidden']);

function sessionsRecord(): Readonly<Record<string, Session>> {
    return getStorage().getState().sessions as Readonly<Record<string, Session>>;
}

function rowName(metadata: SessionListTreeRowMetadata | undefined): string {
    if (!metadata) return '';
    if (metadata.kind === 'session' && metadata.sessionId) {
        const session = sessionsRecord()[metadata.sessionId];
        return session ? getSessionName(session, metadata.serverId) : metadata.sessionId;
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
function readDestinationIntent(destination: PluginUiJsonValueV1 | null, scope: EntityDragScopeV1): SessionListDragIntent | null {
    if (!destination || typeof destination !== 'object' || Array.isArray(destination)) return null;
    const value = destination as Readonly<Record<string, unknown>>;
    if (typeof value.sourceRowId !== 'string' || typeof value.instructionKind !== 'string') return null;
    const text = (key: string) => (typeof value[key] === 'string' ? value[key] as string : null);
    return {
        scope,
        sourceRowId: value.sourceRowId,
        sourceKind: value.sourceKind as SessionListDragIntent['sourceKind'],
        instructionKind: value.instructionKind as SessionListDragIntent['instructionKind'],
        targetRowId: text('targetRowId'),
        containerId: text('containerId'),
        parentRowId: text('parentRowId'),
        depth: typeof value.depth === 'number' ? value.depth : null,
        edge: value.edge === 'top' || value.edge === 'bottom' ? value.edge : null,
        sourceSnapshotSignature: `keyboard:${value.sourceRowId}`,
    };
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
    if (admission.effect === 'reports-to') return describeSessionListDropPreview({ kind: 'put-under', leadName: rowName(admission.lead) });
    const instruction = admission.result.instruction;
    const target = 'targetId' in instruction ? admission.tree.rowMetadataById.get(instruction.targetId) ?? null : null;
    return previewForDestination({ instructionKind: instruction.kind }, target);
}

/** Acknowledged applied/refused or unknown, in the owner's words; never a rewritten cancellation. */
function projectActionOutcome(actionId: string, result: Awaited<ReturnType<ReturnType<typeof createDefaultActionExecutor>['execute']>>): EntityDropOutcomeV1 {
    if (!result.ok) {
        if (RELATION_REFUSAL_CODES.has(result.errorCode)) {
            return { status: 'refused', reason: { code: result.errorCode, message: describeReportsToRefusal(result.errorCode) } };
        }
        return { status: 'unknown', reason: { code: result.errorCode || 'unknown', message: t('entityDragDrop.preview.unknownDetail') } };
    }
    if (actionId !== 'session.organization.move') return { status: 'applied' };
    const output = result.result as Readonly<{ status?: string; reason?: string }> | null;
    if (output?.status === 'applied') return { status: 'applied' };
    if (output?.status === 'refused' || output?.status === 'unavailable') {
        return { status: 'refused', reason: describeSessionListDropReason(output.reason ?? 'unavailable') };
    }
    return { status: 'unknown', reason: { code: output?.reason ?? 'unknown', message: t('entityDragDrop.preview.unknownDetail') } };
}

export function sessionListDropTargetId(scope: EntityDragScopeV1): string {
    return `session-list:${scope.serverId}:${scope.accountId}`;
}

export function useSessionListEntityDragDrop(input: UseSessionListEntityDragDropInput): Readonly<{
    runtime: EntityDragDropRuntime;
    scope: EntityDragScopeV1 | null;
    targetId: string | null;
    beginCarry: (snapshot: SessionListDragSnapshot, mode: 'pointer' | 'keyboard') => SessionListCarry | null;
}> {
    const runtime = useEntityDragDropRuntime();
    const activeScope = useActiveServerAccountScope();
    const scope = React.useMemo<EntityDragScopeV1 | null>(
        () => (activeScope ? { serverId: activeScope.serverId, accountId: activeScope.accountId } : null),
        [activeScope?.serverId, activeScope?.accountId],
    );
    const inputRef = React.useRef(input);
    inputRef.current = input;
    const scopeRef = React.useRef(scope);
    scopeRef.current = scope;
    const factsRef = React.useRef<SessionReportsToEligibilitySnapshot | null>(null);
    const pointerVisualRef = React.useRef<TreeDropVisualGeometry>(NO_GEOMETRY);
    /** The topology the current carry started from (pointer or keyboard). */
    const carriedSnapshotRef = React.useRef<SessionListDragSnapshot | null>(null);
    const executor = React.useMemo(() => createDefaultActionExecutor(), []);

    const buildContext = React.useCallback((): CommitSessionListDragIntentContext | null => {
        const current = scopeRef.current;
        if (!current) return null;
        return {
            ...inputRef.current.getCommitContext(),
            scope: current,
            resolvePutSessionUnder: ({ serverId, sessionId, leadSessionId }) => {
                const verdict = resolvePutUnderEligibility(sessionsRecord(), sessionId, leadSessionId, factsRef.current, {
                    serverId,
                    accountId: current.accountId,
                });
                return verdict.allowed ? { allowed: true, expectedLeadSessionId: verdict.expectedLeadSessionId } : { allowed: false, reason: verdict.reason };
            },
        };
    }, []);

    // The mounted list answers `session.organization.move` for menus, keyboard and agents alike.
    React.useEffect(() => registerMountedSessionListOrganizationAction(createSessionListOrganizationActionAdapter(buildContext)), [buildContext]);

    const resolve = React.useCallback((context: EntityDropResolveContext): EntityDropAdmissionV1 => {
        const current = scopeRef.current;
        const refuse = (code: string): EntityDropAdmissionV1 => ({ status: 'refused', reason: describeSessionListDropReason(code) });
        const commitContext = buildContext();
        if (!current || !commitContext) return refuse('scope-mismatch');
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
                    : instruction.reason);
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
            intent = readDestinationIntent(context.destination, current);
        }
        if (!intent || intent.instructionKind === 'idle') return refuse(SESSION_LIST_NO_TARGET_CODE);
        const admission = resolveSessionListEntityDrop({
            item: context.item,
            intent,
            context: commitContext,
            preview: previewForAdmission,
            refusedPreview: ({ intent, target }) => intent.instructionKind === 'nest-into' && target?.kind === 'session'
                ? describeSessionListRefusedPutUnder(rowName(target)) : undefined,
            reason: describeSessionListDropReason,
        });
        // Refusals light nothing: only an admitted place draws its line or outline.
        if (context.input === 'pointer') pointerVisualRef.current = admission.status === 'allowed' ? geometry : NO_GEOMETRY;
        return admission;
    }, [buildContext]);

    const execute = React.useCallback(async (effect: EntityDropEffectV1): Promise<EntityDropOutcomeV1> => {
        const current = scopeRef.current;
        if (!current) return { status: 'refused', reason: describeSessionListDropReason('scope-mismatch') };
        const result = await executor.execute(effect.actionId as ActionId, effect.input, {
            surface: 'ui',
            serverId: current.serverId,
            expectedAccountId: current.accountId,
        });
        return projectActionOutcome(effect.actionId, result);
    }, [executor]);

    const targetId = scope ? sessionListDropTargetId(scope) : null;
    React.useEffect(() => {
        if (!scope || !targetId) return;
        return runtime.registerTarget({
            id: targetId,
            scope,
            acceptedKinds: ACCEPTED_KINDS,
            getBounds: () => inputRef.current.getListBounds(),
            listDestinations: (item) => {
                const context = buildContext();
                return context ? listSessionListEntityDropDestinations({ item, context, preview: previewForDestination }) : [];
            },
            resolve,
            execute,
        });
    }, [buildContext, execute, resolve, runtime, scope, targetId]);

    const beginCarry = React.useCallback((snapshot: SessionListDragSnapshot, mode: 'pointer' | 'keyboard'): SessionListCarry | null => {
        const current = scopeRef.current;
        if (!current) return null;
        const item = itemForSnapshot(snapshot, current);
        if (!item) return null;
        const sourceId = `session-list-source:${snapshot.source.sourceRowId}`;
        let live = true;
        carriedSnapshotRef.current = snapshot;
        const sourceMetadata = snapshot.source.treeSource.metadata as SessionListTreeRowMetadata;
        const retireSource = runtime.registerSource({
            id: sourceId,
            scope: current,
            getItem: () => item,
            isCurrent: () => live,
            describe: () => {
                const title = rowName(sourceMetadata);
                return title ? { title } : null;
            },
        });
        const carry = runtime.begin(sourceId, mode);
        if (!carry) {
            live = false;
            carriedSnapshotRef.current = null;
            retireSource();
            return null;
        }
        const adapter = createEntityDragGestureAdapter(carry);
        const abort = new AbortController();
        factsRef.current?.dispose();
        factsRef.current = null;
        if (item.kind === 'session') {
            // One demand-driven eligibility batch per carry; never per pointer frame.
            const candidateSessionIds = Object.values(sessionsRecord())
                .filter((session) => (session.serverId ?? null) === item.address.serverId && session.id !== item.address.sessionId)
                .map((session) => session.id);
            void loadSessionReportsToEligibility({
                serverId: item.address.serverId,
                sessionId: item.address.sessionId,
                candidateSessionIds,
                signal: abort.signal,
            }).then((facts) => {
                if (abort.signal.aborted || carriedSnapshotRef.current !== snapshot) { facts?.dispose(); return; }
                factsRef.current = facts;
                runtime.refresh();
            });
        }
        const retire = () => {
            live = false;
            abort.abort();
            if (carriedSnapshotRef.current === snapshot) {
                carriedSnapshotRef.current = null;
                factsRef.current?.dispose();
                factsRef.current = null;
                pointerVisualRef.current = NO_GEOMETRY;
            }
            retireSource();
        };
        if (mode === 'keyboard' && targetId) carry.choose(targetId);
        return {
            move: (pointer) => {
                adapter.update(pointer);
                return pointerVisualRef.current;
            },
            choose: (destination) => {
                if (!targetId) return;
                const { scope: _scope, ...semantic } = destination;
                carry.choose(targetId, semantic as unknown as PluginUiJsonValueV1);
            },
            end: (success, pointer) => {
                const admittedAtRelease = runtime.getSnapshot().admission?.status === 'allowed';
                return adapter.end(success, pointer).then((outcome) => {
                    retire();
                    // A refusal the person already saw needs no second word; a late one or an unknown
                    // dispatched result is said by its owner, and the row stays where it was.
                    if (!admittedAtRelease || !outcome || outcome.status === 'applied') return;
                    Modal.alert(
                        outcome.status === 'unknown' ? t('entityDragDrop.preview.unknownTitle') : t('entityDragDrop.preview.cantMoveHere'),
                        outcome.reason.message,
                    );
                }, retire);
            },
            cancel: () => {
                adapter.cancel();
                retire();
            },
        };
    }, [runtime, targetId]);

    return { runtime, scope, targetId, beginCarry };
}
