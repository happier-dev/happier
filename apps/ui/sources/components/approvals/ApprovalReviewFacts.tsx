import * as React from 'react';
import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { MachineDeploymentReferencesPageV1Schema } from '@happier-dev/protocol/machines/machineReferenceCensusV1';
import { MachineServicesListResultV1Schema } from '@happier-dev/protocol/actions/specs/machine/services';
import { readRecord } from '@happier-dev/protocol/inputs/inputRecords';
import { HandoffTargetReplacementApprovalV1Schema, type HandoffTargetReplacementApprovalV1 } from '@happier-dev/protocol/sessions/control/handoff/handoffTargetReplacementApprovalV1';
import { DeploymentEnvironmentCreationReviewV1Schema, type DeploymentEnvironmentCreationReviewV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentTemplateInstantiationReviewV1Schema, type DeploymentTemplateInstantiationReviewV1 } from '@happier-dev/protocol/deployments/deploymentTemplateInstantiationV1';

import { ArtifactEditProposalReview } from '@/components/artifacts/ArtifactEditProposal';
import { renderDeploymentCreationDefaultsRows } from '@/components/projects/deployments/DeploymentCreationDefaultsRows';
import { MACHINE_DEPLOYMENT_ROLES, machineServiceDisplayName } from '@/components/machines/services/machineServicesPresentation';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { CodeBlockView } from '@/components/ui/code/blocks/CodeBlockView';
import { DiffViewer } from '@/components/ui/code/diff/DiffViewer';
import { useServerScopedMachineLabel } from '@/sync/store/hooks';
import { DeploymentAddPortsFacts } from './DeploymentAddPortsFacts';
import { useServerScopedMachine } from '@/sync/domains/state/storage';
import { t } from '@/text';

import { ActionApprovalFieldsCard } from './ActionApprovalFieldsCard';
import { ApprovalIncludedSteps } from './ApprovalIncludedSteps';
import { ApprovalPreviewFacts, ApprovalPreviewSummary } from './ApprovalPreviewCard';
import { ApprovalVisualPreview } from './ApprovalVisualPreview';
import { ComputerActionApprovalCard, describeComputerActionApproval, type ComputerActionApproval } from './ComputerActionApprovalCard';
import { ComputerApprovalCapture } from './ComputerApprovalCapture';
import { DeploymentReviewApprovalFacts, readDeploymentReviewApproval } from './DeploymentReviewApprovalFacts';
import { ProjectCommandApprovalFacts, readProjectCommandApproval } from './ProjectCommandApprovalFacts';
import { describeApprovalActionFields, resolveApprovalVisualPreview } from './approvalFieldValues';
import { readApprovalPreviewSummary } from './actionApprovalPresentation';
import { readApprovalDocEditProposal } from './actionApprovalReview';
import { HandoffTargetConsequencesCard, describeHandoffTargetApproval } from './HandoffTargetConsequencesCard';
import { readApprovalTargetEndpointLabels } from './approvalEndpointLabels';
import { readResourceProposalApproval } from './resourceProposal/readResourceProposalApproval';
import { ResourceProposalOperandFacts } from './resourceProposal/ResourceProposalBody';
import { readResourceProposalTitle } from './resourceProposal/resourceProposalLabels';

export type ApprovalReviewFactsInput = Readonly<{
  actionId: string;
  actionArgs: unknown;
  preview: unknown;
  status?: ApprovalRequest['status'];
  serverId: string | null;
  testID: string;
}>;

/**
 * The facts of an admitted review, independent of an Artifact and of its answer lifecycle. Retained reviews
 * supply their existing choice controllers; immediate and in-step hosts carry the same frozen review facts.
 */
export function ApprovalReviewFacts(props: ApprovalReviewFactsInput & Readonly<{
  fields?: React.ComponentProps<typeof ActionApprovalFieldsCard> | null;
  computer?: ComputerActionApproval | null;
  onChooseComputerTarget?: () => void;
  handoffTarget?: React.ReactNode;
  resourceProposal?: React.ReactNode;
  decided?: boolean;
  /** The host may place the consequence sentence in its own header or Request section. */
  summaryPlacement?: 'body' | 'host';
  /** Retained visual surfaces keep the Artifact identity their existing presenter uses. */
  artifactId?: string;
}>) {
  const { actionId, actionArgs, preview, serverId, testID } = props;
  const request = React.useMemo(() => ({ actionId, actionArgs, preview, status: props.status }), [actionId, actionArgs, preview, props.status]);
  const deployment = React.useMemo(() => readDeploymentReviewApproval(request), [request]);
  const template = React.useMemo(() => readDeploymentTemplateApprovalReview(preview), [preview]);
  const creation = React.useMemo(() => {
    const parsed = DeploymentEnvironmentCreationReviewV1Schema.safeParse(readRecord(preview).deploymentReview);
    return parsed.success ? parsed.data : null;
  }, [preview]);
  const command = React.useMemo(() => deployment || template ? null : readProjectCommandApproval(request), [deployment, request, template]);
  const computer = React.useMemo(() => props.computer === undefined ? describeComputerActionApproval(request) : props.computer, [props.computer, request]);
  const edit = React.useMemo(() => readApprovalDocEditProposal(request), [request]);
  const visual = React.useMemo(() => resolveApprovalVisualPreview(request), [request]);
  const resource = React.useMemo(() => readResourceProposalApproval(request), [request]);
  const handoff = React.useMemo(() => HandoffTargetReplacementApprovalV1Schema.safeParse(readRecord(preview).handoffTargetReplacementApproval), [preview]);
  const generic = !deployment && !template && !command && !computer && !edit && !resource && !props.resourceProposal;
  const fields = React.useMemo(() => generic && props.fields === undefined ? describeApprovalActionFields(request) : null, [generic, props.fields, request]);
  const reboot = readRecord(readRecord(preview).machineRebootReview);
  return <>
    <ApprovalPreviewFacts request={request} serverId={serverId} />
    {props.summaryPlacement !== 'host' && !deployment && !template && !computer && readApprovalPreviewSummary(preview, request) ? (
      <ItemGroup><SectionContentRow testID={`${testID}.preview`}>
        <ApprovalPreviewSummary preview={preview} request={request} serverId={serverId} />
      </SectionContentRow></ItemGroup>
    ) : null}
    {visual ? <ApprovalVisualPreview preview={visual} artifactId={props.artifactId ?? testID} serverId={serverId} testID={`${testID}.visual`} /> : null}
    {deployment ? <DeploymentReviewApprovalFacts approval={deployment} serverId={serverId}
      testID={`${testID}.deployment-review`} decided={props.decided} /> : null}
    {template ? <DeploymentTemplateFacts review={template} serverId={serverId ?? null} testID={`${testID}.template`} /> : null}
    {creation ? <DeploymentCreationReviewFacts review={creation} serverId={serverId} testID={`${testID}.creation-review`} /> : null}
    {computer ? <ItemGroup title={t('computerUse.approval.sectionTitle')}><SectionContentRow>
      <ComputerActionApprovalCard presentation={computer} titled serverId={serverId} onChooseTarget={props.onChooseComputerTarget}
        media={<ComputerApprovalCapture presentation={computer} serverId={serverId} testID={`${testID}.computer-action-crop`} />} />
    </SectionContentRow></ItemGroup> : null}
    {props.handoffTarget ?? (handoff.success ? <PreparedHandoffTargetFacts approval={handoff.data} actionArgs={actionArgs} serverId={serverId} /> : null)}
    {props.resourceProposal ? props.resourceProposal : resource ? <ItemGroup title={readResourceProposalTitle(resource)} clipContent>
      <ResourceProposalOperandFacts model={resource} testID={`${testID}.resource-proposal`} />
    </ItemGroup> : command ? <ItemGroup title={t('approvals.details')}><SectionContentRow>
      <ProjectCommandApprovalFacts presentation={command} testID={`${testID}.project-command`} />
    </SectionContentRow></ItemGroup> : edit ? <ItemGroup title={t('approvals.details')}><SectionContentRow>
      <ArtifactEditProposalReview proposal={edit} testID={`${testID}.doc-edit-proposal`} />
    </SectionContentRow></ItemGroup> : generic ? props.fields === undefined && fields
      ? <ActionApprovalFieldsCard presentation={fields} request={request} anatomy="page" serverId={serverId} />
      : props.fields ? <ActionApprovalFieldsCard {...props.fields} /> : null : null}
    {reboot.kind === 'machineReboot' ? <PreparedMachineRebootFacts review={reboot} serverId={serverId} testID={`${testID}.reboot`} /> : null}
    <ApprovalIncludedSteps preview={preview} serverId={serverId} testID={`${testID}.included-steps`} />
  </>;
}

function PreparedHandoffTargetFacts(props: Readonly<{ approval: HandoffTargetReplacementApprovalV1; actionArgs: unknown; serverId: string | null }>) {
  const machine = useServerScopedMachine(props.serverId ?? props.approval.serverId, props.approval.machineId);
  const presentation = describeHandoffTargetApproval({
    approval: props.approval, actionArgs: props.actionArgs,
    // Native proofs carry the destination. Any source reference remains in the Action's canonical fields.
    source: { machineLabel: null, pathLabel: null },
    destination: readApprovalTargetEndpointLabels({ machineId: props.approval.machineId, machine: machine ?? null,
      canonicalRoot: props.approval.canonicalRoot }),
  });
  return <ItemGroup title={t('sessionHandoff.targetApproval.title')}><SectionContentRow>
    <HandoffTargetConsequencesCard presentation={presentation} />
  </SectionContentRow></ItemGroup>;
}

/** The installed template owner's review, carried in the same approval preview as a deploy review. */
function readDeploymentTemplateApprovalReview(preview: unknown): DeploymentTemplateInstantiationReviewV1 | null {
  const parsed = DeploymentTemplateInstantiationReviewV1Schema.safeParse(readRecord(preview).deploymentReview);
  return parsed.success ? parsed.data : null;
}

/** Both prepared drafts and carried reviews show the resolver's exact frozen defaults. */
export function DeploymentCreationReviewFacts(props: Readonly<{
  review: DeploymentEnvironmentCreationReviewV1;
  serverId: string | null;
  testID: string;
}>) {
  const { review, testID } = props;
  const builder = useServerScopedMachineLabel(props.serverId, review.creationDefaults.values.buildMachineId ?? null);
  const controller = useServerScopedMachineLabel(props.serverId, review.creationDefaults.values.controllerMachineId ?? null);
  const machineName = (id: string) => (id === review.creationDefaults.values.buildMachineId ? builder : controller) ?? t('approvals.machineNotKnown');
  return <>
    <ItemGroup testID={`${testID}.defaults`} title={t('projects.deployments.creationReview.title')}
      description={t('projects.deployments.creationReview.description')}>
      {renderDeploymentCreationDefaultsRows({ defaults: review.creationDefaults, machineName, testID: `${testID}.defaults` })}
    </ItemGroup>
    {review.copy?.included.length ? <ItemGroup title={t('projects.deployments.copy.include')}>
      {review.copy.included.map(value => <Item key={value} mode="info" title={value} />)}
    </ItemGroup> : null}
    {review.copy?.omitted.length ? <ItemGroup title={t('projects.deployments.copy.omit')}>
      {review.copy.omitted.map(value => <Item key={value} mode="info" title={value} />)}
    </ItemGroup> : null}
    {review.template ? <DeploymentTemplateFacts review={review.template} serverId={props.serverId} testID={`${testID}.template`} /> : null}
  </>;
}

function DeploymentTemplateFacts(props: Readonly<{
  review: DeploymentTemplateInstantiationReviewV1;
  serverId?: string | null;
  testID: string;
}>) {
  const { review, testID } = props;
  return <>
    <ItemGroup title={t('capabilities.store.appPage.reachTitle')}>
      <Item mode="info" title={t('projects.deployments.review.servicesTitle')} subtitle={review.services.join(', ')} />
      {review.profiles.length ? <Item mode="info" title={t('projects.deployments.editors.definitionProfiles')} subtitle={review.profiles.join(', ')} /> : null}
      {review.bindings.length ? <Item mode="info" title={t('projects.deployments.variablesTitle')} subtitle={review.bindings.map(binding => binding.name).join(', ')} /> : null}
      {review.generatedSecrets.length ? <Item mode="info" title={t('capabilities.store.appPage.secretsTitle', { count: review.generatedSecrets.length })}
        subtitle={review.generatedSecrets.map(secret => secret.name).join(', ')} /> : null}
      {review.domains.map(domain => <Item key={domain.key} mode="info" title={domain.hostname}
        subtitle={t('capabilities.store.appPage.addressBody', { service: domain.service, port: domain.containerPort })} />)}
    </ItemGroup>
    {review.firstRunSetup ? <AttentionBanner testID={`${testID}.first-run`} title={t('capabilities.store.appPage.firstRunTitle')}
      description={t('capabilities.store.appPage.firstRunBody')} /> : null}
    {review.capacity?.filter(capacity => capacity.state === 'shortfall').map(capacity => <AttentionBanner key={capacity.resource}
      testID={`${testID}.capacity.${capacity.resource}`} title={t(capacity.resource === 'memoryBytes'
        ? 'projects.deployments.addShortMemory' : 'projects.deployments.addShortDisk')} />)}
    {review.document ? <DeploymentAddPortsFacts document={review.document} services={review.services}
      serverId={props.serverId ?? null} machineId={review.creationDefaults?.values.controllerMachineId ?? null}
      testID={`${testID}.ports`} /> : null}
    {review.document ? <ItemGroup title="compose.yaml"><SectionContentRow>
      <CodeBlockView code={review.document} language="yaml" wrap />
    </SectionContentRow></ItemGroup> : null}
    {review.publicFiles?.map(file => <ItemGroup key={file.path} title={file.path}><SectionContentRow>
      <CodeBlockView code={file.content} wrap />
    </SectionContentRow></ItemGroup>)}
    {review.repositoryChange?.files.map(file => <ItemGroup key={file.path} title={file.path}><SectionContentRow>
      <DiffViewer mode="text" oldText={file.before ?? ''} newText={file.content ?? ''} filePath={file.path} />
    </SectionContentRow></ItemGroup>)}
  </>;
}

/** The reboot owner already gathered these facts. Reading them never re-probes or re-admits the Machine. */
function PreparedMachineRebootFacts(props: Readonly<{ review: Readonly<Record<string, unknown>>; serverId: string | null; testID: string }>) {
  const { review } = props;
  const references = MachineDeploymentReferencesPageV1Schema.safeParse(review.deploymentReferences);
  const services = MachineServicesListResultV1Schema.safeParse(review.services);
  const machine = useServerScopedMachineLabel(props.serverId,
    typeof review.machineId === 'string' ? review.machineId : null) ?? t('common.unknown');
  return <>
    <ItemGroup title={t('machineServices.roles.title')}>
      {!references.success || references.data.coverage === 'partial' ? <AttentionBanner testID={`${props.testID}.roles-unavailable`}
        title={t('machineServices.roles.unavailable', { machine })} /> : null}
      {references.success ? references.data.references.map(reference => <Item key={reference.id} mode="info" title={reference.name || t('common.unknown')}
        subtitle={MACHINE_DEPLOYMENT_ROLES.filter(role => reference.deploymentRoles?.includes(role)).map(role => t(`machineServices.roles.role.${role}`)).join(' · ')} />) : null}
    </ItemGroup>
    <ItemGroup title={t('projects.deployments.review.servicesTitle')}>
      {!services.success || services.data.kind === 'unavailable' ? <AttentionBanner testID={`${props.testID}.services-unavailable`}
        title={t('common.unavailable')} /> : services.data.services.map(service => <Item key={service.serviceId} mode="info"
          title={machineServiceDisplayName(service)} subtitle={t(`machineServices.state.${service.state}`)} />)}
    </ItemGroup>
  </>;
}
