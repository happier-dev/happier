import * as React from 'react';

import type { ScmDiffArea } from '@happier-dev/protocol';

import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { sessionScmDiffFile } from '@/sync/ops';

type DiffState = {
    status: 'idle' | 'loading' | 'loaded' | 'error';
    diff: string;
    error: string | null;
};

function initialDiffState(): DiffState {
    return { status: 'idle', diff: '', error: null };
}

export function useChangedFilesReviewDiffLoading(input: {
    sessionId: string;
    isRepo: boolean;
    reviewFiles: readonly ScmFileStatus[];
    diffArea: ScmDiffArea;
    tooLarge: boolean;
    selectedPath: string;
    normalizeError: (input: unknown) => string;
    fallbackError: string;
}) {
    const { sessionId, isRepo, reviewFiles, diffArea, tooLarge, selectedPath, normalizeError, fallbackError } = input;

    const [diffStateByPath, setDiffStateByPath] = React.useState<Record<string, DiffState>>({});

    React.useEffect(() => {
        setDiffStateByPath({});
    }, [diffArea, sessionId]);

    React.useEffect(() => {
        if (!sessionId) return;
        if (!isRepo) return;
        if (reviewFiles.length === 0) return;

        let cancelled = false;

        const loadDiff = async (path: string) => {
            setDiffStateByPath((prev) => ({ ...prev, [path]: { status: 'loading', diff: '', error: null } }));
            try {
                const response = await sessionScmDiffFile(sessionId, { path, area: diffArea });
                if (cancelled) return;
                if (!response.success) {
                    const rawError = typeof response.error === 'string' ? response.error : '';
                    const normalized = rawError.trim() ? normalizeError(rawError) : '';
                    setDiffStateByPath((prev) => ({
                        ...prev,
                        [path]: {
                            status: 'error',
                            diff: '',
                            error: (typeof normalized === 'string' && normalized.trim()) ? normalized : fallbackError,
                        },
                    }));
                    return;
                }
                setDiffStateByPath((prev) => ({
                    ...prev,
                    [path]: { status: 'loaded', diff: response.diff ?? '', error: null },
                }));
            } catch (err) {
                if (cancelled) return;
                const normalized = normalizeError(err);
                setDiffStateByPath((prev) => ({
                    ...prev,
                    [path]: {
                        status: 'error',
                        diff: '',
                        error: (typeof normalized === 'string' && normalized.trim()) ? normalized : fallbackError,
                    },
                }));
            }
        };

        const run = async () => {
            if (tooLarge) {
                const path = selectedPath || reviewFiles[0]!.fullPath;
                if (!path) return;
                await loadDiff(path);
                return;
            }

            for (const file of reviewFiles) {
                if (cancelled) return;
                await loadDiff(file.fullPath);
            }
        };

        run();
        return () => {
            cancelled = true;
        };
    }, [diffArea, fallbackError, isRepo, normalizeError, reviewFiles, selectedPath, sessionId, tooLarge]);

    const getDiffState = React.useCallback((path: string) => diffStateByPath[path] ?? initialDiffState(), [diffStateByPath]);

    return {
        diffStateByPath,
        getDiffState,
    };
}
