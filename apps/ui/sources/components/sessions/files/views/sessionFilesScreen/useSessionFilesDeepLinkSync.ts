import * as React from 'react';

import type { ChangedFilesPresentation } from '@/scm/scmAttribution';

function readSearchParam(params: unknown, key: string): unknown {
    if (!params || typeof params !== 'object') return undefined;
    return (params as Record<string, unknown>)[key];
}

export function useSessionFilesDeepLinkSync(input: Readonly<{
    localSearchParams: unknown;
    setChangedFilesPresentation: React.Dispatch<React.SetStateAction<ChangedFilesPresentation>>;
    setShowAllRepositoryFiles: React.Dispatch<React.SetStateAction<boolean>>;
    setReviewFocusPath: React.Dispatch<React.SetStateAction<string | null>>;
}>): void {
    const deepLinkPresentation = React.useMemo(() => {
        const raw = readSearchParam(input.localSearchParams, 'presentation');
        if (raw === 'review') return 'review';
        if (raw === 'list') return 'list';
        return null;
    }, [input.localSearchParams]);
    const deepLinkFocusPath = React.useMemo(() => {
        const raw = readSearchParam(input.localSearchParams, 'focusPath');
        return typeof raw === 'string' && raw.trim() ? raw : null;
    }, [input.localSearchParams]);

    const deepLinkAppliedRef = React.useRef(false);
    React.useEffect(() => {
        if (deepLinkAppliedRef.current) return;
        if (!deepLinkPresentation && !deepLinkFocusPath) return;
        deepLinkAppliedRef.current = true;

        if (deepLinkPresentation) {
            input.setChangedFilesPresentation(deepLinkPresentation);
            // Focus paths only make sense in changed-files mode.
            input.setShowAllRepositoryFiles(false);
        }
        if (deepLinkFocusPath) {
            input.setReviewFocusPath(deepLinkFocusPath);
            input.setShowAllRepositoryFiles(false);
        }
    }, [deepLinkFocusPath, deepLinkPresentation, input]);
}
