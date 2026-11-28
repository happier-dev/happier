import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
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
import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';
import { ModalCardFooterActions } from '@/modal/components/card/ModalCardFooterActions';
import type { CustomModalInjectedProps } from '@/modal/types';
import { t } from '@/text';
import { Modal } from '@/modal';

import type { DeploymentEnvironmentDeletionOutcome } from './useDeploymentEnvironmentDeletion';
import { useDeploymentEnvironmentDomains, useReceiptRead } from './useDeploymentReads';
import { useDeploymentCancellation } from './useDeploymentCancellation';
import type { DeploymentReviewHandle } from './DeploymentEnvironmentDetail';
import type { createDeploymentActions } from './deploymentActions';
import { DeploymentActionFailureV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentTabState } from './DeploymentTabState';
import { deploymentVolumeDisplayName as volumeDisplayName } from './deploymentPresentation';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import type { DeploymentTeardownPreviewV1, DeploymentTeardownVolumesV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';

type Choice = 'remove' | 'detach';
/** Compose prefixes a volume with Happier's project id; the person's name for it is what follows. The exact name stays in the delete confirmation. */
const NO_REVIEW: DeploymentReviewHandle = { pendingId: null, request: () => {}, open: () => {} };
const PRESENTED = { mounted: true, visible: true, focused: true } as const;

export type DeploymentDispositionSheetInput = Readonly<{
  /** What goes: the whole Environment, or one of its targets (Unlink). */
  subject:
    | Readonly<{ kind: 'environment' }>
    | Readonly<{ kind: 'target'; targetLinkId: string }>;
  recovery?: Readonly<{ controller: DeploymentReadControllerV1; environmentId: string;
    cancel: ReturnType<typeof createDeploymentActions>['cancel'] | null; review: DeploymentReviewHandle;
    onOpenReceipt: (deploymentId: string) => void; onHistory: () => void }>;
  name: string;
  /** An explicit request to review Detach starts on that choice. */
  initialChoice?: 'detach';
  /** Where its services run, by name ("vps-1"); null when no Machine is linked. */
  machine: string | null;
  /** The hosting provider, when the target is a contributed platform. */
  provider?: string | null;
  /**
   * The provider resource a contributed platform target names: its name (typed to confirm deletion), what the provider
   * deletes with it, and the removal owner's default (`selectDeploymentTargetRemovalChoicesV1`). Absent for Machines.
   */
  providerResource?: Readonly<{ name: string; consequence: string | null; defaultChoice: 'unlink' | 'delete';
    /** A data project (a managed database) keeps its data and is no longer managed; a runtime keeps running. */
    role?: 'runtime' | 'data' }>;
  /** Something Happier deployed is running there now. */
  running: boolean;
  /** The services a removal stops, by Compose name; empty when not known. */
  services?: readonly string[];
  /** A retained target association can be detached even without an active deployment. */
  hasRetainedAssociations?: boolean;
  /**
   * Whether the target declares teardown. Unavailable removal is omitted; Detach keeps its workload running.
   */
  canRemove: boolean;
  /** The existing Domain read owner names retirement consequences in this confirmation. */
  domains?: Readonly<{ controller: DeploymentReadControllerV1; environmentId: string }>;
  /** Nothing was ever deployed: deleting stops nothing and keeps no history, so there is nothing to choose (R14-D9). */
  neverDeployed?: boolean;
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
  const { theme } = useUnistyles();
  const [choice, setChoice] = React.useState<Choice>(
    // A provider resource starts where the removal owner says: Delete for what Happier created, Unlink otherwise.
    // On a Machine, something running starts on the choice that stops nothing; Stop and remove is one press away.
    // A subject Happier cannot remove never starts on that unavailable choice.
    props.initialChoice ?? (props.providerResource ? props.providerResource.defaultChoice === 'delete' ? 'remove' : 'detach'
      : props.running || !props.canRemove ? 'detach' : 'remove'),
  );
  // Provider deletion is irreversible and outside Happier: the person types the resource's name to enable it.
  const [typedResource, setTypedResource] = React.useState('');
  const resource = props.providerResource ?? null;
  const resourceConfirmed = !resource || choice !== 'remove' || typedResource === resource.name;
  const resourceConfirmation = resource ? t('projects.deployments.platformLink.typeToDelete', { resource: resource.name }) : null;
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
    || confirmations[volume.name] === volumeDisplayName(volume.name)) ?? true;
  const [refused, setRefused] = React.useState<Extract<DeploymentEnvironmentDeletionOutcome, { kind: 'refused' }> | null>(null);
  const blocked = DeploymentActionFailureV1Schema.safeParse(refused?.failure?.details);
  const blockedId = blocked.success && blocked.data.error === 'deployment_in_progress' ? blocked.data.deploymentId : null;
  const blockedReceipt = useReceiptRead(props.recovery?.controller ?? null,
    props.recovery?.environmentId ?? null, blockedId, PRESENTED);
  const blockedValue = blockedReceipt.snapshot.value;
  const cancellation = useDeploymentCancellation({ receipt: blockedId ? blockedValue : null,
    cancel: props.recovery?.cancel ?? null, review: props.recovery?.review ?? NO_REVIEW,
    onOpenReceipt: props.recovery?.onOpenReceipt ?? (() => {}) });
  const machine = keepNamesWhole(props.provider ?? props.machine ?? t('projects.deployments.aMachine'));
  const target = props.subject.kind === 'target';
  const domainInput = choice === 'remove' ? props.domains : undefined;
  const domains = useDeploymentEnvironmentDomains(domainInput?.controller ?? null, domainInput?.environmentId ?? null, PRESENTED);
  const domainsReady = !domainInput || domains.result.status === 'ready' || domains.result.status === 'empty';
  const failure = refused?.failure ? presentActionFailureOutcome(refused.failure, 'deployment') : null;
  // The owner's typed cause: a refusal the Action records as before any effect changed nothing. A stop then is the
  // request's, not a deployment's, so its deploy-time remedy ("The deployment was stopped…") never applies. A refusal
  // without that fact (a scope change after the effect ran) claims nothing.
  const notAttempted = refused?.failure?.effectAttempted === false;
  const refusedReason = notAttempted && (refused?.code === 'cancelled' || !failure?.reason)
    ? props.provider ? t('projects.deployments.refusedNothingChanged', { place: keepNamesWhole(props.provider) })
      : t('projects.deployments.nothingChanged')
    : failure?.reason;
  const volumeFailure = volumeError ? presentActionFailureOutcome(volumeError, 'deployment') : null;
  const platform = props.provider ? keepNamesWhole(props.provider) : null;
  const resourceName = resource ? keepNamesWhole(resource.name) : null;
  const confirmTitle = resource && platform && resourceName
    ? choice === 'remove'
      ? target
        ? t('projects.deployments.platformLink.confirmDelete', { resource: resourceName })
        : t('projects.deployments.platformLink.confirmDeleteWithEnvironment', { name: props.name, resource: resourceName })
      : target
        ? t('projects.deployments.unlinkConfirm', { machine: resourceName })
        : t('projects.deployments.deleteConfirm', { name: props.name })
    : choice === 'detach'
      ? target
        ? t('projects.deployments.unlinkConfirmDetach', { machine })
        : t('projects.deployments.deleteConfirmDetach', { name: props.name })
      : target
        ? t('projects.deployments.unlinkConfirm', { machine })
        : props.running
          ? t('projects.deployments.deleteConfirmRemove', { name: props.name })
          : t('projects.deployments.deleteConfirm', { name: props.name });
  // The volumes this removal deletes, by the names the person typed; said as a fact before and as the outcome after.
  const deletedVolumes = choice === 'remove' && volumeReview
    ? volumeReview.filter(volume => volumeChoices[volume.name] === 'delete').map(volume => volumeDisplayName(volume.name)) : [];
  const keptVolumes = choice === 'remove' && volumeReview
    ? volumeReview.filter(volume => volumeChoices[volume.name] !== 'delete').map(volume => volumeDisplayName(volume.name)) : [];
  const { onClose, onApproval, onDone, run } = props;
  const confirm = async () => {
    if (busy || (choice === 'remove' && (!props.canRemove || !domainsReady || !volumesReady || !volumesConfirmed || !resourceConfirmed))) return;
    setBusy(true);
    setRefused(null);
    const outcome = await run(choice, choice === 'remove' && volumeReview ? volumeReview.map(volume =>
      volumeChoices[volume.name] === 'delete'
        // The person types the volume's own name (R15-D9: never Compose's 70-character project prefix); having typed
        // it, the request carries the exact volume it confirmed.
        ? { name: volume.name, disposition: 'delete', confirmation: volume.name }
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
      } else if (choice === 'remove' && outcome.kind === 'deleted') {
        // The Environment and its receipts leave with it, so what went is said once here, before its page closes.
        const stopped = props.running && props.services?.length ? props.services.join(', ') : null;
        if (stopped || deletedVolumes.length || keptVolumes.length) {
          await Modal.alertAsync(t('projects.deployments.removedOutcomeTitle', { name: props.name }), [
            stopped ? t('projects.deployments.removedOutcomeStopped', { services: stopped }) : null,
            deletedVolumes.length ? t('projects.deployments.removedOutcomeDeleted',
              { names: deletedVolumes.join(', '), count: deletedVolumes.length }) : null,
            // A kept volume is named too, so the person knows its data is still on the Machine (R20-D4).
            keptVolumes.length ? t('projects.deployments.removedOutcomeKept', { names: keptVolumes.join(', ') }) : null,
          ].filter(Boolean).join('\n\n'));
        }
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
        // Unlinking a provider target keeps everything running, so it is the plain primary; every removal is destructive.
        display={resource && target && choice === 'detach' ? 'default' : 'destructive'}
        titleNumberOfLines="complete"
        loading={busy}
        disabled={busy || (choice === 'remove' && (!props.canRemove || !domainsReady || !volumesReady || !volumesConfirmed || !resourceConfirmed))}
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

  // A removal says what stops in one line: its services, then the addresses that go with them.
  const domainNames = domains.result.items.flatMap(item => item.content.hostname ? [item.content.hostname] : []);
  const stopsValue = joinHappierFacts(
    props.services?.length ? props.services.join(', ') : null,
    domainNames.length > 0 ? t('projects.deployments.factStopsDomains', { domains: domainNames.join(', ') }) : null,
  );
  const facts: Array<Readonly<{ key: string; label: string; value: string }>> =
    resource
      // A provider resource's tile already says where it keeps running or what the provider deletes.
      ? choice === 'detach'
        ? [
            {
              key: 'stops',
              label: t('projects.deployments.factStops'),
              value: target
                ? t('projects.deployments.factStopsTargetValue', { name: props.name, machine })
                : t('projects.deployments.factStopsValue', { name: props.name }),
            },
            { key: 'secrets', label: t('projects.deployments.factSecrets'), value: t('projects.deployments.factSecretsValue') },
            { key: 'costs', label: t('projects.deployments.factCosts'), value: t('projects.deployments.factCostsValue', { machine }) },
          ]
        : [
            ...(stopsValue ? [{ key: 'stops', label: t('projects.deployments.factStops'), value: stopsValue }] : []),
            { key: 'keeps', label: t('projects.deployments.factKeeps'), value: t('projects.deployments.factKeepsValue') },
          ]
    : choice === 'detach'
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
          // What a removal stops and frees (lab `teardown/remove`), only where something ran.
          ...(props.running && stopsValue ? [{
            key: 'stops',
            label: t('projects.deployments.factStops'),
            value: stopsValue,
          }] : []),
          // The irreversible fact, as soon as a volume is set to Delete.
          ...(deletedVolumes.length ? [{
            key: 'deletes',
            label: t('projects.deployments.factDeletes'),
            value: t('projects.deployments.factDeletesValue', { names: deletedVolumes.join(', '), count: deletedVolumes.length }),
          }] : []),
          ...(props.running ? [{
            key: 'frees',
            label: t('projects.deployments.factFrees'),
            value: t('projects.deployments.factFreesValue', { machine }),
          }] : []),
          // A never-deployed Environment has no history or backups to keep.
          ...(props.neverDeployed ? [] : [{
            key: 'keeps',
            label: t('projects.deployments.factKeeps'),
            value: t('projects.deployments.factKeepsValue'),
          }]),
        ];
  // A lone "Keeps" is one sentence of the lead, not a bordered box without a control (R14-D9).
  const keepsOnly = facts.length === 1 && facts[0]!.key === 'keeps';

  const removeOption = props.canRemove ? [resource && platform && resourceName ? {
    id: 'remove' as const,
    icon: 'trash' as const,
    title: t('projects.deployments.platformLink.deleteTitle', { platform }),
    subtitle: t('projects.deployments.platformLink.deleteBody', { resource: resourceName, platform }),
  } : props.running ? {
    id: 'remove' as const,
    icon: 'stop-circle' as const,
    title: t('projects.deployments.deleteStopTitle'),
    subtitle: t('projects.deployments.deleteStopBody', { machine }),
  } : {
    // Nothing recorded running: the removal stops nothing, so it reads as the removal itself (PAGE-ACCEPT-176 R10-D13).
    id: 'remove' as const,
    icon: 'trash' as const,
    // The sheet's title and button already name it; the tile says the choice (R14-D9).
    title: t('common.delete'),
    subtitle: t('projects.deployments.deleteIdleBody', { name: props.name }),
  }] : [];
  return (
    <ListPresentationProvider value="page" pageInsets="contained">
    <View testID="project-deployments.disposition" style={deploymentSheetStyles.body}>
      <Text style={deploymentSheetStyles.lead}>
        {resource && platform && resourceName && props.canRemove
          ? t('projects.deployments.platformLink.removalLead', { resource: resourceName, platform })
          : props.provider && !props.canRemove
          ? t('projects.deployments.platformLink.detachLead', { name: resourceName ?? props.name, platform: props.provider })
          : props.running
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
            : props.neverDeployed ? t('projects.deployments.deleteLeadNeverDeployed')
            : t('projects.deployments.deleteLeadIdle', { name: props.name })}
        {keepsOnly ? <Text testID="project-deployments.disposition.fact.keeps">
          {` ${t('projects.deployments.deleteKeepsSentence')}`}</Text> : null}
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
          // One choice per line: beside its icon, a half-width tile wrapped each consequence into a tall column.
          maximumColumns={1}
          // The consequence is read whole before a destructive choice; a tile never cuts it short.
          subtitleLines={0}
          options={[
            // A provider's resource lists the choice that keeps it first; deleting it is the last, deliberate choice.
            ...(resource ? [] : removeOption),
            {
              id: 'detach',
              icon: 'link-break',
              title: platform ? t('projects.deployments.platformLink.keepTitle', { platform })
                : t('projects.deployments.deleteDetachTitle'),
              subtitle: resource && platform && resourceName && props.canRemove
                ? t(resource.role === 'data' ? 'projects.deployments.platformLink.keepBodyData'
                  : 'projects.deployments.platformLink.keepBody', { resource: resourceName, platform })
                : props.provider
                ? t('projects.deployments.platformLink.detachBody', { platform: props.provider })
                : target
                ? t('projects.deployments.unlinkDetachBody', { name: props.name, machine })
                : t('projects.deployments.deleteDetachBody', { name: props.name, machine }),
            },
            ...(resource ? removeOption : []),
          ]}
        />
      ) : null}
      {resource && platform && resourceName && choice === 'remove' ? <ItemGroup testID="project-deployments.disposition.resource"
        title={resource.consequence ?? t('projects.deployments.platformLink.deleteConsequence', { resource: resourceName, platform })}>
        <Item title={resourceConfirmation} accessoryLayout="adaptive"
          showChevron={false} rightElement={<FieldTextInput testID="project-deployments.disposition.resourceConfirmation"
            accessibilityLabel={resourceConfirmation ?? undefined} placeholder={resource.name} placeholderIsValue
            value={typedResource} editable={!busy} autoCapitalize="none" autoComplete="off"
            onChangeText={setTypedResource} />} />
      </ItemGroup> : null}
      {/* No named volumes: Keeps below already says what stays, so no separate empty Data card (PAGE-ACCEPT-176 R10-D13). */}
      {choice === 'remove' && props.reviewVolumes && volumeReview?.length !== 0 ? <ItemGroup title={t('projects.deployments.factData')}
        {...(volumeReview?.length ? { description: t('projects.deployments.factDataValue') } : {})}>
        {volumeReview === null ? <SurfaceStateCard size="line" kind={volumeError ? 'error' : 'loading'}
          testID={volumeError ? 'project-deployments.disposition.volumes.error' : undefined}
          title={volumeError ? t('projects.deployments.volumeReviewError') : t('projects.deployments.loading')}
          reason={volumeFailure?.reason ?? undefined}
          diagnosticCode={volumeFailure?.code}
          diagnosticDetail={volumeFailure?.technicalDetails.map(line => `${line.label}: ${line.value}`).join('\n')}
          action={volumeError ? { label: t('common.retry'), onPress: () => setVolumeError(null),
            testID: 'project-deployments.disposition.volumes.retry' } : undefined} /> : null}
        {volumeReview?.map(volume => <React.Fragment key={volume.name}>
          <SegmentedChoiceItem title={volumeDisplayName(volume.name)} disabled={busy}
            testIDPrefix={`project-deployments.disposition.volume.${volume.name}`}
            value={volumeChoices[volume.name] ?? 'keep'}
            options={[{ id: 'keep', label: t('common.keep') }, { id: 'delete', label: t('common.delete') }]}
            onChange={next => setVolumeChoices(previous => ({ ...previous, [volume.name]: next }))} />
          {volumeChoices[volume.name] === 'delete' ? <Item title={t('projects.deployments.volumeConfirmation', { name: volumeDisplayName(volume.name) })}
            accessoryLayout="adaptive" showChevron={false} rightElement={<FieldTextInput
              testID={`project-deployments.disposition.volume.${volume.name}.confirmation`}
              accessibilityLabel={t('projects.deployments.volumeConfirmation', { name: volumeDisplayName(volume.name) })}
              placeholder={volumeDisplayName(volume.name)} placeholderIsValue
              value={confirmations[volume.name] ?? ''} editable={!busy} autoCapitalize="none" autoComplete="off"
              onChangeText={text => setConfirmations(previous => ({ ...previous, [volume.name]: text }))} />} /> : null}
        </React.Fragment>)}
      </ItemGroup> : null}
        {facts.length === 0 || keepsOnly ? null : <ItemGroup
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
        </ItemGroup>}
      {domainInput ? <ItemGroup testID="project-deployments.disposition.domains" header="none">
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
          // Titled by what was chosen: deleting a provider resource names that resource, never an unlink.
          title={
            resourceName && choice === 'remove'
              ? t('projects.deployments.deleteRefused', { name: resourceName })
              : target
              ? t('projects.deployments.unlinkRefused', { machine: resourceName ?? machine })
              : t('projects.deployments.deleteRefused', { name: props.name })
          }
          reason={refusedReason ?? undefined}
          action={blockedId && props.recovery ? { label: t('projects.deployments.history'),
            testID: 'project-deployments.disposition.history', onPress: () => { props.onClose(); props.recovery!.onHistory(); } }
            // Nothing happened: the person is back on this same review and confirms again from here.
            : notAttempted ? { label: t('projects.deployments.reviewAgain'), testID: 'project-deployments.disposition.reviewAgain',
              onPress: () => setRefused(null) } : undefined}
          secondaryAction={blockedId && cancellation.canCancel ? { label: t('common.stop'),
            testID: 'project-deployments.disposition.stop', onPress: cancellation.pressCancel,
            busy: cancellation.press.running || cancellation.cancelRequested,
            disabled: cancellation.press.running || cancellation.cancelRequested || cancellation.press.reviewPending } : undefined}
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
  const machine = input.provider ?? input.machine ?? t('projects.deployments.aMachine');
  showDeploymentSheet({
    component: DeploymentDispositionSheet,
    props: input,
    title: input.subject.kind === 'target'
          ? input.providerResource
            ? input.canRemove
              ? t('projects.deployments.platformLink.removalTitle', { resource: keepNamesWhole(input.providerResource.name) })
              : t('projects.deployments.unlinkTitle', { machine: keepNamesWhole(input.providerResource.name) })
            : t('projects.deployments.unlinkTitle', { machine })
          : t('projects.deployments.deleteTitle', { name: input.name }),
    testID: 'project-deployments.disposition.modal',
  });
}
