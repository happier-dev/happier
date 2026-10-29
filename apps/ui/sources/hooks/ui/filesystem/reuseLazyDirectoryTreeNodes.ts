import type { LazyDirectoryTreeNode } from './lazyDirectoryTreeTypes';

function getLazyDirectoryTreeNodeKey(node: LazyDirectoryTreeNode): string {
    return `${node.type}:${node.path}`;
}

function canReuseLazyDirectoryTreeNode(
    previousNode: LazyDirectoryTreeNode | undefined,
    nextNode: LazyDirectoryTreeNode,
): previousNode is LazyDirectoryTreeNode {
    return previousNode != null
        && previousNode.path === nextNode.path
        && previousNode.name === nextNode.name
        && previousNode.type === nextNode.type
        && previousNode.depth === nextNode.depth
        && previousNode.isExpanded === nextNode.isExpanded
        && previousNode.isLoadingChildren === nextNode.isLoadingChildren
        && previousNode.sizeBytes === nextNode.sizeBytes
        && previousNode.modifiedMs === nextNode.modifiedMs
        && previousNode.source === nextNode.source
        && previousNode.parentDirectoryPath === nextNode.parentDirectoryPath
        && previousNode.errorMessage === nextNode.errorMessage
        && previousNode.infoKind === nextNode.infoKind
        && previousNode.entryCount === nextNode.entryCount;
}

export function reuseLazyDirectoryTreeNodes(
    nextNodes: readonly LazyDirectoryTreeNode[],
    previousNodes: readonly LazyDirectoryTreeNode[],
): readonly LazyDirectoryTreeNode[] {
    if (nextNodes.length === 0) return previousNodes.length === 0 ? previousNodes : [];
    if (previousNodes.length === 0) return [...nextNodes];

    const previousNodesByKey = new Map(
        previousNodes.map((node) => [getLazyDirectoryTreeNodeKey(node), node] as const),
    );

    const nodes = nextNodes.map((node) => {
        const previousNode = previousNodesByKey.get(getLazyDirectoryTreeNodeKey(node));
        return canReuseLazyDirectoryTreeNode(previousNode, node) ? previousNode : node;
    });
    return nodes.length === previousNodes.length && nodes.every((node, index) => node === previousNodes[index])
        ? previousNodes : nodes;
}
