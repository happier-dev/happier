/** DOM event targets are admitted at the web boundary, using the root's realm. */
export function isFindSurfaceTarget(root: Element | null | undefined, target: unknown): boolean {
    const NodeConstructor = root?.ownerDocument.defaultView?.Node;
    return Boolean(root && NodeConstructor && target instanceof NodeConstructor && root.contains(target));
}
