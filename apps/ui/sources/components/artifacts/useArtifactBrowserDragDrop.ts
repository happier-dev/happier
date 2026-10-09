import { useEntityDragDropRuntime, useEntityDragSource, useEntityDropTarget } from '@/components/ui/treeDragDrop/entityDragDropHooks';
import { createArtifactBrowserDragSource, createArtifactBrowserDropTarget, type ArtifactBrowserDropTargetInput } from './artifactBrowserDragDrop';

/** Registration reads live callbacks; pointer feedback subscriptions belong in visual leaves. */
export function useArtifactBrowserDragSource(input: Parameters<typeof createArtifactBrowserDragSource>[0]) {
    const runtime = useEntityDragDropRuntime();
    const source = createArtifactBrowserDragSource(input);
    useEntityDragSource(runtime, source);
    return { runtime, sourceId: source.id };
}

export function useArtifactBrowserDropTarget(input: ArtifactBrowserDropTargetInput) {
    const runtime = useEntityDragDropRuntime();
    const target = createArtifactBrowserDropTarget(input);
    useEntityDropTarget(runtime, target);
    return { runtime, targetId: target.id };
}
