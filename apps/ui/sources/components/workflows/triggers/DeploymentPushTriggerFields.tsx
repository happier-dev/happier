import * as React from 'react';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Item } from '@/components/ui/lists/Item';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { t } from '@/text';

export function DeploymentPushTriggerFields(props: Readonly<{
  branch: string; onBranchChange: (value: string) => void;
  approval: 'automatic' | 'ask'; inherited?: boolean;
  onApprovalChange: (value: 'automatic' | 'ask') => void;
}>) {
  return <>
    <Item title={t('projects.open.branch')} showChevron={false} rightElement={<FieldTextInput
      testID="deployment-push-branch" value={props.branch} onChangeText={props.onBranchChange}
      accessibilityLabel={t('projects.open.branch')} autoCapitalize="none" />} />
    <SegmentedChoiceItem title={t('settingsApiTokens.grant.deployApproval.title')}
      testIDPrefix="deployment-push-approval" value={props.approval}
      valueSource={props.inherited ? 'inherited' : 'set'} onChange={props.onApprovalChange}
      options={[
        { id: 'automatic', label: t('settingsApiTokens.grant.deployApproval.automatic') },
        { id: 'ask', label: t('settingsApiTokens.grant.deployApproval.ask') },
      ]} />
  </>;
}
