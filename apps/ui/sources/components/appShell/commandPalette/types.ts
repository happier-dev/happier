import type { IconName } from '@/components/ui/icons/Icon';
import type { ThemeMiniatureData } from '@/theme/profiles/themeProfileTypes';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';

/**
 * One admitted command produced by `buildCommandPaletteCommands`. It is the
 * catalog's output shape, not a presentation model: rows, matching, selection
 * and keyboard behavior belong to SelectionList.
 */
export interface Command {
    id: string;
    /** Commands already governed by an Action keep that Action's caller policy. */
    actionSpecId?: string;
    /** A command with an Action can supply its ordinary child invocation for automation. */
    invokeAction?: (context: ActionExecutorContext) => Promise<ActionExecuteResult>;
    /** Construction-owned semantic used by Search to avoid duplicate empty-state recents. */
    kind?: 'recentSession';
    /** Intentionally useful before the user has entered a Search query. */
    emptyQuerySuggested?: boolean;
    title: string;
    subtitle?: string;
    icon?: IconName;
    /**
     * A product mark drawn in place of `icon` by the Search surface (keeps the mark's art out of the catalog's eager
     * graph): Ask Happier's mark, or a theme's own miniature from its compact library header (⌘K Change theme).
     */
    mark?: 'askHappier' | Readonly<{ kind: 'theme'; miniature: ThemeMiniatureData }>;
    shortcut?: string;
    category?: string;
    /** Active-screen grouping used only before typing; query matching keeps ordinary categories. */
    contextCategory?: string;
    /** The shared SelectionList opens this group and acquires its commands on demand. */
    loadCommands?: () => Promise<readonly Command[]>;
    action: () => void | Promise<void>;
}
