import * as React from 'react';
import type { DeploymentDomainDnsComparisonV1 } from '@happier-dev/protocol/deployments/deploymentDomainV1';

import { Item } from '@/components/ui/lists/Item';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

export function DomainDnsComparison(props: Readonly<{
  comparison?: DeploymentDomainDnsComparisonV1;
  mismatch: boolean;
  generated?: boolean;
  onOpen?: () => void;
}>) {
  const [expanded, setExpanded] = React.useState(false);
  const { comparison } = props;
  const unavailable = t('projects.deployments.editors.domainDnsEvidenceUnavailable');
  const record = (answers: string[] | null | undefined) => answers
    ? answers.join(', ') || t('projects.deployments.editors.domainDnsNoRecords') : unavailable;
  const answered = comparison?.answered;
  return <ExpandableItem testID="deployment-domain-dns-comparison" expanded={expanded} onExpandedChange={open => {
    setExpanded(open);
    if (open) props.onOpen?.();
  }} header={state => <Item {...state.headerProps} title={props.mismatch
    ? t('projects.deployments.editors.domainDnsPointsElsewhere') : t('projects.deployments.domainDnsCheck')} />}>
    <Text variant="meta" selectable>{t('projects.deployments.editors.domainDnsExpected')} {comparison?.expectedIpv4 ?? unavailable}</Text>
    <Text variant="meta" selectable>{t('projects.deployments.editors.domainDnsPointsAt')} A {record(answered?.A)} · AAAA {record(answered?.AAAA)}</Text>
    {props.mismatch ? <Text variant="meta">{t('common.next')} · {props.generated
      ? t('projects.deployments.editors.domainDnsGeneratedNext') : t('projects.deployments.editors.domainDnsNext')}</Text> : null}
  </ExpandableItem>;
}
