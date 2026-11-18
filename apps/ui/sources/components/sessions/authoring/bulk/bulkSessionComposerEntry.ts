import { listSessionBulkActionDescriptors, type SessionBulkActionDescriptor } from '@/components/sessions/actions/sessionBulkActionPresentation';
import { storeBulkSessionComposerSeed, type BulkSessionComposerSeed } from './bulkSessionComposerHandoff';

export type BulkSessionComposerNavigationEntry = Readonly<{
    id: 'compose';
    kind: 'navigation';
    title: string;
    icon: SessionBulkActionDescriptor['icon'];
    onPress: () => void;
}>;

/** Metadata mutations keep their current descriptor contract; Compose is navigation. */
export function listSessionSelectionBarDescriptors(input: Parameters<typeof listSessionBulkActionDescriptors>[0] & Readonly<{
    composeTitle: string;
    seed: BulkSessionComposerSeed;
    onNavigate: (dataId: string) => void;
}>): readonly (SessionBulkActionDescriptor | BulkSessionComposerNavigationEntry)[] {
    const mutations = listSessionBulkActionDescriptors(input);
    if (input.seed.targets.length === 0) return mutations;
    return [{ id: 'compose', kind: 'navigation', title: input.composeTitle, icon: 'pencil-simple',
        onPress: () => input.onNavigate(storeBulkSessionComposerSeed(input.seed)) }, ...mutations];
}
