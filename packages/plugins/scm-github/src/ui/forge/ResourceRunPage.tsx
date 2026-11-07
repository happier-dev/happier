import * as React from 'react';
import { normalizeScmHostingRepositoryIdentity } from '@happier-dev/plugin-sdk/scm';
import { PluginUiResourceIntentV1Schema } from '@happier-dev/plugin-sdk/protocol';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import { ForgeCiRunDetailView, useForgeCiMountedViewV1, useForgeCiMountedViewStateV1, useForgeCiQueryV1, useForgeCiQueryValueV1, useForgeCiQueryStatusV1 } from '@happier-dev/forge-ci/ui';
import type { ForgeCiSelectionV1 } from '@happier-dev/triage-protocol/ci/v1';
import { Banner, Button, Stack, SurfaceState, usePluginHostApi, usePluginTranslation, useSurfaceContext } from '@happier-dev/plugin-ui';
import { usePluginUiEphemeralSharedScope } from '@happier-dev/plugin-ui/hostApi';
import { bindGithubCiMountedViewV1 } from '../../actions/mounted.js';
import { parseGithubResourceUrl } from '../../triage/locator.js';
import { useGithubCiBindingV1 } from '../actions/useGithubCiBinding.js';
import { useGithubCiFixV1 } from '../actions/useGithubCiFix.js';
import { GithubRunDeploymentReview } from './deployments/GithubRunDeploymentReview.js';
import { GITHUB_PLUGIN_ID } from '../../observations/githubProviderContracts.js';
import { GITHUB_RESOURCE_RUN_PAGE_ID_V1 } from './surfaceIds.js';

function readResource(context: RenderContext) {
  const launch = context.launchInput;
  let resource: unknown = launch !== null && typeof launch === 'object' && 'resource' in launch ? launch.resource : undefined;
  if (launch === undefined || launch === null) {
    const path = context.subPath ?? '';
    if (path.startsWith('run/')) {
      try { resource = { kind: 'ciRun', url: decodeURIComponent(path.slice(4)) }; } catch { return null; }
    } else if (context.surface.mount.kind === 'destination' && context.surface.mount.instanceKey !== undefined) {
      resource = { kind: 'ciRun', url: context.surface.mount.instanceKey };
    }
  }
  const parsed = PluginUiResourceIntentV1Schema.safeParse(resource);
  if (!parsed.success || parsed.data.kind !== 'ciRun') return null;
  const route = parseGithubResourceUrl(parsed.data);
  if (route === null) return null;
  const repository = normalizeScmHostingRepositoryIdentity({ kind: 'github', deployment: 'https://github.com', repository: `${route.owner}/${route.name}` });
  if (repository === null) return null;
  const selection: ForgeCiSelectionV1 = { kind: 'run', run: { v: 1, repository, runId: route.number } };
  return { resource: parsed.data, selection };
}

/** A run URL supplies routing only; the ordinary CI Action binding owns credentials and reads. */
export function GithubResourceRunPage({ context }: Readonly<{ context: RenderContext }>): React.ReactElement {
  const t = usePluginTranslation();
  const host = usePluginHostApi();
  const mount = context.surface.mount;
  const instanceKey = mount.kind === 'destination' ? mount.instanceKey : undefined;
  const target = React.useMemo(() => readResource(context), [context.launchInput, context.subPath, instanceKey]);
  const [locationFailed, setLocationFailed] = React.useState(false);
  const url = target?.resource.url;
  const appPage = mount.kind === 'destination' && mount.container === 'appPage';
  React.useEffect(() => {
    if (!appPage || url === undefined) return;
    const subPath = `run/${encodeURIComponent(url)}`;
    if (context.subPath === subPath) return;
    let active = true;
    void host.replacePageLocation(subPath, { signal: context.signal }).then(
      settled => { if (active && !context.signal.aborted) setLocationFailed(settled.subPath !== subPath); },
      () => { if (active && !context.signal.aborted) setLocationFailed(true); },
    );
    return () => { active = false; };
  }, [appPage, url, context.subPath, context.signal, host]);
  if (target === null) return <SurfaceState kind="unavailable"
    title={t('plugins.github.resourceRun.invalid', 'This run link couldn’t be opened')}
    description={t('plugins.github.resourceRun.invalid.description', 'Open the run again from its GitHub link.')} />;
  return <Stack gap="none">
    {locationFailed ? <Banner tone="warning" title={t('plugins.github.resourceRun.locationFailed', 'This run won’t be restored after reloading')} /> : null}
    <ResourceRunDetail key={target.resource.url} context={context} selection={target.selection} url={target.resource.url} appPage={appPage} />
  </Stack>;
}

function ResourceRunDetail({ context, selection, url, appPage }: Readonly<{ context: RenderContext; selection: ForgeCiSelectionV1; url: string; appPage: boolean }>): React.ReactElement {
  const surface = useSurfaceContext();
  const host = usePluginHostApi();
  const t = usePluginTranslation();
  const run = selection.kind === 'run' ? selection.run : selection.attempt.run;
  const fix = useGithubCiFixV1({ signal: context.signal });
  const ci = useGithubCiBindingV1(run.repository, { signal: context.signal, fix });
  // The native detail and fallback subscribe to the same leased read; opening a URL never lists runs.
  const runQuery = useForgeCiQueryV1(ci.reads, 'readRun', { repository: run.repository, runId: run.runId });
  const loadedRun = useForgeCiQueryValueV1(runQuery);
  const runStatus = useForgeCiQueryStatusV1(runQuery);
  const view = useForgeCiMountedViewV1({
    mountId: surface.mountId,
    signal: context.signal,
    initialState: { selection },
    canApply: operation => !['selectView', 'selectWorkflow', 'setFilters', 'setRunScope', 'setQuery', 'setTriggerRef', 'setTriggerDraft'].includes(operation.kind)
      && !(operation.kind === 'setJobsView' && operation.view === 'graph'),
    phone: surface.platform === 'ios' || surface.platform === 'android',
  });
  const scope = usePluginUiEphemeralSharedScope();
  React.useEffect(() => (scope && view ? bindGithubCiMountedViewV1(scope, view, context.signal) : undefined), [scope, view, context.signal]);
  const state = useForgeCiMountedViewStateV1(view);
  return <Stack gap="none">
    {loadedRun === null && runStatus.snapshot?.failure ? <Button title={t('plugins.github.resourceRun.onGithub', 'On GitHub')} variant="secondary"
      onPress={() => host.openExternalLink(url, { signal: context.signal })} /> : null}
    <ForgeCiRunDetailView ci={ci} selection={state?.selection ?? selection} view={view}
    {...(appPage ? { presentation: 'page' as const,
      pageKind: { pluginId: GITHUB_PLUGIN_ID, localId: `${GITHUB_RESOURCE_RUN_PAGE_ID_V1}/run` } }
      : { presentation: 'pane' as const })}
    selectedJobId={state?.job?.jobId ?? null}
    onOpenJob={job => { void view?.invoke({ mountId: view.mountId, operation: { kind: 'selectJob', job } }); }}
    onOpenSummary={() => view?.openSummary()}
    deploymentReview={value => <GithubRunDeploymentReview reads={ci.reads} repository={run.repository} run={value} />} />
  </Stack>;
}
