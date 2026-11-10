import * as React from 'react';
import { ProjectReadinessReadResultV1Schema, type ProjectReadinessReadInputV1,
  type ProjectReadinessReadResultV1 } from '@happier-dev/protocol/projects/readinessV1';
import { readActionErrorCodeV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { createFrontDoorActionExecute, requireActionSuccess } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

const execute = createFrontDoorActionExecute();
type Read = Readonly<{ input: ProjectReadinessReadInputV1; lifetime: ServerAccountScopeLifetime;
  result: ProjectReadinessReadResultV1 | null; pending: boolean; failureCode: string | null }>;

/** Presentation request lifetime; all readiness decisions stay with projects.readiness.read. */
export function useProjectReadiness(lifetime: ServerAccountScopeLifetime | null,
  input: ProjectReadinessReadInputV1 | null, visible: boolean) {
  const [read, setRead] = React.useState<Read | null>(null);
  const active = React.useRef<AbortController | null>(null);
  React.useEffect(() => {
    const retirement = lifetime?.onRetire(() => { active.current?.abort(); setRead(null); });
    return () => { retirement?.dispose(); active.current?.abort(); };
  }, [lifetime]);
  const refresh = React.useCallback(async () => {
    if (!visible || !input || !lifetime?.isCurrent()) return;
    active.current?.abort();
    const operation = new AbortController();
    active.current = operation;
    setRead(previous => ({ input, lifetime, pending: true, failureCode: null,
      result: previous?.input === input && previous.lifetime === lifetime ? previous.result : null }));
    try {
      const outcome = await execute('projects.readiness.read', input, { surface: 'ui',
        serverId: lifetime.scope.serverId, expectedAccountId: lifetime.scope.accountId, signal: operation.signal });
      requireActionSuccess(outcome, 'projects.readiness.read');
      const result = ProjectReadinessReadResultV1Schema.parse(outcome.result);
      if (!operation.signal.aborted && lifetime.isCurrent()) setRead({ input, lifetime, result, pending: false, failureCode: null });
    } catch (error) {
      if (!operation.signal.aborted && lifetime.isCurrent()) setRead(previous => ({ input, lifetime, pending: false,
        failureCode: readActionErrorCodeV1(error) ?? 'unknown_error',
        result: previous?.input === input && previous.lifetime === lifetime ? previous.result : null }));
    } finally { if (active.current === operation) active.current = null; }
  }, [lifetime, input, visible]);
  React.useEffect(() => { void refresh(); return () => { active.current?.abort(); }; }, [refresh]);
  const current = visible && lifetime?.isCurrent() && read?.input === input && read?.lifetime === lifetime ? read : null;
  return { result: current?.result ?? null, pending: current?.pending ?? false, failureCode: current?.failureCode ?? null, refresh };
}
