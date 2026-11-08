import * as React from 'react';
import { View } from 'react-native';
import type { DeploymentReadControllerV1 } from '@happier-dev/deployments';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SelectionTiles } from '@/components/ui/forms/SelectionTiles';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { presentActionFailureOutcome } from '@/components/tools/shell/approvals/approvalFailureOutcome';
import { Text } from '@/components/ui/text/Text';
import { deploymentSheetStyles, showDeploymentSheet } from './deploymentSheet';
import { keepNamesWhole } from '@/utils/text/keepNamesWhole';
import { ModalCardFooterActions } from '@/modal/components/card/ModalCardFooterActions';
import type { CustomModalInjectedProps } from '@/modal/types';
import { t } from '@/text';
import { Modal } from '@/modal';

import type { DeploymentEnvironmentDeletionOutcome } from './useDeploymentEnvironmentDeletion';
import { useDeploymentEnvironmentDomains } from './useDeploymentReads';
import { DeploymentTabState } from './DeploymentTabState';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import type { DeploymentTeardownPreviewV1, DeploymentTeardownVolumesV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';

type Choice = 'remove' | 'detach';
const PRESENTED = { mounted: true, visible: true, focused: true } as const;

export type DeploymentDispositionSheetInput = Readonly<{
  /** What goes: the whole Environment, or one of its targets (Unlink). */
  subject:
    | Readonly<{ kind: 'environment' }>
    | Readonly<{ kind: 'target'; targetLinkId: string }>;
  name: string;
  /** Where its services run, by name ("vps-1"); null when no Machine is linked. */
  machine: string | null;
  /** Something Happier deployed is running there now. */
  running: boolean;
  /** A retained target association can be detached even without an active deployment. */
  hasRetainedAssociations?: boolean;
  /**
   * Whether Stop and remove can be offered. A running subject is stopped first by one teardown the controller
   * prepares, so the page offers it whenever the person may delete.
   */
  canRemove: boolean;
  /** The existing Domain read owner names retirement consequences in this confirmation. */
  domains?: Readonly<{ controller: DeploymentReadControllerV1; environmentId: string }>;
  /** Runs the plan-defined disposition through the page's DTEAR hook. */
  reviewVolumes?: (signal: AbortSignal) => Promise<DeploymentTeardownPreviewV1['volumes']>;
  run: (choice: Choice, volumes?: DeploymentTeardownVolumesV1) => Promise<DeploymentEnvironmentDeletionOutcome>;
  /** A held approval continues on the page's one approval handle. */
  onApproval: (artifactId: string) => void;
  /** The subject is gone; the page leaves it. */
  onDone: (outcome: Extract<DeploymentEnvironmentDeletionOutcome, { kind: 'deleted' | 'unlinked' }>) => void;
}>;

/**
 * Delete environment / Unlink target (lab `teardown/remove`, `teardown/detach`, Plan 40 P40-R14/R31): an
 * irreversible consequence review. Removing resources requires their inventory; explicit detach remains
 * available for retained associations and states what remains, what stops, and the secret/cost consequences.
 */
function DeploymentDispositionSheet(
  props: DeploymentDispositionSheetInput & CustomModalInjectedProps,
) {
  const [choice, setChoice] = React.useState<Choice>(
    // Something running starts on the choice that stops nothing; Stop and remove is one deliberate press away.
    props.running ? 'detach' : 'remove',
  );
  const [busy, setBusy] = React.useState(false);
  const [volumeReview, setVolumeReview] = React.useState<DeploymentTeardownPreviewV1['volumes'] | null>(null);
  const [volumeError, setVolumeError] = React.useState<ActionExecuteFailure | null>(null);
  const [volumeChoices, setVolumeChoices] = React.useState<Record<string, 'keep' | 'delete'>>({});
  const [confirmations, setConfirmations] = React.useState<Record<string, string>>({});
  React.useEffect(() => {
    if (choice !== 'remove' || !props.reviewVolumes || volumeReview !== null || volumeError) return;
    const controller = new AbortController();
    void props.reviewVolumes(controller.signal).then(volumes => {
      if (!controller.signal.aborted) setVolumeReview(volumes);
    }, error => {
      if (!controller.signal.aborted) setVolumeError({ ok: false,
        ...normalizeActionExecutorThrownError(error, 'deployment.teardown.preview') });
    });
    return () => controller.abort();
  }, [choice, props.reviewVolumes, volumeReview, volumeError]);
  const volumesReady = !props.reviewVolumes || volumeReview !== null;
  const volumesConfirmed = volumeReview?.every(volume => volumeChoices[volume.name] !== 'delete'
    || confirmations[volume.name] === volume.name) ?? true;
  const [refused, setRefused] = React.useState<Extract<DeploymentEnvironmentDeletionOutcome, { kind: 'refused' }> | null>(null);
  const machine = keepNamesWhole(props.machine ?? t('projects.deployments.aMachine'));
  const target = props.subject.kind === 'target';
  const domainInput = choice === 'remove' ? props.domains : undefined;
  const domains = useDeploymentEnvironmentDomains(domainInput?.controller ?? null, domainInput?.environmentId ?? null, PRESENTED);
  const domainsReady = !domainInput || domains.result.status === 'ready' || domains.result.status === 'empty';
  const failure = refused?.failure ? presentActionFailureOutcome(refused.failure, 'deployment') : null;
  const volumeFailure = volumeError ? presentActionFailureOutcome(volumeError, 'deployment') : null;
  const confirmTitle =
    choice === 'detach'
      ? target
        ? t('projects.deployments.unlinkConfirmDetach', { machine })
        : t('projects.deployments.deleteConfirmDetach', { name: props.name })
      : target
        ? t('projects.deployments.unlinkConfirm', { machine })
        : props.running
          ? t('projects.deployments.deleteConfirmRemove', { name: props.name })
          : t('projects.deployments.deleteConfirm', { name: props.name });
  const { onClose, onApproval, onDone, run } = props;
  const confirm = async () => {
    if (busy || (choice === 'remove' && (!props.canRemove || !domainsReady || !volumesReady || !volumesConfirmed))) return;
    setBusy(true);
    setRefused(null);
    const outcome = await run(choice, choice === 'remove' && volumeReview ? volumeReview.map(volume =>
      volumeChoices[volume.name] === 'delete'
        ? { name: volume.name, disposition: 'delete', confirmation: confirmations[volume.name] }
        : { name: volume.name, disposition: 'keep' }) : undefined);
    setBusy(false);
    if (outcome.kind === 'deleted' || outcome.kind === 'unlinked') {
      onClose();
      if (choice === 'remove' && outcome.detached) {
        await Modal.alertAsync(t('projects.deployments.factKeepsRunning'), [
          t('projects.deployments.factKeepsRunningValue', { machine }),
          t('projects.deployments.factSecretsValue'),
          t('projects.deployments.factCostsValue', { machine }),
        ].join('\n\n'));
      }
      onDone(outcome);
      return;
    }
    if (outcome.kind === 'approval') {
      onClose();
      onApproval(outcome.artifactId);
      return;
    }
    // Admitted teardown work continues through its existing receipt.
    if (outcome.kind === 'receipt' || outcome.kind === 'started') {
      onClose();
      return;
    }
    if (outcome.kind === 'refused') setRefused(outcome);
  };
  const footer = (
    <ModalCardFooterActions cancel={{ onPress: onClose, testID: 'project-deployments.disposition.cancel', disabled: busy }}>
      <RoundButton
        testID="project-deployments.disposition.confirm"
        size="normal"
        display="destructive"
        titleNumberOfLines="complete"
        loading={busy}
        disabled={busy || (choice === 'remove' && (!props.canRemove || !domainsReady || !volumesReady || !volumesConfirmed))}
        title={confirmTitle}
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

  const facts: Array<Readonly<{ key: string; label: string; value: string }>> =
    choice === 'detach'
      ? [
          {
            key: 'keeps-running',
            label: t('projects.deployments.factKeepsRunning'),
            value: t('projects.deployments.factKeepsRunningValue', { machine }),
          },
          {
            key: 'stops',
            label: t('projects.deployments.factStops'),
            value: target
              ? t('projects.deployments.factStopsTargetValue', {
                  name: props.name,
                  machine,
                })
              : t('projects.deployments.factStopsValue', { name: props.name }),
          },
          {
            key: 'secrets',
            label: t('projects.deployments.factSecrets'),
            value: t('projects.deployments.factSecretsValue'),
          },
          {
            key: 'costs',
            label: t('projects.deployments.factCosts'),
            value: t('projects.deployments.factCostsValue', { machine }),
          },
        ]
      : [
          // Volumes are named only where something ran: a never-deployed environment has none.
          ...(props.running ? [{
            key: 'data',
            label: t('projects.deployments.factData'),
            value: t('projects.deployments.factDataValue'),
          }] : []),
          {
            key: 'keeps',
            label: t('projects.deployments.factKeeps'),
            value: t('projects.deployments.factKeepsValue'),
          },
        ];

  return (
    <ListPresentationProvider value="page" pageInsets="contained">
    <View testID="project-deployments.disposition" style={deploymentSheetStyles.body}>
      <Text style={deploymentSheetStyles.lead}>
        {props.running
          ? target
            ? t('projects.deployments.unlinkLead', {
                name: props.name,
                machine,
              })
            : t('projects.deployments.deleteLead', {
                name: props.name,
                machine,
              })
          : target
            ? t('projects.deployments.unlinkLeadIdle', {
                name: props.name,
                machine,
              })
            : t('projects.deployments.deleteLeadIdle', { name: props.name })}
      </Text>
      {props.running || props.hasRetainedAssociations ? (
        <SelectionTiles<Choice>
          testIdPrefix="project-deployments.disposition.choice"
          accessibilityLabel={confirmTitle}
          value={choice}
          onChange={(next) => {
            if (next) {
              setChoice(next);
              setRefused(null);
            }
          }}
          minimumTileWidth={240}
          subtitleLines={6}
          options={[
            {
              id: 'remove',
              icon: 'stop-circle',
              title: t('projects.deployments.deleteStopTitle'),
              subtitle: props.canRemove
                ? t('projects.deployments.deleteStopBody', { machine })
                : t('projects.deployments.deleteStopUnavailable', { machine }),
              disabled: !props.canRemove,
            },
            {
              id: 'detach',
              icon: 'link-break',
              title: t('projects.deployments.deleteDetachTitle'),
              subtitle: target
                ? t('projects.deployments.unlinkDetachBody', { name: props.name, machine })
                : t('projects.deployments.deleteDetachBody', { name: props.name, machine }),
            },
          ]}
        />
      ) : null}
      {choice === 'remove' && props.reviewVolumes ? <ItemGroup title={t('projects.deployments.factData')}>
        {volumeReview === null ? <SurfaceStateCard size="line" kind={volumeError ? 'error' : 'loading'}
          testID={volumeError ? 'project-deployments.disposition.volumes.error' : undefined}
          title={volumeError ? t('projects.deployments.volumeReviewError') : t('projects.deployments.loading')}
          reason={volumeFailure?.reason ?? undefined}
          diagnosticCode={volumeFailure?.code}
          diagnosticDetail={volumeFailure?.technicalDetails.map(line => `${line.label}: ${line.value}`).join('\n')}
          action={volumeError ? { label: t('common.retry'), onPress: () => setVolumeError(null),
            testID: 'project-deployments.disposition.volumes.retry' } : undefined} /> : null}
        {volumeReview?.length === 0 ? <Item testID="project-deployments.disposition.volumes.empty"
          title={t('projects.deployments.noDataToKeep')} mode="info" /> : null}
        {volumeReview?.map(volume => <React.Fragment key={volume.name}>
          <SegmentedChoiceItem title={volume.name} disabled={busy}
            testIDPrefix={`project-deployments.disposition.volume.${volume.name}`}
            value={volumeChoices[volume.name] ?? 'keep'}
            options={[{ id: 'keep', label: t('common.keep') }, { id: 'delete', label: t('common.delete') }]}
            onChange={next => setVolumeChoices(previous => ({ ...previous, [volume.name]: next }))} />
          {volumeChoices[volume.name] === 'delete' ? <Item title={t('projects.deployments.volumeConfirmation', { name: volume.name })}
            accessoryLayout="adaptive" showChevron={false} rightElement={<FieldTextInput
              testID={`project-deployments.disposition.volume.${volume.name}.confirmation`}
              accessibilityLabel={t('projects.deployments.volumeConfirmation', { name: volume.name })}
              value={confirmations[volume.name] ?? ''} editable={!busy} monospace
              onChangeText={text => setConfirmations(previous => ({ ...previous, [volume.name]: text }))} />} /> : null}
        </React.Fragment>)}
      </ItemGroup> : null}
        <ItemGroup
          testID="project-deployments.disposition.facts"
          header="none"
        >
          {facts.map((fact) => (
            <Item
              key={fact.key}
              testID={`project-deployments.disposition.fact.${fact.key}`}
              title={fact.label}
              subtitle={fact.value}
              subtitleLines={0}
              mode="info"
            />
          ))}
        </ItemGroup>
      {domainInput ? <ItemGroup testID="project-deployments.disposition.domains" header="none">
        {domains.result.items.length > 0 ? <Item mode="info" title={t('projects.deployments.tabDomains')}
          subtitle={t('projects.deployments.deleteDomains', { domains: domains.result.items.map(item => item.content.hostname).join(', ') })}
          subtitleLines={0} /> : null}
        {domains.result.status === 'empty' ? null : <DeploymentTabState result={domains.result}
          testID="project-deployments.disposition.domains" errorTitle={t('projects.deployments.domainsErrorTitle')}
          emptyTitle={t('projects.deployments.domainsEmpty')} />}
        {domains.hasPreviousPage ? <SectionActionButton testID="project-deployments.disposition.domains.previous"
          title={t('projects.deployments.pagePrevious')} icon="caret-left" onPress={domains.previousPage} /> : null}
        {domains.hasNextPage ? <SectionActionButton testID="project-deployments.disposition.domains.next"
          title={t('projects.deployments.pageNext')} icon="caret-right" onPress={domains.nextPage} /> : null}
      </ItemGroup> : null}
      {refused ? (
        <SurfaceStateCard
          testID="project-deployments.disposition.refused"
          size="line"
          kind="error"
          title={
            target
              ? t('projects.deployments.unlinkRefused', { machine })
              : t('projects.deployments.deleteRefused', { name: props.name })
          }
          reason={failure?.reason ?? undefined}
          diagnosticCode={refused.code}
          diagnosticDetail={failure?.technicalDetails.map(line => `${line.label}: ${line.value}`).join('\n')}
        />
      ) : null}
      {/* Without card chrome (an embedding host), the footer ends the body. */}
      {setChrome ? null : footer}
    </View>
    </ListPresentationProvider>
  );
}

export function showDeploymentDispositionSheet(
  input: DeploymentDispositionSheetInput,
): void {
  const machine = input.machine ?? t('projects.deployments.aMachine');
  showDeploymentSheet({
    component: DeploymentDispositionSheet,
    props: input,
    title: input.subject.kind === 'target'
          ? t('projects.deployments.unlinkTitle', { machine })
          : t('projects.deployments.deleteTitle', { name: input.name }),
    testID: 'project-deployments.disposition.modal',
  });
}
