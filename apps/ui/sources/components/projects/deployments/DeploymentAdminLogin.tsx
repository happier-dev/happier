import * as React from 'react';
import type { DeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol';
import type { DeploymentContentV1 } from '@happier-dev/deployment-protocol/v1';

import { SharedSavedSecretValueItem } from '@/components/secrets/SharedSavedSecretValueItem';
import { useSavedSecretCatalogEntries } from '@/components/secrets/useSavedSecretCatalog';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';

/** Catalog declarations select fields; their values stay with runtime bindings and the shared disclosure owner. */
export function DeploymentAdminLogin(props: Readonly<{
  template: DeploymentEnvironmentDetailV1['content']['template'] | null;
  bindings: DeploymentEnvironmentDetailV1['content']['bindings'];
  images: DeploymentContentV1['images'];
  scope: ServerAccountScopeLifetime['scope'];
  active: boolean;
  servingUrl: string | null;
  onOpenDomains: () => void;
  onOpenServing?: (url: string) => void;
}>) {
  const fields = props.template?.loginFields;
  const username = fields?.username ? props.bindings.find(row => row.purpose === 'variable'
    && row.phase === 'runtime' && row.name === fields.username) : undefined;
  const password = fields ? props.bindings.find(row => row.purpose === 'variable'
    && row.phase === 'runtime' && row.name === fields.password && row.source.kind === 'secret') : undefined;
  const passwordRef = password?.source.kind === 'secret' ? password.source.ref : null;
  const usernameRef = username?.source.kind === 'secret' ? username.source.ref : null;
  // Its own sheet under What runs, drawn only when the app has a login, a first-run step or catalog images to say.
  if (username?.source.kind !== 'value' && !usernameRef && !passwordRef && !props.template?.firstRunSetup
    && !(props.template && props.images.length > 0)) return null;
  return <ItemGroup header="none">
    {username?.source.kind === 'value' ? <Item testID="project-deployments.environment.services.login.username"
      title={t('projects.deployments.databaseUsername')} subtitle={username.source.value} mode="info" showChevron={false} /> : null}
    {usernameRef ? <DeploymentAdminLoginSecret refId={usernameRef} scope={props.scope} active={props.active}
      title={t('projects.deployments.databaseUsername')} testID="project-deployments.environment.services.login.username" /> : null}
    {passwordRef ? <DeploymentAdminLoginSecret refId={passwordRef} scope={props.scope} active={props.active}
      title={t('projects.deployments.adminPassword')} testID="project-deployments.environment.services.login" /> : null}
    {props.template?.firstRunSetup ? <AttentionBanner testID="project-deployments.environment.services.firstRun"
      title={t('projects.deployments.addFirstRunTitle')} description={t('projects.deployments.overviewStatus.catalogFirstRunBody')}
      tone="warning" placement="inline" action={props.servingUrl && props.onOpenServing
        ? { label: t('projects.deployments.addFirstRunTitle'), testID: 'project-deployments.environment.services.firstRun.open',
          onPress: () => { if (props.servingUrl) props.onOpenServing?.(props.servingUrl); } }
        : { label: t('projects.deployments.tabDomains'), testID: 'project-deployments.environment.services.firstRun.domains',
          onPress: props.onOpenDomains }} /> : null}
    {props.template && props.images.map(image => <Item key={`${image.service}:${image.platform}`}
      testID={`project-deployments.environment.services.image:${image.service}`}
      title={`${image.service} · ${image.platform}`}
      subtitle={[image.registryReference, image.manifestDigest].filter(Boolean).join('\n')}
      subtitleLines={0} mode="info" showChevron={false} />)}
    {props.template && props.images.length > 0 ? <Item
      testID="project-deployments.environment.services.image.notice"
      title={t('projects.deployments.overviewStatus.catalogImageBody')} titleLines={0} mode="info" showChevron={false} /> : null}
  </ItemGroup>;
}

function DeploymentAdminLoginSecret(props: Readonly<{
  refId: string; scope: ServerAccountScopeLifetime['scope']; active: boolean; title: string; testID: string;
}>) {
  const refs = React.useMemo(() => [props.refId], [props.refId]);
  const catalog = useSavedSecretCatalogEntries({ scope: props.scope, refs });
  const entry = catalog.find(candidate => candidate.ref === props.refId);
  return entry ? <SharedSavedSecretValueItem testID={props.testID}
    title={props.title} scope={props.scope} entry={entry} active={props.active} /> : null;
}
