import * as React from 'react';
import type { ScmComparison } from '@happier-dev/protocol/scm/comparison';

export type CapturedFileByPath = ReadonlyMap<string, ScmComparison['inventory']['files'][number]>;

/** Review and File Changes share the captured evidence lookup, built once per inventory. */
export function useCapturedFileByPath(captured: ScmComparison | null, shared?: CapturedFileByPath | null): CapturedFileByPath | null {
    return React.useMemo(() => shared ?? (captured ? new Map(captured.inventory.files.map(file => [file.path, file])) : null),
        [captured?.inventory.files, shared]);
}
