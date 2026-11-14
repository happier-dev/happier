import * as React from 'react';
import type { DeploymentEnvironmentReadDetailV1 } from '@happier-dev/deployments';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { createDeploymentReadTransport, type DeploymentTargetLinkChoiceV1 } from './deploymentReadTransport';

type Target = DeploymentEnvironmentReadDetailV1['targetLinks'][number] & Readonly<{ title?: string }>;
type Choices = Readonly<{ scope: object; rows: readonly DeploymentTargetLinkChoiceV1[] }>
  & (Readonly<{ kind: 'loading' | 'ready' }> | Readonly<{ kind: 'failed'; code: string }>);

/** The preview chooser's body-read lifetime, shared by presented database surfaces. */
export function useDeploymentTargetLinkChoices(params: Readonly<{
  lifetime: ServerAccountScopeLifetime | null;
  environmentId: string;
  targets: readonly Target[];
  presented: boolean;
}>) {
  const { lifetime, environmentId, targets, presented } = params;
  const transport = React.useMemo(() => lifetime ? createDeploymentReadTransport(lifetime) : null, [lifetime]);
  const scope = React.useMemo(() => ({}), [lifetime, environmentId]);
  const provided = React.useMemo(() => targets.flatMap((row): DeploymentTargetLinkChoiceV1[] => row.content
    ? [{ targetLink: row.targetLink, title: row.title ?? '', content: row.content }] : []), [targets]);
  const missing = React.useMemo(() => targets.filter(row => !row.content).map(row => row.targetLink), [targets]);
  const [state, setState] = React.useState<Choices | null>(null);
  const [attempt, setAttempt] = React.useState(0);
  const retry = React.useCallback(() => setAttempt(value => value + 1), []);
  const choices: Choices = state?.scope === scope ? state
    : { scope, kind: missing.length === 0 ? 'ready' : 'loading', rows: provided };
  React.useEffect(() => {
    if (!presented) return;
    const controller = new AbortController();
    const retained = (previous: Choices | null) => {
      const rows = new Map(previous?.scope === scope ? previous.rows.map(row => [row.targetLink.id, row]) : []);
      for (const row of provided) rows.set(row.targetLink.id, row);
      return [...rows.values()];
    };
    if (missing.length === 0) {
      setState({ scope, kind: 'ready', rows: provided });
    } else if (!lifetime || !transport) {
      setState(previous => ({ scope, kind: 'failed', code: 'deployment_unavailable', rows: retained(previous) }));
    } else {
      setState(previous => ({ scope, kind: 'loading', rows: retained(previous) }));
      void transport.readTargetLinks(lifetime.scope, missing, { signal: controller.signal }).then(result => {
        if (controller.signal.aborted) return;
        setState(previous => result.ok ? { scope, kind: 'ready', rows: [...provided, ...result.value] }
          : { scope, kind: 'failed', code: result.failure.code, rows: retained(previous) });
      });
    }
    return () => controller.abort();
  }, [presented, lifetime, transport, scope, provided, missing, attempt]);
  return { choices, retry };
}
