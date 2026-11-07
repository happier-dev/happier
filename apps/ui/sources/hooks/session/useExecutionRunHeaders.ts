import * as React from 'react';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { createExecutionRunHeaderDemand, type ExecutionRunHeaderReference } from '@/sync/runtime/executionRuns/executionRunHeaderReads';

/** Renderers retain interest; only current, presented consumers demand acquisition. */
export function useExecutionRunHeaders(lifetime: ServerAccountScopeLifetime | null, references: readonly ExecutionRunHeaderReference[]) {
    const [revision, changed] = React.useReducer(value => value + 1, 0);
    const owner = React.useMemo(() => lifetime ? createExecutionRunHeaderDemand(lifetime, changed) : null, [lifetime]);
    const latest = React.useRef(references);
    latest.current = references;
    const key = React.useMemo(() => JSON.stringify(references), [references]);
    React.useEffect(() => { owner?.update(latest.current); }, [owner, key]);
    React.useEffect(() => () => owner?.dispose(), [owner]);
    return React.useMemo(() => ({ owner, revision }), [owner, revision]);
}
