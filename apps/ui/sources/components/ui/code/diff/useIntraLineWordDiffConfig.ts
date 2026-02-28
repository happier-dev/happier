import * as React from 'react';

import { useSetting } from '@/sync/domains/state/storage';

export type IntraLineWordDiffConfig = Readonly<{
    enabled: boolean;
    maxLines: number;
    maxLineLength: number;
    maxPairs: number;
}>;

export function useIntraLineWordDiffConfig(): IntraLineWordDiffConfig {
    const enabled = useSetting('filesDiffIntraLineWordDiffEnabled') === true;
    const maxLines = useSetting('filesDiffIntraLineWordDiffMaxPatchLines') ?? 0;
    const maxPairs = useSetting('filesDiffIntraLineWordDiffMaxPairs') ?? 0;
    const maxLineLength = useSetting('filesDiffIntraLineWordDiffMaxLineLength') ?? 0;

    return React.useMemo(() => {
        return {
            enabled,
            maxLines,
            maxLineLength,
            maxPairs,
        };
    }, [enabled, maxLineLength, maxLines, maxPairs]);
}
