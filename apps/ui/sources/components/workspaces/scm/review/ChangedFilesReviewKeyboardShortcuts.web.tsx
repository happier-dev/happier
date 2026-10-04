import * as React from 'react';

import { isEditableKeyboardTarget } from '@/components/ui/keyboard/isEditableKeyboardTarget';

import type { ChangedFilesReviewDiffStateSource } from './ChangedFilesReviewDiffStore';
import type { ChangedFilesReviewLineTarget } from './ChangedFilesReviewNavigation';
import { useReviewDiffHunkNavigation } from './useReviewDiffHunkNavigation';

export type ChangedFilesReviewKeyboardShortcutsProps = Readonly<{
    /** Only while the review is on screen and in front. */
    enabled: boolean;
    paths: readonly string[];
    activePath: string | null;
    onFocusPath: (path: string) => void;
    diffStateSource: ChangedFilesReviewDiffStateSource;
    onFocusLine: (target: ChangedFilesReviewLineTarget | null) => void;
}>;

/**
 * The comparison view's keys (Walkthrough lab WT8): J next file, K previous file, N next change in the
 * file Review is on. The same moves as Review's navigation buttons; never while typing or composing.
 */
export function ChangedFilesReviewKeyboardShortcuts(props: ChangedFilesReviewKeyboardShortcutsProps) {
    const activePath = props.activePath ?? props.paths[0] ?? null;
    const diffStateSource = props.diffStateSource;
    const state = React.useSyncExternalStore(
        React.useCallback((listener: () => void) => (activePath ? diffStateSource.subscribe(activePath, listener) : () => {}), [activePath, diffStateSource]),
        React.useCallback(() => (activePath ? diffStateSource.getDiffState(activePath) : null), [activePath, diffStateSource]),
        React.useCallback(() => (activePath ? diffStateSource.getDiffState(activePath) : null), [activePath, diffStateSource]),
    );
    const hunks = useReviewDiffHunkNavigation(state?.diff ?? '');
    const latest = React.useRef({ props, activePath, hunks });
    latest.current = { props, activePath, hunks };

    React.useEffect(() => {
        if (!props.enabled) return;
        const w = (globalThis as { window?: Window }).window;
        if (!w || typeof w.addEventListener !== 'function') return;
        const handler = (event: KeyboardEvent) => {
            if (event.defaultPrevented || event.isComposing === true) return;
            if (event.metaKey || event.ctrlKey || event.altKey) return;
            if (isEditableKeyboardTarget(event.target)) return;
            const current = latest.current;
            const paths = current.props.paths;
            const index = current.activePath ? paths.indexOf(current.activePath) : -1;
            const key = event.key.toLowerCase();
            if (key === 'j' || key === 'k') {
                const next = paths[key === 'j' ? index + 1 : Math.max(0, index - 1)];
                if (!next || next === current.activePath) return;
                event.preventDefault();
                current.props.onFocusPath(next);
                return;
            }
            if (key === 'n' && current.activePath) {
                const lineId = current.hunks.next();
                if (!lineId) return;
                event.preventDefault();
                current.props.onFocusLine({ filePath: current.activePath, lineId });
            }
        };
        w.addEventListener('keydown', handler);
        return () => w.removeEventListener('keydown', handler);
    }, [props.enabled]);

    return null;
}
