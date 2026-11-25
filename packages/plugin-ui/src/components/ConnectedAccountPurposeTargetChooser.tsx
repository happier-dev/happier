import type { ReactElement, ReactNode } from 'react';
import type { PluginContributionRef } from '@happier-dev/plugin-sdk';
import type {
  AgentConnectedAccountPurposeTeamResourceDefault,
  ConnectedAccountPurposeDeclaration,
  QualifiedConnectedAccountPurposeBindingTarget,
} from '@happier-dev/plugin-sdk/connected-accounts';

import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import { Text } from './Text.js';

/** Account references only; custody, eligibility and connection remain host-owned. */
export type ConnectedAccountPurposeTargetChooserProps = Readonly<{
  testID: string;
  localizedTextPluginId: string;
  declaration: Pick<ConnectedAccountPurposeDeclaration, 'purpose' | 'title' | 'required'> & Readonly<{
    service: PluginContributionRef;
  }>;
  value: QualifiedConnectedAccountPurposeBindingTarget | null;
  teamResourceValue?: AgentConnectedAccountPurposeTeamResourceDefault | null;
  onChange(target: QualifiedConnectedAccountPurposeBindingTarget | null,
    teamResource: AgentConnectedAccountPurposeTeamResourceDefault | null): void;
  onSelectSingleEligible?(target: QualifiedConnectedAccountPurposeBindingTarget | null,
    teamResource: AgentConnectedAccountPurposeTeamResourceDefault | null): void;
  disabled?: boolean;
  disabledReason?: string;
  showDivider?: boolean;
  title?: string;
  icon?: ReactNode;
  description?: string;
  restriction?: Readonly<{ summary: string; sentence: string }>;
  noneLabel?: string;
  onReload?: () => Promise<void> | void;
  reloadSubtitle?: string;
  addAccount?: Readonly<{ label: string; onPress(): void }>;
  /** Offer entitled Team resources when this consumer materializes the purpose in this execution scope. */
  teamCredentialScope?: Readonly<{ serverId: string; machineId?: string | null }>;
  accountsOnly?: boolean;
  teamResourcesOnly?: boolean;
  unavailableLabel?: string;
}>;

/** Delegates to Happier's connected-account chooser without exposing secret material. */
export function ConnectedAccountPurposeTargetChooser(props: ConnectedAccountPurposeTargetChooserProps): ReactElement {
  const host = useOptionalPluginUiPresentationHost();
  if (!host?.renderConnectedAccountPurposeTargetChooser) {
    return <Text testID={`${props.testID}-unavailable`} tone="secondary"
      valueKey="happier.plugin-ui.connectedAccountPurposeTargetChooser.unavailable"
      fallback={props.unavailableLabel ?? 'Account selection is unavailable on this host.'} />;
  }
  return <>{host.renderConnectedAccountPurposeTargetChooser(props)}</>;
}
