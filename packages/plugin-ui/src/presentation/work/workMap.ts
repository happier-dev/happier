/**
 * The neutral Work map contract.
 *
 * One map shows a lead and the work it started, a workflow's structure, or a
 * run in progress. Producers own their grammar and labels (the workflow
 * producer is `projectWorkflowFlow`); they declare nodes and the one edge each
 * node has — its declared parent — and this module derives placement from
 * exactly those declarations. Nothing here infers an edge from order, timing,
 * workspace or kind: a node without a declared parent that the map holds is a
 * root, whatever it sits next to.
 */

/** Where opening a node leads. Producers pick the target; renderers only forward it. */
export type HappierWorkMapOpenTarget =
  | Readonly<{ kind: 'session'; sessionId: string }>
  | Readonly<{ kind: 'run'; runId: string }>
  | Readonly<{ kind: 'action_operation'; serverId: string; operationId: string }>
  | Readonly<{ kind: 'workflow-step'; nodeId: string }>;

/**
 * What a producer declares for one node. `parentNodeId` is the node's one
 * edge (a lead for a worker, a run for its step, a container for a block).
 */
export type HappierWorkMapNodeDeclaration = Readonly<{
  nodeId: string;
  label: string;
  /**
   * A quiet fact read after the name on the same line ("2 lanes"): drawn in the regular face after a
   * middle dot, and part of the node's accessible name.
   */
  labelDetail?: string;
  parentNodeId: string | null;
  open: HappierWorkMapOpenTarget;
}>;

/** Placement derived from declared edges only. */
export type HappierWorkMapPlacement = Readonly<{
  /** Declared parent when the map holds it; otherwise the node is a root. */
  parentNodeId: string | null;
  depth: number;
  /** 1-based position within the node's own sibling list. */
  ordinal: number;
  childNodeIds: readonly string[];
}>;

export type HappierWorkMapPlaced<TDeclaration extends HappierWorkMapNodeDeclaration> = TDeclaration & HappierWorkMapPlacement;

export type HappierWorkMapNode = HappierWorkMapPlaced<HappierWorkMapNodeDeclaration>;

/**
 * Whether relationships between nodes are known. A producer that observed
 * work without its structure says `unknown`; the renderer then keeps nodes
 * unlinked rather than suggesting a relationship.
 */
export type HappierWorkMapRelationships = 'authored' | 'unknown';

export type HappierWorkMap<TNode extends HappierWorkMapNode = HappierWorkMapNode> = Readonly<{
  /** Declaration order; nodes the declared edges cannot reach from a root are not held. */
  nodes: readonly TNode[];
  nodesById: ReadonlyMap<string, TNode>;
  rootNodeIds: readonly string[];
  relationships: HappierWorkMapRelationships;
}>;

/**
 * Places declared nodes. A declared parent the map does not hold (for
 * example a lead outside the listed work) leaves the node at the root rather
 * than attaching it anywhere else. The first declaration of a node id wins.
 */
export function buildHappierWorkMap<TDeclaration extends HappierWorkMapNodeDeclaration>(input: Readonly<{
  relationships: HappierWorkMapRelationships;
  nodes: readonly TDeclaration[];
}>): HappierWorkMap<HappierWorkMapPlaced<TDeclaration>> {
  const declared = new Map<string, TDeclaration>();
  for (const node of input.nodes) {
    if (!declared.has(node.nodeId)) declared.set(node.nodeId, node);
  }

  const rootNodeIds: string[] = [];
  const childIdsByNode = new Map<string, string[]>();
  const parentByNode = new Map<string, string | null>();
  for (const node of declared.values()) {
    const parentNodeId = node.parentNodeId !== null
      && node.parentNodeId !== node.nodeId
      && declared.has(node.parentNodeId)
      ? node.parentNodeId
      : null;
    parentByNode.set(node.nodeId, parentNodeId);
    if (parentNodeId === null) {
      rootNodeIds.push(node.nodeId);
    } else {
      const siblings = childIdsByNode.get(parentNodeId);
      if (siblings === undefined) childIdsByNode.set(parentNodeId, [node.nodeId]);
      else siblings.push(node.nodeId);
    }
  }

  const placement = new Map<string, Readonly<{ depth: number; ordinal: number }>>();
  const place = (siblingIds: readonly string[], depth: number): void => {
    siblingIds.forEach((nodeId, index) => {
      placement.set(nodeId, { depth, ordinal: index + 1 });
      place(childIdsByNode.get(nodeId) ?? [], depth + 1);
    });
  };
  place(rootNodeIds, 0);

  const nodes: HappierWorkMapPlaced<TDeclaration>[] = [];
  for (const node of declared.values()) {
    const placed = placement.get(node.nodeId);
    // Only a cycle in the declared edges leaves a node unreachable from a root.
    if (placed === undefined) continue;
    nodes.push({
      ...node,
      parentNodeId: parentByNode.get(node.nodeId) ?? null,
      depth: placed.depth,
      ordinal: placed.ordinal,
      childNodeIds: childIdsByNode.get(node.nodeId) ?? [],
    });
  }

  return {
    nodes,
    nodesById: new Map(nodes.map((node) => [node.nodeId, node])),
    rootNodeIds,
    relationships: input.relationships,
  };
}

/**
 * A node's structural position, for the accessible name a producer gives it:
 * the rails are decorative, so the position and owning node have to be spoken.
 * The words belong to the producer; this is only the structure.
 */
export function resolveHappierWorkMapNodePosition<TNode extends HappierWorkMapNode>(
  map: HappierWorkMap<TNode>,
  node: TNode,
): Readonly<{ position: number; total: number; parent: TNode | null }> {
  const parent = node.parentNodeId === null ? null : map.nodesById.get(node.parentNodeId) ?? null;
  const siblings = parent === null ? map.rootNodeIds : parent.childNodeIds;
  return {
    position: node.ordinal,
    total: Math.max(siblings.length, node.ordinal),
    parent,
  };
}

/** A node's name as one phrase: its label, then its quiet detail when it has one ("Side by side · 2 lanes"). */
export function formatHappierWorkMapNodeName(node: Readonly<{ label: string; labelDetail?: string }>): string {
  return node.labelDetail === undefined ? node.label : `${node.label} \u00b7 ${node.labelDetail}`;
}
