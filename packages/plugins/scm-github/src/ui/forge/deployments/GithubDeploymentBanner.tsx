import * as React from 'react';
import type { ForgeCiReadsV1 } from '@happier-dev/forge-ci/runtime';
import type { ScmHostingRepositoryIdentityV1 } from '@happier-dev/plugin-sdk/scm';
import { Banner, Button } from '@happier-dev/plugin-ui';
import type { ForgeCiRunV1 } from '@happier-dev/triage-protocol/ci/v1';
import { useGithubDeploymentBannerV1, type GithubDeploymentBannerEntryV1 } from '../../actions/useGithubDeploymentBanner.js';
import { GithubRunDeploymentReview } from './GithubRunDeploymentReview.js';

type Translate = (key: string, fallback: string, values?: Readonly<Record<string, string | number>>) => string;

/**
 * The Actions page's pending-environment banner (lab a2): it speaks only for deployments GitHub says the person may
 * answer in the presented run window, and Review opens the same review card in its place. A waiting run alone, or
 * a read that is still unknown, never draws it.
 */
export function GithubDeploymentBanner({
  reads,
  repository,
  runs,
  signal,
  translate,
}: Readonly<{
  reads: ForgeCiReadsV1 | null;
  repository: ScmHostingRepositoryIdentityV1;
  runs: readonly ForgeCiRunV1[];
  signal: AbortSignal;
  translate: Translate;
}>): React.ReactElement | null {
  const { entries } = useGithubDeploymentBannerV1({ reads, repository, runs, enabled: true, signal });
  const [reviewing, setReviewing] = React.useState<string | null>(null);
  const first = entries[0];
  if (first === undefined) return null;
  const open = entries.find((entry) => entry.run.ref.runId === reviewing);
  if (open !== undefined) {
    return (
      <GithubRunDeploymentReview
        reads={reads}
        repository={repository}
        run={open.run}
        context={runLine(open, translate)}
        onClose={() => setReviewing(null)}
      />
    );
  }
  const environments = [...new Set(entries.map((entry) => entry.approval.environment.name))];
  return (
    <Banner
      tone="warning"
      testID="github.actions.deploymentBanner"
      title={
        entries.length === 1
          ? translate('plugins.github.actions.deploymentBanner.one', 'A deployment is waiting for you')
          : translate('plugins.github.actions.deploymentBanner.many', '{count} deployments are waiting for you', {
              count: entries.length,
            })
      }
      description={
        entries.length === 1
          ? translate('plugins.github.actions.deploymentBanner.description', '{run} wants to deploy to {environment}', {
              run: runLine(first, translate),
              environment: first.approval.environment.name,
            })
          : translate('plugins.github.actions.deploymentBanner.descriptionMany', 'Waiting to deploy to {environments}', {
              environments: environments.join(', '),
            })
      }
      action={
        <Button
          variant="secondary"
          title={translate('plugins.github.actions.deploymentBanner.review', 'Review')}
          onPress={() => setReviewing(first.run.ref.runId)}
        />
      }
    />
  );
}

/** "forge-qa-deployment #1 on main": the run as the list names it. */
function runLine(entry: GithubDeploymentBannerEntryV1, translate: Translate): string {
  const { run } = entry;
  const name = [run.title, run.number === undefined ? null : `#${run.number}`].filter(Boolean).join(' ');
  const label = name === '' ? translate('plugins.github.actions.run', 'Workflow run') : name;
  return run.headRef === undefined
    ? label
    : translate('plugins.github.actions.deploymentBanner.runOnBranch', '{run} on {branch}', { run: label, branch: run.headRef });
}
