import * as React from 'react';
import {
  ForgeCiStateNotice,
  readForgeOperationStateV1,
} from '@happier-dev/forge-ci/ui';
import type { ScmHostingRepositoryIdentityV1 } from '@happier-dev/plugin-sdk/scm';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import {
  Button,
  LoadingState,
  Metadata,
  ScrollArea,
  Stack,
  SurfaceState,
  Text,
  usePluginHostApi,
  usePluginTranslation,
  type MetadataEntry,
} from '@happier-dev/plugin-ui';
import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';
import {
  decodeGithubDeploymentReviewLocationV1,
  GITHUB_DEPLOYMENT_REVIEW_TARGET_ACTION_ID,
  GithubDeploymentReviewTargetResultV1Schema,
  type GithubDeploymentReviewLocationV1,
} from '../../../actions/deploymentReviewProtocol.js';
import { GITHUB_PLUGIN_ID } from '../../../observations/githubProviderContracts.js';
import { useGithubCiBindingV1 } from '../../actions/useGithubCiBinding.js';
import { useGithubDeploymentReviewV1 } from '../../actions/useGithubDeploymentReview.js';
import { GithubDeploymentReviewForm } from './GithubDeploymentReviewForm.js';

const TARGET_READ = { pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_DEPLOYMENT_REVIEW_TARGET_ACTION_ID } as const;

type Target =
  | Readonly<{ kind: 'loading' }>
  | Readonly<{
      kind: 'ready';
      repository: ScmHostingRepositoryIdentityV1;
      location: GithubDeploymentReviewLocationV1;
    }>
  | Readonly<{ kind: 'unavailable'; failure: TriageSourceFailureV1 | null }>;

/**
 * The deployment review page (lab b3), opened from a deployment notice, Inbox or the Actions banner. The locator
 * names a run, attempt and environment but grants nothing: the page admits its repository through the safe
 * target read, then the shared review hook re-reads the current attempt and eligibility before any decision.
 */
export function GithubDeploymentReviewPage({
  context,
}: Readonly<{ context: RenderContext }>): React.ReactElement {
  const t = usePluginTranslation();
  const host = usePluginHostApi();
  const subPath = context.subPath ?? '';
  const location = React.useMemo(
    () => decodeGithubDeploymentReviewLocationV1(subPath),
    [subPath],
  );
  const [target, setTarget] = React.useState<Target>({ kind: 'loading' });
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    if (location === null) return;
    const controller = new AbortController();
    const retire = () => {
      controller.abort();
      setTarget({ kind: 'unavailable', failure: null });
    };
    context.signal.addEventListener('abort', retire, { once: true });
    if (context.signal.aborted) {
      retire();
      return () => context.signal.removeEventListener('abort', retire);
    }
    setTarget({ kind: 'loading' });
    void host
      .executeAction(
        TARGET_READ,
        { location: subPath },
        { signal: controller.signal },
      )
      .then(
        (value) => {
          if (controller.signal.aborted) return;
          const parsed =
            GithubDeploymentReviewTargetResultV1Schema.safeParse(value);
          setTarget(
            !parsed.success
              ? { kind: 'unavailable', failure: null }
              : parsed.data.kind === 'ready'
                ? {
                    kind: 'ready',
                    repository: parsed.data.repository,
                    location: parsed.data.location,
                  }
                : { kind: 'unavailable', failure: parsed.data.failure },
          );
        },
        () => {
          if (!controller.signal.aborted)
            setTarget({ kind: 'unavailable', failure: null });
        },
      );
    return () => {
      context.signal.removeEventListener('abort', retire);
      controller.abort();
    };
  }, [host, location, subPath, attempt, context.signal]);

  if (location === null) {
    return (
      <SurfaceState
        kind="unavailable"
        title={t(
          'plugins.github.deploymentReview.invalid',
          'This review link isn’t complete',
        )}
        description={t(
          'plugins.github.deploymentReview.invalid.description',
          'Open the review again from its notice or from the run on the Actions page.',
        )}
      />
    );
  }
  if (target.kind === 'loading')
    return (
      <LoadingState
        title={t(
          'plugins.github.deploymentReview.loading',
          'Opening the review…',
        )}
      />
    );
  if (target.kind === 'unavailable') {
    return target.failure === null ? (
      <SurfaceState
        kind="error"
        title={t(
          'plugins.github.deploymentReview.unreadable',
          'This review couldn’t be opened',
        )}
        description={t(
          'plugins.github.deploymentReview.unreadable.description',
          'Nothing was approved or rejected.',
        )}
        action={{
          label: t('plugins.github.deploymentReview.retry', 'Try again'),
          onPress: () => setAttempt((value) => value + 1),
        }}
      />
    ) : (
      <ForgeCiStateNotice
        presentation="surface"
        state={readForgeOperationStateV1({
          failure: target.failure,
          hasRetainedValue: false,
        })}
        about={{
          forgeName: 'GitHub',
          subject: t(
            'plugins.github.deploymentReview.subject',
            'this deployment',
          ),
        }}
        onRetry={() => setAttempt((value) => value + 1)}
      />
    );
  }
  return (
    <ReviewBody repository={target.repository} location={target.location} signal={context.signal} />
  );
}

function ReviewBody({
  repository,
  location,
  signal,
}: Readonly<{
  repository: ScmHostingRepositoryIdentityV1;
  location: GithubDeploymentReviewLocationV1;
  signal: AbortSignal;
}>): React.ReactElement {
  const t = usePluginTranslation();
  const host = usePluginHostApi();
  const ci = useGithubCiBindingV1(repository, { signal });
  const review = useGithubDeploymentReviewV1({
    reads: ci.reads,
    repository,
    location,
  });
  const about = {
    forgeName: 'GitHub',
    subject: t('plugins.github.deploymentReview.subject', 'this deployment'),
  };
  const failure =
    review.runStatus.snapshot?.failure ??
    review.pendingStatus.snapshot?.failure ??
    null;
  const loaded = review.run !== null && review.pending !== null;
  if (!loaded && failure === null)
    return (
      <LoadingState
        title={t(
          'plugins.github.deploymentReview.loading',
          'Opening the review…',
        )}
      />
    );
  if (!loaded && failure !== null) {
    return (
      <ForgeCiStateNotice
        presentation="surface"
        about={about}
        state={readForgeOperationStateV1({ failure, hasRetainedValue: false })}
        onRetry={() =>
          Promise.all([
            review.runStatus.refresh(),
            review.pendingStatus.refresh(),
          ])
        }
      />
    );
  }
  const run = review.run;
  const approval = review.selected;
  const environmentName = approval?.environment.name ?? null;
  const runUrl = run?.webUrl ?? null;
  const entries: MetadataEntry[] = [
    ...(environmentName === null
      ? []
      : [
          {
            label: t(
              'plugins.github.deploymentReview.environment',
              'Environment',
            ),
            value: environmentName,
          },
        ]),
    ...(run?.headSha === undefined
      ? []
      : [
          {
            label: t('plugins.github.deploymentReview.commit', 'Commit'),
            value: [run.headSha.slice(0, 7), run.headRef]
              .filter(Boolean)
              .join(' · '),
          },
        ]),
    ...(approval?.reviewers === undefined || approval.reviewers.length === 0
      ? []
      : [
          {
            label: t(
              'plugins.github.deploymentReview.reviewers',
              'Who can approve',
            ),
            value: approval.reviewers.join(', '),
          },
        ]),
    ...(approval?.waitUntilMs === undefined
      ? []
      : [
          {
            label: t(
              'plugins.github.deploymentReview.waitUntil',
              'Waits until',
            ),
            value: new Intl.DateTimeFormat(undefined, {
              dateStyle: 'medium',
              timeStyle: 'short',
            }).format(new Date(approval.waitUntilMs)),
          },
        ]),
  ];
  const openRun =
    runUrl === null
      ? undefined
      : {
          label: t(
            'plugins.github.deploymentReview.viewRun',
            'View run on GitHub',
          ),
          onPress: () => {
            void host.openExternalLink(runUrl);
          },
        };
  return (
    <ScrollArea>
      <Stack gap="large">
        <Stack gap="xsmall">
          <Text
            variant="meta"
            tone="secondary"
            value={[
              repository.repository,
              run?.number === undefined ? null : `#${run.number}`,
            ]
              .filter(Boolean)
              .join(' · ')}
          />
          <Text
            variant="title"
            value={
              environmentName === null
                ? t(
                    'plugins.github.deploymentReview.title.generic',
                    'Deployment review',
                  )
                : t(
                    'plugins.github.deploymentReview.title',
                    'Deploy to {environment}',
                    { environment: environmentName },
                  )
            }
          />
          {run?.title === undefined ? null : (
            <Text tone="secondary" value={run.title} />
          )}
        </Stack>
        {failure !== null ? (
          <ForgeCiStateNotice
            presentation="line"
            about={about}
            state={readForgeOperationStateV1({
              failure,
              hasRetainedValue: true,
            })}
            asOfMs={review.pendingStatus.snapshot?.checkedAtMs ?? null}
            onRetry={() =>
              Promise.all([
                review.runStatus.refresh(),
                review.pendingStatus.refresh(),
              ])
            }
          />
        ) : null}
        {entries.length === 0 ? null : <Metadata entries={entries} />}
        {review.stale ? (
          <SurfaceState
            kind="unavailable"
            size="line"
            title={t(
              'plugins.github.deploymentReview.stale',
              'A newer attempt replaced this run',
            )}
            description={t(
              'plugins.github.deploymentReview.stale.description',
              'Review the current attempt from the run on GitHub or the Actions page.',
            )}
            {...(openRun === undefined ? {} : { action: openRun })}
          />
        ) : approval === null ? (
          <SurfaceState
            kind="success"
            size="line"
            title={t(
              'plugins.github.deploymentReview.resolved',
              'This deployment no longer waits for a review',
            )}
            description={t(
              'plugins.github.deploymentReview.resolved.description',
              'Someone already answered it, or the run moved on.',
            )}
            {...(openRun === undefined ? {} : { action: openRun })}
          />
        ) : !approval.eligible ? (
          <SurfaceState
            kind="denied"
            size="line"
            title={t(
              'plugins.github.deploymentReview.notEligible',
              'You can’t approve this environment',
            )}
            description={t(
              'plugins.github.deploymentReview.notEligible.description',
              'GitHub lets only its named reviewers answer it.',
            )}
            {...(openRun === undefined ? {} : { action: openRun })}
          />
        ) : (
          <GithubDeploymentReviewForm
            review={review}
            testID="github.deploymentReview.form"
          />
        )}
        {openRun === undefined ||
        approval === null ||
        review.stale ||
        !approval.eligible ? null : (
          <Button
            variant="plain"
            title={openRun.label}
            onPress={openRun.onPress}
          />
        )}
      </Stack>
    </ScrollArea>
  );
}
