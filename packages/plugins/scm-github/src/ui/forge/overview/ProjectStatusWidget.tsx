import * as React from 'react';
import {
  ForgeCiOverviewGlance,
  useForgeCiQueryStatusV1,
  useForgeCiQueryV1,
  useForgeCiQueryValueV1,
} from '@happier-dev/forge-ci/ui';
import { readForgeCiSelectionRunV1 } from '@happier-dev/forge-ci/runtime';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import {
  Button,
  Icon,
  LoadingState,
  SurfaceState,
  Text,
  WidgetGlanceRow,
  usePluginHostApi,
  usePluginTranslation,
  useSurfaceContext,
} from '@happier-dev/plugin-ui';
import { formatTriageTimestampV1 } from '@happier-dev/triage-protocol/v1';
import { GITHUB_PLUGIN_ID } from '../../../observations/githubProviderContracts.js';
import { readGithubOverviewCiContextV1, type GithubOverviewCiContextResultV1 } from '../../actions/overviewContext.js';
import { useGithubCiBindingV1 } from '../../actions/useGithubCiBinding.js';
import { useGithubLatestReleaseV1 } from '../../releases/hooks.js';
import { GITHUB_ACTIONS_PAGE_ID_V1, GITHUB_RELEASES_PAGE_ID_V1 } from '../surfaceIds.js';

/**
 * The Project Overview's GitHub widget (lab a7): the default branch HEAD's workflows from this plugin's CI
 * Actions, resolved through the native default-branch read (never a Session's commit), opening a run in Actions.
 */
export function GithubProjectStatusWidget({
  context,
}: Readonly<{ context: RenderContext }>): React.ReactElement {
  const t = usePluginTranslation();
  const host = usePluginHostApi();
  const target = context.surface.target;
  const repository =
    target.kind === 'project' && target.repository?.kind === 'github'
      ? target.repository
      : null;
  const ci = useGithubCiBindingV1(repository, { signal: context.signal });
  const source = React.useMemo(() => ({ host, repository, signal: context.signal }),
    [host, context.signal, repository?.deployment, repository?.repository,
      context.surface.accountScope?.serverId, context.surface.accountScope?.accountId]);
  const [resolved, setResolved] = React.useState<Readonly<{
    source: typeof source;
    value: GithubOverviewCiContextResultV1;
  }> | null>(null);
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    if (!source.repository || source.signal.aborted) return;
    const controller = new AbortController();
    const retire = () => controller.abort();
    source.signal.addEventListener('abort', retire, { once: true });
    void readGithubOverviewCiContextV1(source.host, source.repository, {
      signal: controller.signal,
    }).then((result) => {
      if (!controller.signal.aborted) setResolved({ source, value: result });
    });
    return () => { source.signal.removeEventListener('abort', retire); controller.abort(); };
  }, [source, attempt]);
  const current = resolved?.source === source && !source.signal.aborted ? resolved.value : null;
  const ready = current?.context.kind === 'ready' ? current.context : null;
  const runsLease = useForgeCiQueryV1(
    ci.reads,
    'listRuns',
    ready ? ready.input : null,
  );
  const workflowsLease = useForgeCiQueryV1(
    ci.reads,
    'listWorkflows',
    repository ? { repository } : null,
  );
  const runs = useForgeCiQueryValueV1(runsLease);
  const workflows = useForgeCiQueryValueV1(workflowsLease);
  const status = useForgeCiQueryStatusV1(runsLease);
  const workflowNames = React.useMemo(
    () =>
      new Map(
        (workflows?.rows ?? []).map((workflow) => [workflow.id, workflow.name]),
      ),
    [workflows],
  );

  if (!repository) {
    return (
      <SurfaceState
        kind="unavailable"
        size="line"
        title={t(
          'plugins.github.overview.noRepository',
          'This Project’s repository isn’t on GitHub',
        )}
      />
    );
  }
  const unknownHead = current !== null && !ready && !current.failure;
  return (
    <ForgeCiOverviewGlance
      ci={ci}
      release={<GithubLatestReleaseGlance context={context} />}
      links={[
        {
          label: t('plugins.github.overview.actions', 'Actions'),
          onPress: () => { void host.openSurface({ pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_ACTIONS_PAGE_ID_V1 }); },
        },
        {
          label: t('plugins.github.overview.releases', 'Releases'),
          onPress: () => { void host.openSurface({ pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_RELEASES_PAGE_ID_V1 }); },
        },
      ]}
      unavailable={unknownHead ? (
        <SurfaceState kind="unavailable" size="line"
          title={t('plugins.github.overview.unknownHead', 'The default branch’s latest commit isn’t known yet')} />
      ) : null}
      branch={ready?.input.filters.branch ?? null}
      runs={ready ? (runs?.rows ?? null) : null}
      failure={current?.failure ?? status.snapshot?.failure ?? null}
      checkedAtMs={status.snapshot?.checkedAtMs ?? null}
      workflowNames={workflowNames}
      onRetry={() => {
        setAttempt((value) => value + 1);
        void status.refresh();
      }}
      onOpenRun={(selection) => {
        const run = readForgeCiSelectionRunV1(selection);
        const attemptId =
          selection.kind === 'attempt' ? selection.attempt.attemptId : '1';
        void host.openSurface(
          { pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_ACTIONS_PAGE_ID_V1 },
          undefined,
          { subPath: `runs/${run.runId}/attempts/${attemptId}` },
        );
      }}
    />
  );
}

/**
 * The widget's release half (lab a7): GitHub's own latest published release, read once through the Releases
 * binding (no list, no draft lookup), independent of whether the default branch HEAD is known.
 */
function GithubLatestReleaseGlance({ context }: Readonly<{ context: RenderContext }>): React.ReactElement {
  const t = usePluginTranslation();
  const host = usePluginHostApi();
  const { locale } = useSurfaceContext();
  const latest = useGithubLatestReleaseV1(context);
  const openReleases = (subPath: string) => {
    void host.openSurface({ pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_RELEASES_PAGE_ID_V1 }, undefined, { subPath });
  };
  const value = latest.value;
  if (value === undefined) {
    if (latest.status.failure) {
      return (
        <SurfaceState kind="error" size="line"
          title={t('plugins.github.overview.release.unavailable', 'The latest release couldn’t be read')}
          action={{ label: t('plugins.github.overview.release.retry', 'Try again'), onPress: latest.refresh }} />
      );
    }
    return <LoadingState title={t('plugins.github.overview.release.loading', 'Reading the latest release')} rows={1} layout="line" />;
  }
  const release = value.kind === 'value' ? value.value : null;
  if (release === null) {
    return (
      <WidgetGlanceRow
        mark={<Icon name="tag" size="small" tone="secondary" />}
        variant="fact"
        title={t('plugins.github.overview.release.none', 'No releases yet')}
        trailing={<Button variant="plain" size="small" title={t('plugins.github.overview.release.draft', 'Draft one')}
          onPress={() => openReleases('compose')} />}
      />
    );
  }
  const publishedMs = Date.parse(release.publishedAt ?? release.createdAt);
  const age = Number.isFinite(publishedMs) ? formatTriageTimestampV1(locale, publishedMs, 'relative', Date.now()) : null;
  const assets = release.assets.rows.length;
  const fact = [
    release.author ?? null,
    t('plugins.github.overview.release.assets', '{count} assets', { count: new Intl.NumberFormat(locale).format(assets) }),
  ].filter(Boolean).join(' · ');
  return (
    <WidgetGlanceRow
      mark={<Icon name="tag" size="small" tone="secondary" />}
      title={release.tagName}
      tag={t('plugins.github.releases.mark.latest', 'Latest')}
      fact={fact}
      trailing={age ? <Text variant="meta" tone="secondary" value={age} /> : null}
      onPress={() => openReleases(release.releaseId)}
    />
  );
}
