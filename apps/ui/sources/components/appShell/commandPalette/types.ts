import type { IconName } from '@/components/ui/icons/Icon';

/**
 * One admitted command produced by `buildCommandPaletteCommands`. It is the
 * catalog's output shape, not a presentation model: rows, matching, selection
 * and keyboard behavior belong to SelectionList.
 */
export interface Command {
    id: string;
    /** Commands already governed by an Action keep that Action's caller policy. */
    actionSpecId?: string;
    /** Construction-owned semantic used by Search to avoid duplicate empty-state recents. */
    kind?: 'recentSession';
    /** Intentionally useful before the user has entered a Search query. */
    emptyQuerySuggested?: boolean;
    title: string;
    subtitle?: string;
    icon?: IconName;
    /** A product mark drawn in place of `icon` by the Search surface (keeps the mark's art out of the catalog's eager graph). */
    mark?: 'askHappier';
    shortcut?: string;
    category?: string;
    action: () => void | Promise<void>;
}
