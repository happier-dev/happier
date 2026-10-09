import { entityDragScopesEqualV1, type EntityDragItemV1, type EntityDragScopeV1,
    type EntityDropAdmissionV1 } from '@happier-dev/protocol/plugins/ui/entityDragDrop';
import { movePromptFolderV1, placeArtifactInPromptFolderV1, type PromptFolderEntryV1, type PromptFoldersV1 } from '@happier-dev/protocol/prompts/library/promptFoldersV1';
import type { EntityDragSource, EntityDropTarget } from '@/components/ui/treeDragDrop/entityDragDropTypes';
import { resolveTreeInstruction } from '@/components/ui/treeDragDrop/resolveTreeInstruction';
import { buildExcludedDescendantIds } from '@/components/ui/treeDragDrop/rules/cyclePrevention';
import type { TreeRow, TreeContainerDropZone, WindowBounds } from '@/components/ui/treeDragDrop/treeDragDropTypes';

export type ArtifactBrowserDragEntity = Readonly<{ kind: 'artifact'; artifactId: string }> | Readonly<{ kind: 'artifact-folder'; folderId: string }>;
export function createArtifactBrowserDragSource(input: Readonly<{
    id?: string; scope: EntityDragScopeV1; entity: ArtifactBrowserDragEntity;
    isCurrent: () => boolean; getBounds?: () => WindowBounds | null; describe?: EntityDragSource['describe'];
}>): EntityDragSource {
    return { id: input.id ?? (input.entity.kind === 'artifact' ? `artifact:${input.entity.artifactId}` : `folder:${input.entity.folderId}`),
        scope: input.scope, getItem: () => ({ ...input.entity, scope: input.scope }),
        isCurrent: input.isCurrent, getBounds: input.getBounds, describe: input.describe };
}

export type ArtifactBrowserDropTargetInput = Readonly<{
    id: string; scope: EntityDragScopeV1;
    getCatalog: () => Readonly<{ folders: PromptFoldersV1 | null; revision: number | 'absent'; canWrite: boolean }>;
    getBounds: () => WindowBounds | null; getRows: () => readonly TreeRow[]; getDropZones: () => readonly TreeContainerDropZone[];
    measureBounds?: EntityDropTarget['measureBounds']; autoscroll?: EntityDropTarget['autoscroll']; isCurrent?: () => boolean;
    describeFolder: (folder: PromptFolderEntryV1 | null) => string; describeMove: () => string; describeRefusal: (code: string) => string;
    execute: EntityDropTarget['execute'];
}>;

/** Pointer, keyboard and Move to folder all resolve one personal semantic Action. */
export function createArtifactBrowserDropTarget(input: ArtifactBrowserDropTargetInput): EntityDropTarget {
    const refuse = (code: string): EntityDropAdmissionV1 => ({ status: 'refused', reason: { code, message: input.describeRefusal(code) } });
    const admit = (item: EntityDragItemV1, folderId: string | null): EntityDropAdmissionV1 => {
        if (!entityDragScopesEqualV1(item.scope, input.scope)) return refuse('scope-mismatch');
        const catalog = input.getCatalog();
        if (!catalog.canWrite || !catalog.folders) return refuse('catalog-unavailable');
        if (item.kind !== 'artifact' && item.kind !== 'artifact-folder') return refuse('kind-not-accepted');
        try {
            if (item.kind === 'artifact') placeArtifactInPromptFolderV1(catalog.folders, { artifactId: item.artifactId, folderId });
            else movePromptFolderV1(catalog.folders, { folderId: item.folderId, parentId: folderId });
        } catch (error) { return refuse(error instanceof Error && 'code' in error ? String(error.code) : 'invalid-folder'); }
        const folder = catalog.folders.folders.find(entry => entry.id === folderId) ?? null;
        return { status: 'allowed', effect: {
            actionId: item.kind === 'artifact' ? 'artifact.folder.set' : 'artifact.folders.move',
            input: item.kind === 'artifact' ? { artifactId: item.artifactId, folderId, expectedRevision: catalog.revision }
                : { folderId: item.folderId, parentId: folderId, expectedRevision: catalog.revision },
            preview: { verb: input.describeMove(), target: input.describeFolder(folder), glyph: folderId === null ? 'topLevel' : 'folder' },
        } };
    };
    return { id: input.id, scope: input.scope, acceptedKinds: ['artifact', 'artifact-folder'],
        getBounds: input.getBounds, measureBounds: input.measureBounds, autoscroll: input.autoscroll, isCurrent: input.isCurrent,
        listDestinations: () => [null, ...(input.getCatalog().folders?.folders ?? [])].map(folder => ({
            destination: { folderId: folder?.id ?? null }, label: input.describeFolder(folder),
        })),
        resolve: context => {
            if (context.input !== 'pointer') {
                const destination = context.destination;
                if (!destination || typeof destination !== 'object' || Array.isArray(destination) || !('folderId' in destination)
                    || (destination.folderId !== null && typeof destination.folderId !== 'string')) return refuse('no-target');
                return admit(context.item, destination.folderId);
            }
            if (context.item.kind !== 'artifact' && context.item.kind !== 'artifact-folder') return refuse('kind-not-accepted');
            const sourceId = context.item.kind === 'artifact' ? `artifact:${context.item.artifactId}` : `folder:${context.item.folderId}`;
            const rows = input.getRows();
            const instruction = resolveTreeInstruction({ rows, dropZones: input.getDropZones(), pointer: context.pointer,
                source: { id: sourceId, kind: context.item.kind === 'artifact' ? 'leaf' : 'container', excludedDescendantIds: buildExcludedDescendantIds(rows, sourceId) },
                rules: { canNestInto: (_source, targetId) => targetId.startsWith('folder:') && admit(context.item, targetId.slice(7)).status === 'allowed',
                    canReorderAround: () => false, canMoveToRoot: () => admit(context.item, null).status === 'allowed' } }).instruction;
            if (instruction.kind === 'nest-into') return admit(context.item, instruction.parentId.slice(7));
            if (instruction.kind === 'move-to-root') return admit(context.item, null);
            if (instruction.kind === 'blocked') {
                if (!input.getCatalog().canWrite) return refuse('catalog-unavailable');
                return refuse(instruction.reason);
            }
            return refuse('no-target');
        },
        execute: input.execute,
    };
}
