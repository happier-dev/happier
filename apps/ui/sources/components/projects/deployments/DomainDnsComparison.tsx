import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { DeploymentDomainDnsComparisonV1 } from '@happier-dev/protocol/deployments/deploymentDomainV1';

import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { FactStrip, type FactStripFact } from '@/components/ui/lists/FactStrip';
import { Item } from '@/components/ui/lists/Item';
import { t } from '@/text';

/**
 * "Points elsewhere" opens in place (lab servers-ia round 3 Q9): what Happier expects, what the name answers, and the
 * next step, as the shared fact strip draws three facts. Every value is the explicit DNS check's own authorized result.
 */
export function DomainDnsComparison(props: Readonly<{
  comparison?: DeploymentDomainDnsComparisonV1;
  mismatch: boolean;
  generated?: boolean;
  onOpen?: () => void;
}>) {
  const [expanded, setExpanded] = React.useState(false);
  const { comparison } = props;
  const facts = React.useMemo((): FactStripFact[] => {
    const unavailable = t('projects.deployments.editors.domainDnsEvidenceUnavailable');
    const answered = comparison?.answered;
    // A family the resolver did not answer is unread (null); an answered family with no records is said as such.
    const records = !answered || (answered.A === null && answered.AAAA === null) ? unavailable : [
      answered.A && answered.A.length > 0 ? `A ${answered.A.join(', ')}` : null,
      answered.AAAA && answered.AAAA.length > 0 ? `AAAA ${answered.AAAA.join(', ')}` : null,
    ].filter((part): part is string => part !== null).join(' · ') || t('projects.deployments.editors.domainDnsNoRecords');
    return [
      { key: 'expected', testID: 'deployment-domain-dns-comparison.expected', label: t('projects.deployments.editors.domainDnsExpected'),
        value: comparison?.expectedIpv4 ? `A ${comparison.expectedIpv4}` : unavailable },
      { key: 'answered', testID: 'deployment-domain-dns-comparison.answered', label: t('projects.deployments.editors.domainDnsPointsAt'),
        value: records, ...(props.mismatch && answered ? { tone: 'attention' as const } : {}) },
      ...(props.mismatch ? [{ key: 'next', testID: 'deployment-domain-dns-comparison.next', label: t('common.next'), wide: true,
        value: props.generated ? t('projects.deployments.editors.domainDnsGeneratedNext') : t('projects.deployments.editors.domainDnsNext') }] : []),
    ];
  }, [comparison, props.generated, props.mismatch]);
  return <ExpandableItem testID="deployment-domain-dns-comparison" expanded={expanded} onExpandedChange={open => {
    setExpanded(open);
    if (open) props.onOpen?.();
  }} header={state => <Item {...state.headerProps} title={props.mismatch
    ? t('projects.deployments.editors.domainDnsPointsElsewhere') : t('projects.deployments.domainDnsCheck')} />}>
    <View style={styles.facts}><FactStrip testID="deployment-domain-dns-comparison.facts" facts={facts} /></View>
  </ExpandableItem>;
}

const styles = StyleSheet.create((theme) => ({
  facts: { paddingVertical: theme.space.s8 },
}));
