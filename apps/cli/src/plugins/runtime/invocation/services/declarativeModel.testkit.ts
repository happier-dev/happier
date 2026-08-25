import type { StablePluginDeclarativeNode } from './declarativeModel';

/**
 * The projected declarative document as a flat preorder list, derived from
 * `root`.
 *
 * The model used to carry this list on the wire as a `nodes` sibling holding the
 * SAME node objects as the tree, so `JSON.stringify` emitted every container's
 * whole subtree once more for each of its ancestors. Nothing read it: the
 * renderer walks `root` (`DeclarativePluginSurface.tsx`) and `PluginSurfaceHost`
 * validates `model.root`. Tests that want the flat view derive it here rather
 * than the payload carrying one.
 *
 * `order` is the normalizer's preorder index, so sorting by it reproduces the
 * exact sequence the removed array had, including the `targetedSurface`
 * fallback the normalizer records as a regular preorder node.
 */
export function listDeclarativeNodesInPreorder(
    root: StablePluginDeclarativeNode,
): readonly StablePluginDeclarativeNode[] {
    const collected: StablePluginDeclarativeNode[] = [];
    const visit = (node: StablePluginDeclarativeNode): void => {
        collected.push(node);
        const container = node as Readonly<{
            children?: readonly StablePluginDeclarativeNode[];
            fallback?: StablePluginDeclarativeNode;
        }>;
        for (const child of container.children ?? []) visit(child);
        if (container.fallback) visit(container.fallback);
    };
    visit(root);
    return Object.freeze(collected.sort((left, right) => left.order - right.order));
}
