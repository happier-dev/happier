type DragEventLike = Readonly<{
    currentTarget?: EventTarget | null;
    target?: EventTarget | null;
}>;

type ClosestCapableTarget = EventTarget & {
    closest: (selector: string) => Element | null;
};

const REPOSITORY_TREE_ROW_SELECTOR = '[data-testid^="repository-tree-row-"]';

function hasClosest(target: EventTarget | null | undefined): target is ClosestCapableTarget {
    return typeof (target as ClosestCapableTarget | null | undefined)?.closest === 'function';
}

export function shouldUseRepositoryRootDropTarget(event: DragEventLike): boolean {
    const target = event.target;
    if (!hasClosest(target)) return true;
    if (target === event.currentTarget) return true;
    return target.closest(REPOSITORY_TREE_ROW_SELECTOR) == null;
}
