/** A block selection can end at the beginning of the next element; that node is not selected. */
export function normalizeExclusiveRangeEnd(range: Range): Range {
    if (range.endOffset !== 0) return range;
    let node: Node | null = range.endContainer;
    while (node && !node.previousSibling) node = node.parentNode;
    node = node?.previousSibling ?? null;
    while (node?.lastChild) node = node.lastChild;
    if (!node || node.nodeType !== 3) return range;
    const normalized = range.cloneRange();
    normalized.setEnd(node, node.textContent?.length ?? 0);
    return normalized;
}
