import type {
    WorkflowBlock,
    WorkflowDefinitionV1,
} from '@happier-dev/protocol/workflows/workflowV1';
import type { WorkflowMaterializedLeafV1 } from '@happier-dev/protocol/workflows/workflowDefinitionV1';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { readWorkflowValuePathV1 } from '@happier-dev/protocol/workflows/workflowReferenceV1';
import { projectWorkflowLoopItemDisplayLabelV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { normalizeExecutableParticipantSelectionV1 } from '@happier-dev/protocol/discussions/executableParticipants';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type {
    WorkflowInvocationPathV1,
    WorkflowProgressEnvelopeV1,
    WorkflowRunInvocationIndexV1,
} from '@happier-dev/protocol/workflows/workflowProgressV1';
import { classifyWorkflowInvocationCoverage, type WorkflowInvocationCoverageKind } from '@/components/workflows/presentation/workflowLifecyclePresentation';
import { t } from '@/text';
import {
    indexWorkflowFlowRunStates,
    resolveWorkflowFlowScopedNodeId,
    type WorkflowFlowNodeRunState,
    type WorkflowFlowProjection,
} from '@/components/workflows/flow/workflowFlowProjection';

/**
 * Navigable identity for invocation rows that have not been opened.
 *
 * The approved disclosure (FLOW §5.2) deliberately keeps authored block ids,
 * branch ids and scope paths out of the server-readable invocation index, and
 * widening it is a separate privacy decision. An authorized client, however,
 * already holds the frozen definition it read with the Run, and the index does
 * expose parent links, local member order and retry number — which is exactly
 * the coordinator's own slot mapping. Walking one against the other recovers
 * "which node, which occurrence" for every loaded row without decrypting
 * anything, without a second store and without eagerly opening private detail.
 *
 * When an exact row *has* been opened, its recorded `invocationPath` is
 * authoritative and is used instead of the derivation: this owner returns one
 * map, so Activity, Flow and the detail selection cannot disagree.
 */

export type WorkflowOccurrenceCoordinate =
    | Readonly<{ kind: 'branch'; blockId: string; branchId: string }>
    | Readonly<{ kind: 'workflow'; blockId: string }>
    | Readonly<{ kind: 'item'; blockId: string; index: number; displayLabel?: string }>
    | Readonly<{ kind: 'iteration'; blockId: string; index: number }>;

/** Shared wording for Map, Steps and conversation-row occurrence previews. */
export function formatWorkflowOccurrenceLabel(
    occurrence: readonly WorkflowOccurrenceCoordinate[],
    projection: WorkflowFlowProjection | null,
    scope: 'full' | 'repetition' = 'full',
): string | undefined {
    const workflowPath: string[] = [];
    const parts = occurrence.map((coordinate) => {
        if (coordinate.kind === 'branch') {
            return projection?.nodesById.get(resolveWorkflowFlowScopedNodeId(`${coordinate.blockId}#${coordinate.branchId}`, workflowPath))?.label
                ?? coordinate.branchId;
        }
        if (coordinate.kind === 'workflow') {
            const label = projection?.nodesById.get(resolveWorkflowFlowScopedNodeId(coordinate.blockId, workflowPath))?.label;
            workflowPath.push(coordinate.blockId);
            return label ?? t('workflows.page.blocks.menuRun');
        }
        const number = String(coordinate.index + 1);
        return coordinate.kind === 'item'
            ? coordinate.displayLabel ?? t('workflows.run.occurrenceItem', { number })
            : t('workflows.run.occurrenceRound', { number });
    }).filter((_, index) => scope === 'full' || occurrence[index]?.kind === 'item' || occurrence[index]?.kind === 'iteration');
    return parts.length === 0 ? undefined : parts.join(' · ');
}

export type WorkflowInvocationStructureEntry = Readonly<{
    invocationId: string;
    /**
     * The Flow node this row belongs to, or `null` when the public index cannot
     * resolve exactly one. `null` is a truthful "not known yet", never a guess.
     */
    nodeId: string | null;
    /** The authored block, `'$root'` for the structural root, or `null` when unresolved. */
    blockId: string | null;
    /** Scoped occurrence coordinates, outermost first. */
    occurrence: readonly WorkflowOccurrenceCoordinate[];
    /** True for a structural frame row (root, parallel branch body, loop iteration body). */
    isFrame: boolean;
    /** Structural success is not a completed executable leaf. */
    coverageKind: WorkflowInvocationCoverageKind;
}>;

type Scope = WorkflowInvocationPathV1['scope'];
type FrozenChildren = Readonly<Record<string, WorkflowDefinitionV1>>;

function scopedBlockId(blockId: string, scope: Scope): string {
    return resolveWorkflowFlowScopedNodeId(blockId, scope.flatMap((entry) => entry.kind === 'workflow' ? [entry.blockId] : []));
}

type ParallelBlock = Extract<WorkflowBlock, { kind: 'parallel' }>;
type LoopBlock = Extract<WorkflowBlock, { kind: 'loop' }>;
type IfBlock = Extract<WorkflowBlock, { kind: 'if' }>;

/** Map occurrence names and the Steps engine projection resolve the same frozen lexical item. */
export function readWorkflowLoopOccurrenceItem(params: Readonly<{
    loop: LoopBlock | undefined;
    index: number;
    inputs?: Readonly<Record<string, JsonValue>>;
    outerItem?: JsonValue;
}>): JsonValue | undefined {
    const reference = params.loop?.repetition.kind === 'items' ? params.loop.repetition.items : undefined;
    const collection = reference?.kind === 'literal' ? reference.value
        : reference?.kind === 'input' && params.inputs?.[reference.name] !== undefined
            ? readWorkflowValuePathV1(params.inputs[reference.name]!, reference.path ?? [])
            : reference?.kind === 'item' && reference.field === 'value' && params.outerItem !== undefined
                ? readWorkflowValuePathV1(params.outerItem, reference.path ?? []) : undefined;
    return Array.isArray(collection) ? collection[params.index] : undefined;
}

/**
 * What a row's *children* mean. The coordinator assigns `memberOrdinal` inside
 * exactly one of these containers, so this union is the whole mapping rule.
 */
type MemberContext =
    | Readonly<{ kind: 'list'; blocks: readonly WorkflowBlock[]; scope: Scope }>
    | Readonly<{ kind: 'conditionalBlocks'; block: IfBlock; scope: Scope }>
    | Readonly<{ kind: 'branchFrames'; block: ParallelBlock; scope: Scope }>
    | Readonly<{ kind: 'memberFrames'; block: LoopBlock; scope: Scope }>
    | Readonly<{ kind: 'loopBody'; block: LoopBlock; scope: Scope }>;

type ResolvedMember = Readonly<{
    blockId: string | null;
    isFrame: boolean;
    scope: Scope;
    children: MemberContext | null;
}>;

function toIndex(decimal: string): number | null {
    // Canonical nonnegative decimal strings; anything else is not a slot we can
    // reason about and stays unresolved rather than being coerced.
    if (!/^\d+$/.test(decimal)) return null;
    const value = Number(decimal);
    return Number.isSafeInteger(value) ? value : null;
}

function childContextForBlock(block: WorkflowBlock, scope: Scope, frozenChildren: FrozenChildren): MemberContext | null {
    switch (block.kind) {
        case 'step':
        case 'action':
        case 'wait': return null;
        case 'workflow': {
            const child = frozenChildren[block.workflowRef];
            return child === undefined ? null : { kind: 'list', blocks: child.blocks,
                scope: [...scope, { kind: 'workflow', blockId: block.id }] };
        }
        case 'parallel': return { kind: 'branchFrames', block, scope };
        case 'loop': return { kind: 'memberFrames', block, scope };
        case 'if': return { kind: 'conditionalBlocks', block, scope };
    }
}

function resolveListMember(
    blocks: readonly WorkflowBlock[],
    ordinal: number,
    scope: Scope,
    frozenChildren: FrozenChildren,
): ResolvedMember | null {
    const block = blocks[ordinal];
    if (block === undefined) return null;
    return { blockId: block.id, isFrame: false, scope, children: childContextForBlock(block, scope, frozenChildren) };
}

const UNRESOLVED: ResolvedMember = { blockId: null, isFrame: false, scope: [], children: null };

function resolveMember(context: MemberContext, ordinal: number, frozenChildren: FrozenChildren): ResolvedMember | null {
    switch (context.kind) {
        case 'list':
            return resolveListMember(context.blocks, ordinal, context.scope, frozenChildren);
        case 'conditionalBlocks': {
            // Which branch executed is a private decision. When only one branch
            // can hold this ordinal the answer is structural; otherwise the row
            // stays unresolved until it is opened.
            const inThen = ordinal < context.block.then.length;
            const inOtherwise = ordinal < context.block.otherwise.length;
            if (inThen && inOtherwise) return UNRESOLVED;
            if (inThen) return resolveListMember(context.block.then, ordinal, context.scope, frozenChildren);
            if (inOtherwise) return resolveListMember(context.block.otherwise, ordinal, context.scope, frozenChildren);
            return null;
        }
        case 'branchFrames': {
            const branch = context.block.branches[ordinal];
            if (branch === undefined) return null;
            const scope: Scope = [
                ...context.scope,
                { kind: 'branch', blockId: context.block.id, branchId: branch.id },
            ];
            return {
                blockId: context.block.id,
                isFrame: true,
                scope,
                children: { kind: 'list', blocks: branch.blocks, scope },
            };
        }
        case 'memberFrames': {
            const scope: Scope = [
                ...context.scope,
                { kind: 'iteration', blockId: context.block.id, index: ordinal },
            ];
            return {
                blockId: context.block.id,
                isFrame: true,
                scope,
                children: { kind: 'loopBody', block: context.block, scope },
            };
        }
        case 'loopBody': {
            const body = context.block.body;
            if (ordinal < body.length) return resolveListMember(body, ordinal, context.scope, frozenChildren);
            // The evaluator continuation runs after the body and occupies the
            // slot immediately past it.
            const repetition = context.block.repetition;
            if (repetition.kind === 'evaluate' && ordinal === body.length) {
                return {
                    blockId: repetition.evaluator.id,
                    isFrame: false,
                    scope: context.scope,
                    children: null,
                };
            }
            return null;
        }
    }
}

/**
 * The Flow node id for a resolved row.
 *
 * A parallel branch frame belongs to its own branch node so an occurrence is
 * attributed precisely; every other row belongs to its authored block.
 */
export function resolveWorkflowFlowNodeIdForInvocation(params: Readonly<{
    blockId: string | null;
    scope: Scope;
    isFrame: boolean;
}>): string | null {
    if (params.blockId === null || params.blockId === '$root') return null;
    if (params.isFrame) {
        const tail = params.scope[params.scope.length - 1];
        if (tail !== undefined && tail.kind === 'branch' && tail.blockId === params.blockId) {
            return scopedBlockId(`${params.blockId}#${tail.branchId}`, params.scope);
        }
    }
    return scopedBlockId(params.blockId, params.scope);
}

function collectWorkflowBlocksById(
    blocks: readonly WorkflowBlock[], into: Map<string, WorkflowBlock>, frozenChildren: FrozenChildren,
    workflowPath: readonly string[] = [], refs: readonly string[] = [],
    defaultParticipant?: WorkflowDefinitionV1['defaults']['participant'],
    itemParticipantNodes?: Set<string>,
    acceptedItemParticipants?: ReadonlySet<string>,
    sourceRefsByNode?: Map<string, string | null>,
): void {
    const record = (block: WorkflowBlock): void => {
        const nodeId = resolveWorkflowFlowScopedNodeId(block.id, workflowPath);
        into.set(nodeId, block);
        sourceRefsByNode?.set(nodeId, refs[refs.length - 1] ?? null);
        const participant = block.kind === 'step' ? block.execution?.participant ?? defaultParticipant : undefined;
        if (block.kind === 'step' && ((participant?.kind === 'item' && (participant.path?.length ?? 0) === 0)
            || acceptedItemParticipants?.has(JSON.stringify([refs[refs.length - 1] ?? '$root', block.id])))) itemParticipantNodes?.add(nodeId);
    };
    for (const block of blocks) {
        record(block);
        switch (block.kind) {
            case 'step':
            case 'action':
            case 'wait': break;
            case 'workflow': {
                const child = frozenChildren[block.workflowRef];
                if (child !== undefined && !refs.includes(block.workflowRef)) {
                    collectWorkflowBlocksById(child.blocks, into, frozenChildren, [...workflowPath, block.id], [...refs, block.workflowRef],
                        child.defaults.participant, itemParticipantNodes, acceptedItemParticipants, sourceRefsByNode);
                }
                break;
            }
            case 'parallel':
                for (const branch of block.branches) collectWorkflowBlocksById(branch.blocks, into, frozenChildren, workflowPath, refs, defaultParticipant, itemParticipantNodes, acceptedItemParticipants, sourceRefsByNode);
                break;
            case 'loop':
                collectWorkflowBlocksById(block.body, into, frozenChildren, workflowPath, refs, defaultParticipant, itemParticipantNodes, acceptedItemParticipants, sourceRefsByNode);
                if (block.repetition.kind === 'evaluate') record(block.repetition.evaluator);
                break;
            case 'if':
                collectWorkflowBlocksById(block.then, into, frozenChildren, workflowPath, refs, defaultParticipant, itemParticipantNodes, acceptedItemParticipants, sourceRefsByNode);
                collectWorkflowBlocksById(block.otherwise, into, frozenChildren, workflowPath, refs, defaultParticipant, itemParticipantNodes, acceptedItemParticipants, sourceRefsByNode);
                break;
        }
    }
}

/** Resolve a private invocation's authored block through the same frozen identity owner as the map. */
export function resolveWorkflowInvocationBlock(params: Readonly<{
    definition: WorkflowDefinitionV1;
    frozenChildren?: FrozenChildren;
    invocationPath: WorkflowInvocationPathV1;
}>): WorkflowBlock | undefined {
    return resolveWorkflowInvocationBlockContext(params)?.block;
}

/** The frozen definition and its accepted source travel with the resolved block. */
export function resolveWorkflowInvocationBlockContext(params: Readonly<{
    definition: WorkflowDefinitionV1;
    frozenChildren?: FrozenChildren;
    sourceRef?: string | null;
    invocationPath: WorkflowInvocationPathV1;
}>): Readonly<{ block: WorkflowBlock; definition: WorkflowDefinitionV1; sourceRef: string | null }> | undefined {
    const blocks = new Map<string, WorkflowBlock>();
    const sourceRefs = new Map<string, string | null>();
    const frozenChildren = params.frozenChildren ?? {};
    collectWorkflowBlocksById(params.definition.blocks, blocks, frozenChildren, [], [], undefined, undefined, undefined, sourceRefs);
    const nodeId = scopedBlockId(params.invocationPath.blockId, params.invocationPath.scope);
    const block = blocks.get(nodeId);
    if (block === undefined) return undefined;
    const childRef = sourceRefs.get(nodeId) ?? null;
    const definition = childRef === null ? params.definition : frozenChildren[childRef];
    if (definition === undefined) return undefined;
    return { block, definition, sourceRef: childRef ?? params.sourceRef ?? null };
}

/**
 * Presentation only, never an opened-progress fact. A frozen, unambiguous
 * fieldless Wait can keep its Continue card in place while the exact read is
 * pending. Its caller must still require confirmed evidence before mutation.
 */
export function projectUnconfirmedWorkflowWaitReview(params: Readonly<{
    definition: WorkflowDefinitionV1 | null;
    frozenChildren?: FrozenChildren;
    invocation: WorkflowRunInvocationIndexV1 | null;
    structure: WorkflowInvocationStructureEntry | undefined;
}>): WorkflowProgressEnvelopeV1 | null {
    const { definition, invocation, structure } = params;
    if (!definition || !invocation || invocation.lifecycle !== 'waiting_for_review'
        || structure?.invocationId !== invocation.id || !structure.nodeId || structure.isFrame) return null;
    const blocks = new Map<string, WorkflowBlock>();
    collectWorkflowBlocksById(definition.blocks, blocks, params.frozenChildren ?? {});
    const block = blocks.get(structure.nodeId);
    if (block?.kind !== 'wait' || block.result !== undefined) return null;
    return {
        kind: 'happier.workflow-progress.v1', blockKind: 'wait',
        logicalInvocationRecordId: invocation.id, attempt: invocation.attempt,
        invocationPath: { blockId: block.id, scope: structure.occurrence.map(entry => entry.kind === 'item'
            ? { kind: 'iteration' as const, blockId: entry.blockId, index: entry.index } : entry) },
    };
}

/**
 * The member context an *opened* row establishes for its own children. An
 * opened conditional additionally records which branch it selected, so its
 * subtree stops being ambiguous.
 */
function childContextFromProgress(
    progress: WorkflowProgressEnvelopeV1,
    definition: WorkflowDefinitionV1,
    blocksById: ReadonlyMap<string, WorkflowBlock>,
    frozenChildren: FrozenChildren,
): MemberContext | null {
    const path = progress.invocationPath;
    if (path.blockId === '$root') return { kind: 'list', blocks: definition.blocks, scope: [] };
    const block = blocksById.get(scopedBlockId(path.blockId, path.scope));
    if (block === undefined) return null;
    if (progress.frame !== undefined && progress.frame.ownerBlockId === path.blockId
        && (block.kind === 'parallel' || block.kind === 'loop')) {
        if (block.kind === 'parallel') {
            const tail = path.scope[path.scope.length - 1];
            const branch = tail !== undefined && tail.kind === 'branch'
                ? block.branches.find((candidate) => candidate.id === tail.branchId)
                : undefined;
            return branch === undefined
                ? null
                : { kind: 'list', blocks: branch.blocks, scope: path.scope };
        }
        if (block.kind === 'loop') return { kind: 'loopBody', block, scope: path.scope };
        return null;
    }
    if (block.kind === 'if' && progress.container?.kind === 'if') {
        const selected = progress.container.selected === 'then' ? block.then : block.otherwise;
        return { kind: 'list', blocks: selected, scope: path.scope };
    }
    return childContextForBlock(block, path.scope, frozenChildren);
}

/**
 * Scope coordinates carry the authored distinction between an item occurrence
 * and a plain iteration, which the private path alone does not record.
 *
 * The frozen definition is the authority. `frameHint` is consulted only for a
 * loop the read definition cannot explain — an observed or partially readable
 * definition — where an opened row's own frame is the single remaining fact.
 */
function describeOccurrence(
    scope: Scope,
    loopsById: ReadonlyMap<string, LoopBlock>,
    frameHint?: WorkflowProgressEnvelopeV1['frame'],
    itemLabels?: ReadonlyMap<string, string>,
): readonly WorkflowOccurrenceCoordinate[] {
    const workflowPath: string[] = [];
    return scope.map((entry, position) => {
        if (entry.kind === 'workflow') workflowPath.push(entry.blockId);
        if (entry.kind === 'branch' || entry.kind === 'workflow') return entry;
        const loop = loopsById.get(resolveWorkflowFlowScopedNodeId(entry.blockId, workflowPath));
        const isItem = loop !== undefined
            ? loop.repetition.kind === 'items'
            : frameHint?.ownerBlockId === entry.blockId && frameHint.source.kind === 'item';
        const displayLabel = isItem ? itemLabels?.get(JSON.stringify(scope.slice(0, position + 1))) : undefined;
        return isItem
            ? { kind: 'item' as const, blockId: entry.blockId, index: entry.index,
                ...(displayLabel === undefined ? {} : { displayLabel }) }
            : { kind: 'iteration' as const, blockId: entry.blockId, index: entry.index };
    });
}

export function projectWorkflowInvocationStructure(params: Readonly<{
    definition: WorkflowDefinitionV1 | null;
    frozenChildren?: FrozenChildren;
    /** Accepted definitions flatten selection; sidecars retain the original participant binding. */
    materializedLeaves?: readonly WorkflowMaterializedLeafV1[];
    invocations: readonly WorkflowRunInvocationIndexV1[];
    /** Exact rows already opened through the authorized Action; authoritative when present. */
    progressByInvocationId?: ReadonlyMap<string, WorkflowProgressEnvelopeV1>;
    /** Exact opened tokens qualify additional private labels; stale retained content cannot disclose them. */
    invocationEvidenceById?: ReadonlyMap<string, Readonly<{ index: WorkflowRunInvocationIndexV1; progress: WorkflowProgressEnvelopeV1 }>>;
    /** Home-qualified Session titles from the canonical display-name projection; no private reads. */
    sessionDisplayLabelsById?: ReadonlyMap<string, string>;
    /** Immutable accepted inputs can name cold occurrences without opening private invocation bodies. */
    inputs?: Readonly<Record<string, JsonValue>>;
    serverId?: string | null;
}>): ReadonlyMap<string, WorkflowInvocationStructureEntry> {
    const entries = new Map<string, WorkflowInvocationStructureEntry>();
    const definition = params.definition;
    if (definition === null) return entries;

    const blocksById = new Map<string, WorkflowBlock>();
    const frozenChildren = params.frozenChildren ?? {};
    const itemParticipantNodes = new Set<string>();
    const acceptedItemParticipants = new Set(params.materializedLeaves?.flatMap(leaf => {
        const reference = leaf.participantBindings?.reference;
        return leaf.kind === 'step' && reference?.kind === 'item' && (reference.path?.length ?? 0) === 0
            ? [JSON.stringify([leaf.sourceKey, leaf.blockId])] : [];
    }));
    collectWorkflowBlocksById(definition.blocks, blocksById, frozenChildren, [], [], definition.defaults.participant, itemParticipantNodes, acceptedItemParticipants);
    const loopsById = new Map<string, LoopBlock>();
    for (const [key, block] of blocksById) if (block.kind === 'loop') loopsById.set(key, block);
    const invocationById = new Map(params.invocations.map(invocation => [invocation.id, invocation]));
    const currentProgressById = new Map<string, WorkflowProgressEnvelopeV1>();
    const itemLabelsById = new Map<string, Readonly<{ scopeKey: string; label: string }>>();
    for (const invocation of params.invocations) {
        const opened = params.invocationEvidenceById?.get(invocation.id);
        if (!opened || opened.index.id !== invocation.id || opened.index.runId !== invocation.runId
            || opened.index.attempt !== invocation.attempt || opened.index.contentRevision !== invocation.contentRevision
            || opened.progress.attempt !== invocation.attempt) continue;
        const { progress } = opened;
        currentProgressById.set(invocation.id, progress);
        const frame = progress.frame;
        if (progress.blockKind !== 'loop' || frame?.ownerBlockId !== progress.invocationPath.blockId
            || frame.source.kind !== 'item' || frame.source.displayLabel === undefined) continue;
        const scope = progress.invocationPath.scope;
        const coordinate = scope[scope.length - 1];
        if (coordinate?.kind !== 'iteration' || coordinate.blockId !== frame.ownerBlockId
            || String(coordinate.index) !== frame.source.index) continue;
        itemLabelsById.set(invocation.id, { scopeKey: JSON.stringify(scope), label: frame.source.displayLabel });
    }

    const record = (
        invocationId: string,
        resolved: Readonly<{ blockId: string | null; scope: Scope; isFrame: boolean; blockKind?: WorkflowProgressEnvelopeV1['blockKind'] }>,
        frameHint?: WorkflowProgressEnvelopeV1['frame'],
    ): void => {
        const block = resolved.blockId === null ? undefined : blocksById.get(scopedBlockId(resolved.blockId, resolved.scope));
        // An opened row states its own kind, including inside a called workflow.
        // The parent definition can explain only unopened parent-definition rows.
        const blockKind = resolved.blockKind ?? block?.kind;
        // A replacement can reuse the same scope. Its leaf may name only its own
        // loaded item-frame ancestry, never an older frame with matching coordinates.
        const itemLabels = new Map<string, string>();
        const seen = new Set<string>();
        let ancestorId: string | null = invocationId;
        while (ancestorId !== null && !seen.has(ancestorId)) {
            seen.add(ancestorId);
            const label = itemLabelsById.get(ancestorId);
            if (label && !itemLabels.has(label.scopeKey)) itemLabels.set(label.scopeKey, label.label);
            ancestorId = invocationById.get(ancestorId)?.parentRecordId ?? null;
        }
        let occurrence = describeOccurrence(resolved.scope, loopsById, frameHint, itemLabels);
        let itemValue: JsonValue | undefined;
        let acceptedItemLabel: string | undefined;
        let localInputs = params.inputs;
        const workflowPath: string[] = [];
        occurrence = occurrence.map(coordinate => {
            if (coordinate.kind === 'workflow') {
                workflowPath.push(coordinate.blockId);
                // A called workflow owns its inputs. Never resolve a child against its parent's names.
                localInputs = undefined;
                itemValue = undefined;
                acceptedItemLabel = undefined;
                return coordinate;
            }
            if (coordinate.kind !== 'item') return coordinate;
            const loop = loopsById.get(resolveWorkflowFlowScopedNodeId(coordinate.blockId, workflowPath));
            itemValue = readWorkflowLoopOccurrenceItem({ loop, index: coordinate.index, inputs: localInputs, outerItem: itemValue });
            const participant = normalizeExecutableParticipantSelectionV1(itemValue);
            const name = participant?.kind === 'session'
                ? params.serverId && areServerProfileIdentifiersEquivalent(participant.session.serverId, params.serverId)
                    ? params.sessionDisplayLabelsById?.get(participant.session.sessionId) : undefined
                : projectWorkflowLoopItemDisplayLabelV1(participant?.kind === 'model' ? participant.launch.title : itemValue);
            acceptedItemLabel = name;
            return name === undefined || coordinate.displayLabel !== undefined ? coordinate : { ...coordinate, displayLabel: name };
        });
        const nodeId = resolved.blockId === null ? null : scopedBlockId(resolved.blockId, resolved.scope);
        if (!resolved.isFrame && nodeId !== null && itemParticipantNodes.has(nodeId)) {
            const progress = currentProgressById.get(invocationId);
            const execution = progress?.execution;
            const label = progress?.invocationPath.blockId === resolved.blockId
                && JSON.stringify(progress.invocationPath.scope) === JSON.stringify(resolved.scope)
                && (execution?.kind === 'session' || execution?.kind === 'session_ready')
                ? params.sessionDisplayLabelsById?.get(execution.sessionId) : undefined;
            // The innermost item owns the participant. Keep a recorded human
            // name while its Session inventory is unavailable; older writers
            // accidentally recorded only the participant's wire kind.
            let itemPosition = occurrence.length - 1;
            while (itemPosition >= 0 && occurrence[itemPosition]?.kind !== 'item') itemPosition -= 1;
            occurrence = occurrence.map((coordinate, position) => {
                if (position !== itemPosition || coordinate.kind !== 'item') return coordinate;
                const recorded = coordinate.displayLabel;
                const displayLabel = acceptedItemLabel ?? label ?? (recorded === 'session' || recorded === 'model' || recorded === 'bot' ? undefined : recorded);
                return { kind: 'item', blockId: coordinate.blockId, index: coordinate.index,
                    ...(displayLabel === undefined ? {} : { displayLabel }) };
            });
        }
        entries.set(invocationId, {
            invocationId,
            nodeId: block === undefined ? null : resolveWorkflowFlowNodeIdForInvocation(resolved),
            blockId: resolved.blockId,
            occurrence,
            isFrame: resolved.isFrame,
            coverageKind: classifyWorkflowInvocationCoverage(blockKind, resolved.isFrame || resolved.blockId === '$root'),
        });
    };

    // An opened row states its own path; nothing below may contradict it.
    const progressById = params.progressByInvocationId;
    if (progressById !== undefined) {
        for (const invocation of params.invocations) {
            const progress = progressById.get(invocation.id);
            if (progress === undefined) continue;
            // A row is a structural frame only when the frame it records is its
            // own block's. A leaf step may also carry the enclosing item frame,
            // which describes where it ran — not that it is a container.
            record(invocation.id, {
                blockId: progress.invocationPath.blockId,
                blockKind: progress.blockKind,
                scope: progress.invocationPath.scope,
                isFrame: progress.blockKind === 'root'
                    || ((progress.blockKind === 'parallel' || progress.blockKind === 'loop')
                        && progress.frame !== undefined
                        && progress.frame.ownerBlockId === progress.invocationPath.blockId),
            }, progress.frame);
        }
    }

    const childrenByParent = new Map<string, WorkflowRunInvocationIndexV1[]>();
    let rootInvocation: WorkflowRunInvocationIndexV1 | null = null;
    for (const invocation of params.invocations) {
        if (invocation.parentRecordId === null) {
            // Exactly one root frame exists per Run; a merged attention page can
            // repeat it but never introduce a second.
            if (rootInvocation === null) rootInvocation = invocation;
            continue;
        }
        const siblings = childrenByParent.get(invocation.parentRecordId);
        if (siblings === undefined) childrenByParent.set(invocation.parentRecordId, [invocation]);
        else siblings.push(invocation);
    }
    if (rootInvocation === null) return entries;

    if (!entries.has(rootInvocation.id)) {
        record(rootInvocation.id, { blockId: '$root', scope: [], isFrame: true });
    }

    const queue: Array<Readonly<{ invocationId: string; children: MemberContext | null }>> = [{
        invocationId: rootInvocation.id,
        children: { kind: 'list', blocks: definition.blocks, scope: [] },
    }];

    // Breadth-first over loaded ancestry only: a row whose parent page is not
    // loaded stays absent rather than being attached to a plausible neighbour.
    while (queue.length > 0) {
        const current = queue.shift()!;
        const children = childrenByParent.get(current.invocationId);
        if (children === undefined || current.children === null) continue;
        for (const child of children) {
            const progress = progressById?.get(child.id);
            if (progress !== undefined) {
                queue.push({ invocationId: child.id, children: childContextFromProgress(progress, definition, blocksById, frozenChildren) });
                continue;
            }
            const ordinal = toIndex(child.memberOrdinal);
            const resolved = ordinal === null ? null : resolveMember(current.children, ordinal, frozenChildren);
            if (resolved === null) {
                // An ordinal the frozen definition cannot explain is recorded as
                // unresolved so the row still appears, without a fabricated node.
                if (!entries.has(child.id)) record(child.id, { blockId: null, scope: [], isFrame: false });
                continue;
            }
            record(child.id, resolved);
            queue.push({ invocationId: child.id, children: resolved.children });
        }
    }

    return entries;
}

/**
 * Orders two occurrences of one block as their items and rounds are numbered (item 1 before item 3),
 * whatever order they were dispatched or indexed in. Occurrences outside a repetition compare equal,
 * so a stable sort keeps their recorded order.
 */
export function compareWorkflowOccurrences(
    left: readonly WorkflowOccurrenceCoordinate[],
    right: readonly WorkflowOccurrenceCoordinate[],
): number {
    const indexes = (occurrence: readonly WorkflowOccurrenceCoordinate[]) => occurrence
        .flatMap((coordinate) => coordinate.kind === 'item' || coordinate.kind === 'iteration' ? [coordinate.index] : []);
    const a = indexes(left);
    const b = indexes(right);
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
        const difference = (a[i] ?? 0) - (b[i] ?? 0);
        if (difference !== 0) return difference;
    }
    return a.length - b.length;
}

/**
 * The run state Flow draws on each authored node: exactly the lifecycles the
 * invocation owner supplied, placed by this structure owner. It never derives a
 * lifecycle from structure or timing, and structural frames are scopes, not
 * executions of their block, so they are left out. Run detail and a Work row's
 * compact map both read it, so the two cannot place a row differently.
 */
export function projectWorkflowFlowRunStates(params: Readonly<{
    invocations: readonly WorkflowRunInvocationIndexV1[];
    structure: ReadonlyMap<string, WorkflowInvocationStructureEntry>;
    progressByInvocationId?: ReadonlyMap<string, WorkflowProgressEnvelopeV1>;
    projection?: WorkflowFlowProjection;
    /** Names a row's occurrence ("Item 3"); omitted where only the state is drawn. */
    formatOccurrence?: (occurrence: readonly WorkflowOccurrenceCoordinate[]) => string | undefined;
}>): ReadonlyMap<string, readonly WorkflowFlowNodeRunState[]> {
    const states: WorkflowFlowNodeRunState[] = [];
    // A For-each's items read in their own order (DESIGN-15 R2/R6), not the order they were dispatched in.
    const ordered = [...params.invocations].sort((left, right) => compareWorkflowOccurrences(
        params.structure.get(left.id)?.occurrence ?? [], params.structure.get(right.id)?.occurrence ?? []));
    for (const invocation of ordered) {
        const entry = params.structure.get(invocation.id);
        if (entry === undefined || entry.nodeId === null || entry.isFrame) continue;
        const occurrenceLabel = params.formatOccurrence?.(entry.occurrence);
        const opened = params.progressByInvocationId?.get(invocation.id);
        const progress = opened?.attempt === invocation.attempt ? opened : undefined;
        const repetition = params.projection?.nodesById.get(entry.nodeId)?.repetition;
        const maxConcurrent = repetition?.kind === 'items'
            ? repetition.itemExecution === 'sequential' ? 1 : repetition.maxConcurrent : undefined;
        states.push({
            nodeId: entry.nodeId,
            invocationId: invocation.id,
            lifecycle: invocation.lifecycle,
            attempt: invocation.attempt,
            ...(occurrenceLabel === undefined ? {} : { occurrenceLabel }),
            ...(progress?.timing ? { timing: progress.timing } : {}),
            ...(progress?.loopProgress && repetition?.kind === 'items'
                ? { loopProgress: { ...progress.loopProgress, ...(maxConcurrent === undefined ? {} : { maxConcurrent }) } } : {}),
        });
    }
    return indexWorkflowFlowRunStates(states);
}
