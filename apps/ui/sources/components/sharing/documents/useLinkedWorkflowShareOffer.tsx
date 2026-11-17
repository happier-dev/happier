import * as React from 'react';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import { parseWorkflowDefinitionRefV1 } from '@happier-dev/protocol/workflows/workflowDefinitionRefV1';

import { useWorkflowReferenceTitles } from '@/components/workflows/presentation/workflowReferenceOptions';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { t } from '@/text';
import { sharePrincipalKey } from '../sharePrincipalPresentation';
import type { ShareGrantRowModel, ShareUiError } from '../shareSheetTypes';
import { useDocumentShareController } from './useDocumentShareController';

type LinkedWorkflowsRead = NonNullable<
  ReturnType<typeof useDocumentShareController>['linkedWorkflows']
>;
type Outcome =
  | Readonly<{ kind: 'shared' }>
  | Readonly<{ kind: 'error'; error: ShareUiError }>;
type Runs = Readonly<{
  audienceKey: string;
  active: string | null;
  outcomes: Readonly<Record<string, Outcome>>;
}>;

/** One linked Workflow the profile's new recipients cannot use yet, as the share sheet offers it. */
export type DocumentLinkedWorkflowChoice = Readonly<{
  ref: string;
  title: string;
  sharing: boolean;
  shared: boolean;
  issue?: ShareUiError;
  /** Absent while another Workflow is being shared or once this one is shared. */
  share?: () => void;
}>;

export type DocumentLinkedWorkflowOffer = Readonly<{
  audienceLabel: string;
  choices: readonly DocumentLinkedWorkflowChoice[];
  failed: boolean;
  retry(): void;
  loadMore?: () => void;
  dismiss(): void;
}>;

const NO_AUDIENCE: readonly PrincipalRefV1[] = [];
const NO_REFS: readonly string[] = [];

/**
 * Shares one Workflow with the reviewed audience through that Workflow's own grant owner: the owner
 * decides who is still missing and grants only them "Can use", so an existing higher grant never drops.
 */
function LinkedWorkflowShareRun(
  props: Readonly<{
    scope: ServerAccountScope;
    artifactId: string;
    audience: readonly PrincipalRefV1[];
    onSettled(outcome: Outcome): void;
  }>,
): null {
  const review = useDocumentShareController({
    scope: props.scope,
    artifactId: props.artifactId,
    kind: 'workflow-definition.v1',
    requestedAudience: props.audience,
  });
  const settled = React.useRef(props.onSettled);
  settled.current = props.onSettled;
  const started = React.useRef(false);
  const { missingAudience, shareMissingAudience, issue, loading } = review;
  React.useEffect(() => {
    if (started.current) return;
    if (missingAudience !== undefined) {
      started.current = true;
      void shareMissingAudience().then((result) =>
        settled.current(
          result.ok
            ? { kind: 'shared' }
            : { kind: 'error', error: result.error },
        ),
      );
    } else if (issue && !loading) {
      started.current = true;
      settled.current({ kind: 'error', error: issue });
    }
  }, [missingAudience, shareMissingAudience, issue, loading]);
  return null;
}

/**
 * After a profile is shared, the sharer's own Workflows linked to it are offered to the same new
 * recipients. Each Share is the person's explicit choice for that Workflow; Not now changes nothing.
 * The profile controller supplies the rows and audience; this only presents them and runs one share at a time.
 */
export function useLinkedWorkflowShareOffer(
  input: Readonly<{
    scope: ServerAccountScope;
    linked: LinkedWorkflowsRead | undefined;
    grants: readonly ShareGrantRowModel[];
  }>,
): Readonly<{
  offer: DocumentLinkedWorkflowOffer | null;
  run: React.ReactElement | null;
}> {
  const { scope, linked, grants } = input;
  const audience = linked?.audience ?? NO_AUDIENCE;
  const audienceKey = React.useMemo(
    () => JSON.stringify(audience.map(sharePrincipalKey)),
    [audience],
  );
  const refs = React.useMemo(
    () => linked?.rows.map((row) => row.ref) ?? NO_REFS,
    [linked?.rows],
  );
  const offered =
    linked !== undefined &&
    audience.length > 0 &&
    (refs.length > 0 || linked.status === 'failed');
  const { binding } = useServerCredentialAccountScopeBinding(
    offered ? scope.serverId : '',
  );
  const titleOf = useWorkflowReferenceTitles(
    refs,
    offered && refs.length > 0,
    binding?.scope.accountId === scope.accountId ? binding : null,
  );
  const [runs, setRuns] = React.useState<Runs>({
    audienceKey,
    active: null,
    outcomes: {},
  });
  const current: Runs =
    runs.audienceKey === audienceKey
      ? runs
      : { audienceKey, active: null, outcomes: {} };

  const share = React.useCallback(
    (ref: string) =>
      setRuns((previous) => {
        const base =
          previous.audienceKey === audienceKey
            ? previous
            : { audienceKey, active: null, outcomes: {} };
        if (base.active !== null) return base;
        const { [ref]: _retried, ...outcomes } = base.outcomes;
        return { audienceKey, active: ref, outcomes };
      }),
    [audienceKey],
  );
  const settle = React.useCallback(
    (ref: string, outcome: Outcome) =>
      setRuns((previous) =>
        previous.audienceKey !== audienceKey
          ? previous
          : {
              audienceKey,
              active: previous.active === ref ? null : previous.active,
              outcomes: { ...previous.outcomes, [ref]: outcome },
            },
      ),
    [audienceKey],
  );

  const audienceLabel = audience
    .map(
      (principal) =>
        grants.find((row) => row.principal.key === sharePrincipalKey(principal))
          ?.principal.displayName,
    )
    .filter((name): name is string => Boolean(name))
    .join(', ');
  const offer = React.useMemo<DocumentLinkedWorkflowOffer | null>(
    () =>
      !offered || !linked
        ? null
        : {
            audienceLabel,
            choices: refs.map((ref) => {
              const outcome = current.outcomes[ref];
              const sharing = current.active === ref;
              const shared = outcome?.kind === 'shared';
              return {
                ref,
                title: titleOf(ref) ?? t('workflowActivityView.untitled'),
                sharing,
                shared,
                ...(outcome?.kind === 'error' ? { issue: outcome.error } : {}),
                ...(!shared && current.active === null
                  ? { share: () => share(ref) }
                  : {}),
              };
            }),
            failed: linked.status === 'failed',
            retry: linked.retry,
            ...(linked.nextCursor ? { loadMore: linked.loadMore } : {}),
            dismiss: linked.dismiss,
          },
    [
      offered,
      linked,
      audienceLabel,
      refs,
      current.outcomes,
      current.active,
      titleOf,
      share,
    ],
  );

  const active = offered ? current.active : null;
  const workflow = active ? parseWorkflowDefinitionRefV1(active) : null;
  const run =
    active && workflow?.kind === 'artifact' ? (
      <LinkedWorkflowShareRun
        key={`${audienceKey}:${active}`}
        scope={scope}
        artifactId={workflow.artifactId}
        audience={audience}
        onSettled={(outcome) => settle(active, outcome)}
      />
    ) : null;
  return { offer, run };
}
