import * as React from 'react';
import type { DeploymentEnvironmentReadDetailV1, DeploymentReadControllerV1, DeploymentReadDemandV1 } from '@happier-dev/deployments';
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import { Item } from '@/components/ui/lists/Item';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { t } from '@/text';
import { DeploymentEnvironmentDomainSelect } from './DeploymentEnvironmentDomainSelect';

type Domain = NonNullable<DeploymentEnvironmentReadDetailV1['content']['previewTemplate']>['domain'];

/** Domain inventory and paging remain owned by the Environment's existing read controller. */
export function DeploymentPreviewDomainChoice(props: Readonly<{
  controller: DeploymentReadControllerV1;
  demand: DeploymentReadDemandV1;
  environmentId: string;
  domain: Domain;
  saving: boolean;
  onSave: (domain: Domain) => void;
  testID: string;
}>) {
  const [selection, setSelection] = React.useState<Readonly<{ id: string | null }> | null>(null);
  const [slug, setSlug] = React.useState('');
  const [pattern, setPattern] = React.useState('pr-{number}-{template-slug}');
  const selected = selection ? selection.id : props.domain?.domainId ?? null;
  React.useEffect(() => {
    setSelection(null);
    setSlug(props.domain?.templateSlug ?? '');
    setPattern(props.domain?.hostnamePattern ?? 'pr-{number}-{template-slug}');
  }, [props.environmentId, props.domain?.domainId, props.domain?.templateSlug, props.domain?.hostnamePattern]);
  return <>
    <DeploymentEnvironmentDomainSelect controller={props.controller} demand={props.demand} environmentId={props.environmentId}
      selectedId={selected} allowNone disabled={props.saving} onSelect={id => setSelection({ id })}
      title={t('projects.deployments.settingsSections.previewEditor.domain')}
      testID={`${props.testID}.domain`} stateTestID={`${props.testID}.domains`} />
    {selected !== null ? <>
      <FieldValueItem testID={`${props.testID}.slug`} fieldTestID={`${props.testID}.slug.input`}
        title={t('projects.deployments.settingsSections.previewEditor.slug')} value={slug}
        disabled={props.saving} autoCapitalize="none" onCommit={value => { setSlug(value.trim()); return value.trim(); }} />
      <FieldValueItem testID={`${props.testID}.address`} fieldTestID={`${props.testID}.address.input`}
        title={t('projects.deployments.settingsSections.previewsAddress')} value={pattern}
        disabled={props.saving} autoCapitalize="none" onCommit={value => { setPattern(value.trim()); return value.trim(); }} />
    </> : null}
    {selection !== null || slug !== (props.domain?.templateSlug ?? '') || pattern !== (props.domain?.hostnamePattern ?? 'pr-{number}-{template-slug}') ? (
      <Item title={t('projects.deployments.settingsSections.previewEditor.domain')}
        rightElement={<SectionActionButton testID={`${props.testID}.domain.save`} title={t('common.save')}
          disabled={props.saving || selected !== null && (!slug || !pattern)}
          onPress={() => props.onSave(selected === null ? null : { domainId: selected, templateSlug: slug, hostnamePattern: pattern })} />} />
    ) : null}
  </>;
}
