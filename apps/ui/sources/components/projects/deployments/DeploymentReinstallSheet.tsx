import * as React from 'react';
import { View } from 'react-native';
import type { DeploymentRuntimeReinstallV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { useSavedSecretCatalogName } from '@/components/secrets/useSavedSecretCatalog';
import { ModalCardFooterActions } from '@/modal/components/card/ModalCardFooterActions';
import type { CustomModalInjectedProps } from '@/modal/types';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { t } from '@/text';

import { deploymentSheetStyles, showDeploymentSheet } from './deploymentSheet';
import type { DeploymentEnvironmentDeletionOutcome } from './useDeploymentEnvironmentDeletion';

export type DeploymentReinstallSheetInput = Readonly<{
  name: string;
  /** The reinstalled Machine's name, for the lead. */
  machine: string;
  /** The Environment read's fact; the sheet computes nothing of its own. */
  reinstall: DeploymentRuntimeReinstallV1;
  /** The Account scope that names Saved Secrets. */
  secretScope: AccountSettingsScope | null;
  /** Relink and re-seal (the page's disposition owner); the page's Deploy follows on success. */
  run: () => Promise<DeploymentEnvironmentDeletionOutcome>;
  onReinstalled: (targetLinkId: string) => void;
  onApproval: (artifactId: string) => void;
}>;

/**
 * Reinstall on this Machine: what stays, which Saved Secrets re-seal by themselves and which must be chosen again,
 * and that older backups keep their credential. Confirm relinks and re-seals; the ordinary Deploy and its Receipt follow.
 */
function DeploymentReinstallSheet(
  props: DeploymentReinstallSheetInput & CustomModalInjectedProps,
) {
  const [busy, setBusy] = React.useState(false);
  const [refused, setRefused] = React.useState<string | null>(null);
  const { onClose, onApproval, onReinstalled, run } = props;
  const { reseal, reenter } = props.reinstall.savedSecrets;
  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setRefused(null);
    const outcome = await run();
    setBusy(false);
    if (outcome.kind === 'reinstalled') {
      onClose();
      onReinstalled(outcome.targetLinkId);
      return;
    }
    if (outcome.kind === 'approval') {
      onClose();
      onApproval(outcome.artifactId);
      return;
    }
    if (outcome.kind === 'refused') setRefused(outcome.code);
  };
  const footer = (
    <ModalCardFooterActions
      cancel={{
        onPress: onClose,
        testID: 'project-deployments.reinstall.cancel',
        disabled: busy,
      }}
    >
      <RoundButton
        testID="project-deployments.reinstall.confirm"
        size="normal"
        loading={busy}
        disabled={busy}
        title={t('projects.deployments.overviewStatus.reinstallAction')}
        onPress={() => {
          void confirm();
        }}
      />
    </ModalCardFooterActions>
  );
  const { setChrome } = props;
  React.useEffect(() => {
    setChrome?.({ kind: 'card', footer });
  });
  React.useEffect(() => () => setChrome?.(null), [setChrome]);
  return (
    <ListPresentationProvider value="page" pageInsets="contained">
      <View
        testID="project-deployments.reinstall"
        style={deploymentSheetStyles.body}
      >
        <Text style={deploymentSheetStyles.lead}>
          {t('projects.deployments.overviewStatus.reinstallLead', {
            name: props.name,
            machine: props.machine,
          })}
        </Text>
        <ItemGroup testID="project-deployments.reinstall.facts" header="none">
          <Item
            testID="project-deployments.reinstall.fact.stays"
            title={t('projects.deployments.overviewStatus.reinstallStaysTitle')}
            subtitle={t(
              'projects.deployments.overviewStatus.reinstallStaysBody',
            )}
            subtitleLines={0}
            showChevron={false}
          />
          {reseal.length > 0 ? (
            <Item
              testID="project-deployments.reinstall.fact.reseal"
              title={t(
                'projects.deployments.overviewStatus.reinstallResealTitle',
              )}
              subtitle={t(
                'projects.deployments.overviewStatus.reinstallResealBody',
              )}
              subtitleLines={0}
              showChevron={false}
            />
          ) : null}
          {reseal.map((ref) => (
            <SavedSecretRow
              key={ref}
              secretRef={ref}
              scope={props.secretScope}
              testID={`project-deployments.reinstall.reseal.${ref}`}
            />
          ))}
          {reenter.length > 0 ? (
            <Item
              testID="project-deployments.reinstall.fact.reenter"
              title={t(
                'projects.deployments.overviewStatus.reinstallReenterTitle',
              )}
              subtitle={t(
                'projects.deployments.overviewStatus.reinstallReenterBody',
              )}
              subtitleLines={0}
              showChevron={false}
            />
          ) : null}
          {reenter.map((ref) => (
            <SavedSecretRow
              key={ref}
              secretRef={ref}
              scope={props.secretScope}
              testID={`project-deployments.reinstall.reenter.${ref}`}
            />
          ))}
          <Item
            testID="project-deployments.reinstall.fact.backups"
            title={t(
              'projects.deployments.overviewStatus.reinstallBackupsTitle',
            )}
            subtitle={t(
              'projects.deployments.overviewStatus.reinstallBackupsBody',
            )}
            subtitleLines={0}
            showChevron={false}
          />
        </ItemGroup>
        {refused ? (
          <SurfaceStateCard
            testID="project-deployments.reinstall.refused"
            size="line"
            kind="error"
            title={t('projects.deployments.overviewStatus.reinstallRefused')}
            diagnosticCode={refused}
          />
        ) : null}
        {setChrome ? null : footer}
      </View>
    </ListPresentationProvider>
  );
}

/** One Saved Secret by its catalog name; the reference itself while the catalog is read or does not list it. */
function SavedSecretRow(
  props: Readonly<{
    secretRef: string;
    scope: AccountSettingsScope | null;
    testID: string;
  }>,
) {
  const name = useSavedSecretCatalogName(props.secretRef, props.scope);
  return (
    <Item
      testID={props.testID}
      title={name.name ?? props.secretRef}
      showChevron={false}
    />
  );
}

export function showDeploymentReinstallSheet(
  input: DeploymentReinstallSheetInput,
): void {
  showDeploymentSheet({
    component: DeploymentReinstallSheet,
    props: input,
    title: t('projects.deployments.overviewStatus.reinstallTitle', {
      machine: input.machine,
    }),
    testID: 'project-deployments.reinstall.modal',
  });
}
