import * as React from 'react';
import type { DeploymentEnvironmentReadCollectionV1 } from '@happier-dev/deployments';
import {
  applyDeploymentPreviewHeadV1,
  buildDeploymentPreviewEnvironmentQueryV1,
  isOwnServerPreviewTargetV1,
  projectDeploymentPreviewStateV1,
  selectCurrentPreviewEnvironmentsV1,
} from '@happier-dev/plugin-sdk/protocol';
import { PullRequestPreviewSection, type PluginTranslate } from '@happier-dev/plugin-ui';
import { useLivePluginResourceProjection, type PluginUiResourceProjection } from '@happier-dev/plugin-ui/hostApi';

import type { TriageListDisplayRowV1 } from '../marks/pinnedRows.js';
import type { TriageListItemV1 } from './sections.js';

type PreviewKey = NonNullable<TriageListDisplayRowV1['preview']>;
type Repository = PreviewKey['repository'];
const repositoryKey = ({ kind, deployment, repository }: Repository) => JSON.stringify([kind, deployment, repository]);

/** Only address changes invalidate the page's read demand. Head changes update their own row. */
export function sameTriagePreviewAddressV1(left?: PreviewKey, right?: PreviewKey): boolean {
  return left?.key === right?.key && (left === undefined || right !== undefined
    && repositoryKey(left.repository) === repositoryKey(right.repository));
}

type Query = Readonly<{ hostRead: 'deployments.environments.list'; input: ReturnType<typeof buildDeploymentPreviewEnvironmentQueryV1> }>;
const QueryContext = React.createContext<ReadonlyMap<string, Query> | null>(null);

type Collection = Pick<DeploymentEnvironmentReadCollectionV1, 'items'>;
type Item = Collection['items'][number];
type Preview = Readonly<{
  kind: 'preview'; environmentId: string; deploymentId: string;
  operation: NonNullable<Item['currentDeployment']>['operation']; servingSha: string;
  state: ReturnType<typeof projectDeploymentPreviewStateV1>; targetUrl: string | null;
}>;
const previews: PluginUiResourceProjection<ReadonlyMap<string, readonly Preview[]>> = {
  decode(content) {
    const { items } = JSON.parse(new TextDecoder().decode(content.bytes)) as Collection;
    const byPullRequest = new Map<string, Item[]>();
    for (const item of items) {
      const id = item.environment.previewPullRequestId;
      if (id === undefined) continue;
      const children = byPullRequest.get(id);
      if (children) children.push(item);
      else byPullRequest.set(id, [item]);
    }
    const result = new Map<string, readonly Preview[]>();
    for (const [id, children] of byPullRequest) {
      const byEnvironment = new Map(children.map(item => [item.environment.id, item]));
      result.set(id, selectCurrentPreviewEnvironmentsV1(children.map(item => item.environment)).flatMap(environment => {
        const item = byEnvironment.get(environment.id)!;
        const { currentDeployment: receipt, runtimeTargetLink: link } = item;
        if (!link || !isOwnServerPreviewTargetV1(link) || receipt?.source?.kind !== 'repository') return [];
        const targetUrl = receipt.id === link.activeDeploymentId ? item.liveAddress ?? null : null;
        return [{
          kind: 'preview', environmentId: environment.id, deploymentId: receipt.id,
          operation: receipt.operation, servingSha: receipt.source.sha,
          state: projectDeploymentPreviewStateV1(receipt, targetUrl), targetUrl,
        }];
      }));
    }
    return result;
  },
};

/** Borrow the exact query for the whole page, including virtualized rows. */
function PreviewRepositoryDemand({ query }: Readonly<{ query: Query }>) {
  useLivePluginResourceProjection(query, previews, () => undefined);
  return null;
}

export function TriageListPreviewBadges({ items, serverId, children }: React.PropsWithChildren<Readonly<{
  items: readonly TriageListItemV1[];
  serverId: string | null;
}>>) {
  const queries = React.useMemo(() => {
    if (serverId === null) return null;
    const repositories = new Map<string, { repository: Repository; ids: Set<string> }>();
    for (const { row: { preview } } of items) {
      if (preview === undefined) continue;
      const key = repositoryKey(preview.repository);
      const group = repositories.get(key);
      if (group) group.ids.add(preview.key);
      else repositories.set(key, { repository: preview.repository, ids: new Set([preview.key]) });
    }
    return new Map([...repositories].map(([key, { repository, ids }]): [string, Query] => [
      key, { hostRead: 'deployments.environments.list', input: buildDeploymentPreviewEnvironmentQueryV1(serverId, repository, [...ids].sort()) },
    ]));
  }, [items, serverId]);
  return (
    <QueryContext.Provider value={queries}>
      {queries === null ? null : [...queries].map(([key, query]) => <PreviewRepositoryDemand key={key} query={query} />)}
      {children}
    </QueryContext.Provider>
  );
}

function TriagePreviewStatus({ query, preview, text }: Readonly<{ query: Query; preview: PreviewKey; text: PluginTranslate }>) {
  const { value } = useLivePluginResourceProjection(query, previews, snapshot =>
    snapshot.error === undefined ? snapshot.value?.get(preview.key) : undefined);
  return value === undefined || value.length === 0 ? null : (
    <PullRequestPreviewSection presentation="badge" closed={false} serverId={query.input.serverId} retry={() => {}} text={text}
      result={{ kind: 'preview', headSha: preview.headSha, previews: value.map(child => ({
        ...child, ...applyDeploymentPreviewHeadV1(child, preview.headSha),
      })) }} />
  );
}

export function TriageListPreviewBadge({ preview, text }: Readonly<{ preview: PreviewKey; text: PluginTranslate }>) {
  const query = React.useContext(QueryContext)?.get(repositoryKey(preview.repository));
  return query === undefined ? null : <TriagePreviewStatus key={preview.key} query={query} preview={preview} text={text} />;
}
