import { HAPPIER_COLLECTION_LIST_METRICS, HAPPIER_COLLECTION_LIST_TEXT } from '@happier-dev/plugin-ui/presentation';
import type { BuiltinAppShellColumnId } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { SESSION_LIST_COLUMN_METRICS } from '@/components/sessions/shell/sessionListColumnMetrics';

// Headers retain twelve average title glyphs beside their maximum current icon group.
function headerDemandPx(actionCount: number): number {
    return 2 * HAPPIER_COLLECTION_LIST_METRICS.contentInset
        + 12 * HAPPIER_COLLECTION_LIST_TEXT.title.fontSize / 2
        + actionCount * SESSION_LIST_COLUMN_METRICS.iconButtonSizePx
        + Math.max(0, actionCount - 1) * SESSION_LIST_COLUMN_METRICS.iconButtonGapPx;
}

/** Every built-in column declares its header demand alongside the shared row floor. */
export const BUILTIN_COLUMN_MINIMUM_WIDTH_PX = {
    sessions: headerDemandPx(3),
    discussions: headerDemandPx(2),
    projects: headerDemandPx(1),
    workflows: headerDemandPx(2),
    boards: headerDemandPx(1),
    plugins: headerDemandPx(1),
    settings: headerDemandPx(1),
    machines: headerDemandPx(2),
    services: headerDemandPx(2),
} satisfies Record<BuiltinAppShellColumnId, number>;
