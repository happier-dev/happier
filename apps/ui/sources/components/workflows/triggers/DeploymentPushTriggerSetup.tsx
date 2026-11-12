import * as React from 'react';
import type { View } from 'react-native';
import type { PluginUiOpenAutomationEventRequestV1 } from '@happier-dev/protocol/plugins/ui';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { addWorkflowTrigger } from '@/sync/domains/workflows/workflowTriggerActions';
import { sync } from '@/sync/sync';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { DeploymentPushTriggerFields } from './DeploymentPushTriggerFields';
import { TriggerPopover } from './TriggerPopover';
import { buildDeploymentPushRequest, type DeploymentPushSetupConfig } from './deploymentPushSetup';

const PUSH_EVENT = { pluginId: 'happier.scm.forge.github', localId: 'automation/repository-pushed-v1' } as const;
const NO_WORKFLOWS = [] as const;

/** Repository setup and save failures remain owned by the ordinary Event/trigger editor. */
export function DeploymentPushTriggerSetup(props: Readonly<{
  config: DeploymentPushSetupConfig;
  anchorRef: React.RefObject<View | null>;
  onRequestClose: () => void;
  eventSeed?: PluginUiOpenAutomationEventRequestV1;
  accountLifetime?: ServerAccountScopeLifetime | null;
}>) {
  const [approval, setApproval] = React.useState<'automatic' | 'ask' | undefined>();
  const [branch, setBranch] = React.useState('');
  const eventSeed = props.eventSeed ?? { eventRef: PUSH_EVENT };
  const displayedApproval = approval ?? (props.config.protection === 'production' ? 'ask' : 'automatic');
  return <TriggerPopover
    testID="deployment-push-trigger-setup"
    anchorRef={props.anchorRef}
    onRequestClose={props.onRequestClose}
    newTitle={t('workflows.examples.deployOnPush.title')}
    initial={null}
    initialWhen={{ kind: 'pluginEvent', value: null, eventRef: eventSeed.eventRef }}
    initialEventSeed={eventSeed}
    whenKinds={['pluginEvent']}
    sessionId={null}
    showThen={false}
    accountLifetime={props.accountLifetime}
    workflowOptions={NO_WORKFLOWS}
    machineId={props.config.project.machineId}
    directory={props.config.project.directory}
    serverId={props.config.environment.serverId}
    afterRows={<DeploymentPushTriggerFields branch={branch} onBranchChange={setBranch}
      approval={displayedApproval} inherited={approval === undefined} onApprovalChange={setApproval} />}
    onSubmit={async (_value, write) => {
      if (write.trigger === null) return;
      await addWorkflowTrigger(buildDeploymentPushRequest(props.config, write.trigger, approval, branch),
        props.accountLifetime === undefined ? {} : { accountLifetime: props.accountLifetime });
      fireAndForget(sync.refreshAutomations());
    }}
  />;
}
