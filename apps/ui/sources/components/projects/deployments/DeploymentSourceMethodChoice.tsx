import * as React from 'react';
import type { DeploymentSourceMethodV1 } from '@happier-dev/deployment-protocol/v1';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { t } from '@/text';

/** A deploy intent's explicit source method, offered by its runtime target descriptor. */
export function DeploymentSourceMethodChoice(props: Readonly<{
  methods: readonly DeploymentSourceMethodV1[];
  value: DeploymentSourceMethodV1;
  onChange: (value: DeploymentSourceMethodV1) => void;
  disabled?: boolean;
  testID: string;
}>) {
  if (props.methods.length < 2) return null;
  return <SegmentedChoiceItem
    testID={props.testID}
    title={t('projects.deployments.platformLink.sourceMethod')}
    value={props.value}
    onChange={props.onChange}
    disabled={props.disabled}
    options={props.methods.map(id => id === 'upload'
      ? { id, label: t('projects.deployments.platformLink.upload'), description: t('projects.deployments.platformLink.uploadBody') }
      : { id, label: t('projects.deployments.platformLink.gitIntegration'), description: t('projects.deployments.platformLink.gitIntegrationBody') })}
  />;
}
