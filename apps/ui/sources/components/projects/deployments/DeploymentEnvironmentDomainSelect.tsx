import * as React from 'react';
import type { DeploymentReadControllerV1, DeploymentReadDemandV1 } from '@happier-dev/deployments';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { t } from '@/text';
import { useDeploymentEnvironmentDomains } from './useDeploymentReads';
import { DeploymentTabState } from './DeploymentTabState';

/** The Environment Domain inventory supplies every Domain reference picker, including its paging and refusal. */
export function DeploymentEnvironmentDomainSelect(props: Readonly<{
  controller: DeploymentReadControllerV1;
  demand: DeploymentReadDemandV1;
  environmentId: string;
  selectedId: string | null;
  allowNone?: boolean;
  disabled: boolean;
  title: string;
  onSelect: (id: string | null) => void;
  testID: string;
  stateTestID: string;
}>) {
  const read = useDeploymentEnvironmentDomains(props.controller, props.environmentId, props.demand);
  const [open, setOpen] = React.useState(false);
  const items = [...(props.allowNone ? [{ id: '', title: t('common.none') }] : []),
    ...read.result.items.flatMap(row => row.content.hostname ? [{ id: row.domain.id, title: row.content.hostname }] : [])];
  return <>
    <DropdownMenu testID={props.testID} open={open} onOpenChange={setOpen}
      items={items} selectedId={props.selectedId ?? ''}
      onSelect={id => { setOpen(false); props.onSelect(id === '' ? null : id); }}
      itemTrigger={{ title: props.title,
        detailFormatter: () => items.find(item => item.id === (props.selectedId ?? ''))?.title ?? props.selectedId,
        itemProps: { accessoryLayout: 'adaptive', disabled: props.disabled } }} />
    <DeploymentTabState result={read.result} testID={props.stateTestID}
      errorTitle={t('projects.deployments.domainsErrorTitle')} emptyTitle={t('projects.deployments.domainsEmpty')} />
    {read.hasPreviousPage ? <Item title={t('projects.deployments.pagePrevious')} onPress={read.previousPage} /> : null}
    {read.hasNextPage ? <Item title={t('projects.deployments.pageNext')} onPress={read.nextPage} /> : null}
  </>;
}
