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
import { deployersLabel } from '@/components/projects/deployments/DeploymentDeployerFields';
import { PluginMark } from '@/components/settings/plugins/PluginMark';
import { Icon } from '@/components/ui/icons/Icon';
import { SetupSteps, type SetupStep } from '@/components/ui/setupBlocks/SetupSteps';
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
import { describeApprovalRequestFields, resolveApprovalVisualPreview } from './approvalFieldValues';
import { readApprovalPreviewSummary } from './actionApprovalPresentation';
import { readApprovalDocEditProposal } from './actionApprovalReview';
import { HandoffTargetConsequencesCard, describeHandoffTargetApproval } from './HandoffTargetConsequencesCard';
import { readApprovalTargetEndpointLabels } from './approvalEndpointLabels';
import { readResourceProposalApproval } from './resourceProposal/readResourceProposalApproval';
import { ResourceProposalOperandFacts } from './resourceProposal/ResourceProposalBody';
import { readResourceProposalTitle } from './resourceProposal/resourceProposalLabels';

export type ApprovalReviewFactsInput = Readonly<{
  actionId: ApprovalRequest['actionId'];
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
  const fields = React.useMemo(() => generic && props.fields === undefined ? describeApprovalRequestFields(request) : null, [generic, props.fields, request]);
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

/**
 * What a stepped draft asked to create, read from the exact operands its prepared review was made from (any edit
 * drops the prepared review, so these stay the reviewed facts). Carried approval reviews have no draft and omit it.
 */
export type DeploymentCreationReviewPlan = Readonly<{
  newProjectName: string | null;
  environment: Readonly<{ name: string; production: boolean; deployers: Parameters<typeof deployersLabel>[0] }>;
  runs: Readonly<{ kind: 'repository'; ref: string } | { kind: 'compose' } | { kind: 'image'; image: string } | { kind: 'app'; name: string }> | null;
  runsOn: Readonly<{ kind: 'machine'; machine: string }
    | { kind: 'platform'; platform: string; pluginId: string; machine: string; resource: 'create' | 'existing' }>;
  /** Create has answered (a refusal or an approval request): what was asked stays, what would follow goes. */
  answered: boolean;
}>;

/** The order things happen after Create, from what the prepared review creates (journey-deploy rev "What happens next"). */
export function deploymentCreationNextSteps(plan: DeploymentCreationReviewPlan): readonly SetupStep[] {
  const { runsOn } = plan;
  return [
    { key: 'create', title: plan.newProjectName ? t('newApp.deploy.plan.stepCreateProject', { name: plan.newProjectName })
      : t('newApp.deploy.plan.stepCreate'), detail: t('newApp.deploy.plan.stepCreateNote') },
    ...(runsOn.kind === 'platform' ? [{ key: 'link', title: runsOn.resource === 'create'
      ? t('newApp.deploy.plan.stepPlatformCreate', { platform: runsOn.platform })
      : t('newApp.deploy.plan.stepPlatformLink', { platform: runsOn.platform }) }] : []),
    { key: 'deploy', title: t('newApp.deploy.plan.stepDeploy'), detail: t('newApp.deploy.plan.stepDeployNote') },
  ];
}

/**
 * Both prepared drafts and carried reviews show the resolver's exact frozen defaults. A stepped draft also passes
 * its plan, and the defaults then read as the review's groups: what Happier creates, how it deploys, what happens next.
 */
export function DeploymentCreationReviewFacts(props: Readonly<{
  review: DeploymentEnvironmentCreationReviewV1;
  serverId: string | null;
  testID: string;
  plan?: DeploymentCreationReviewPlan;
}>) {
  const { review, testID, plan } = props;
  const builder = useServerScopedMachineLabel(props.serverId, review.creationDefaults.values.buildMachineId ?? null);
  const controller = useServerScopedMachineLabel(props.serverId, review.creationDefaults.values.controllerMachineId ?? null);
  const machineName = (id: string) => (id === review.creationDefaults.values.buildMachineId ? builder : controller) ?? t('approvals.machineNotKnown');
  const defaultsRows = renderDeploymentCreationDefaultsRows({ defaults: review.creationDefaults, machineName, testID: `${testID}.defaults` });
  const runsOn = plan?.runsOn;
  return <>
    {plan ? <ItemGroup testID={`${testID}.creates`} title={t('newApp.deploy.plan.createsTitle')}>
      {plan.newProjectName ? <Item testID={`${testID}.creates.project`} mode="info" icon={<Icon name="folder" />}
        title={t('newApp.deploy.plan.project', { name: plan.newProjectName })} subtitle={t('newApp.deploy.plan.projectNote')} /> : null}
      <Item testID={`${testID}.creates.environment`} mode="info" icon={<Icon name="rocket" />}
        title={t('newApp.deploy.plan.environment', { name: plan.environment.name })}
        subtitle={[plan.environment.production ? t('newApp.deploy.plan.production') : null,
          t('newApp.deploy.plan.deployers', { who: deployersLabel(plan.environment.deployers) })].filter(Boolean).join(' · ')} />
      {runsOn?.kind === 'platform' ? <Item testID={`${testID}.creates.platform`} mode="info"
        icon={<PluginMark title={runsOn.platform} pluginId={runsOn.pluginId} />}
        title={runsOn.resource === 'create' ? t('newApp.deploy.plan.platformCreate', { platform: runsOn.platform })
          : t('newApp.deploy.plan.platformLink', { platform: runsOn.platform })}
        subtitle={runsOn.resource === 'create' ? t('newApp.deploy.plan.platformCreateNote', { platform: runsOn.platform })
          : t('newApp.deploy.plan.platformLinkNote')} /> : null}
    </ItemGroup> : null}
    {plan?.answered ? null : <>
      {plan && runsOn ? <ItemGroup testID={`${testID}.defaults`} title={t('newApp.deploy.plan.howTitle')}>
        {plan.runs ? <Item testID={`${testID}.runs`} mode="info"
          icon={<Icon name={plan.runs.kind === 'repository' ? 'git-branch' : 'cube'} />}
          title={plan.runs.kind === 'repository' ? t('newApp.deploy.plan.buildsRef', { ref: plan.runs.ref })
            : plan.runs.kind === 'image' ? t('newApp.deploy.plan.runsImage', { image: plan.runs.image })
            : plan.runs.kind === 'app' ? t('newApp.deploy.plan.runsApp', { name: plan.runs.name })
            : t('newApp.deploy.plan.runsCompose')}
          subtitle={runsOn.kind === 'platform' ? t('newApp.deploy.plan.onPlatform', { platform: runsOn.platform, machine: runsOn.machine })
            : t('newApp.deploy.plan.onMachine', { machine: runsOn.machine })} /> : null}
        {defaultsRows}
      </ItemGroup> : <ItemGroup testID={`${testID}.defaults`} title={t('projects.deployments.creationReview.title')}
        description={t('projects.deployments.creationReview.description')}>
        {defaultsRows}
      </ItemGroup>}
      {review.copy?.included.length ? <ItemGroup title={t('projects.deployments.copy.include')}>
        {review.copy.included.map(value => <Item key={value} mode="info" title={value} />)}
      </ItemGroup> : null}
      {review.copy?.omitted.length ? <ItemGroup title={t('projects.deployments.copy.omit')}>
        {review.copy.omitted.map(value => <Item key={value} mode="info" title={value} />)}
      </ItemGroup> : null}
      {review.template ? <DeploymentTemplateFacts review={review.template} serverId={props.serverId} testID={`${testID}.template`} /> : null}
      {plan ? <ItemGroup title={t('newApp.deploy.plan.nextTitle')}><SectionContentRow>
        <SetupSteps testID={`${testID}.next`} steps={deploymentCreationNextSteps(plan)} />
      </SectionContentRow></ItemGroup> : null}
    </>}
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
