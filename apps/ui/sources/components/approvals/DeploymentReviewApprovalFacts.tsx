import * as React from 'react';
import { DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1, DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1, DEPLOYMENT_ROLLBACK_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { DeploymentEnvironmentUpdatePatchV1Schema, type DeploymentEnvironmentUpdateInputV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { deploymentRevisionLabelV1 as deploymentRevisionLabel } from '@happier-dev/deployments';
import { formatHappierDataBytes, joinHappierFacts } from '@happier-dev/plugin-ui/presentation';
import { areDeploymentSourceLabelsEqualV1, DeploymentApprovalReviewV1Schema, DeploymentRemovalApprovalReviewV1Schema, type DeploymentRemovalReviewV1, type DeploymentApprovalReviewV1, type DeploymentFolderReviewRevisionV1, type DeploymentPlatformCreateReviewV1, type DeploymentMachineReviewV1, type DeploymentReviewRevisionV1, type DeploymentReviewRiskKindV1, type DeploymentReviewServiceV1, type DeploymentReviewV1 } from '@happier-dev/protocol/deployments/deploymentReviewV1';
import { readDeploymentDomainHostnameV1 } from '@happier-dev/protocol/deployments/deploymentDomainContentV1';
import { isLiteralLoopbackHostname} from '@happier-dev/protocol/server/urls/loopbackHostname';
import { type ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { readRecord } from '@happier-dev/protocol/inputs/inputRecords';

import { DeploymentVolumeRemovalFact } from '@/components/projects/deployments/DeploymentVolumeRemovalFact';
import { deploymentBindingSourceTitle } from '@/components/projects/deployments/deploymentBindingSource';
import { useEnvironmentName, useEnvironmentRecord } from '@/components/projects/deployments/useEnvironmentName';
import { useProjectSourceName } from '@/components/projects/sources/useProjectSources';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { useServerScopedMachine } from '@/sync/store/hooks';
import { ActionApprovalFieldsCard, type ApprovalFieldExtras, type ApprovalFieldsPresentation } from './ActionApprovalFieldsCard';
import { t } from '@/text';
import { getMachineSentenceName } from '@/utils/sessions/machineDisplayNames';

type PlatformReview =
  | Extract<DeploymentApprovalReviewV1, { platformRollback: unknown }>['platformRollback']
  | Extract<DeploymentApprovalReviewV1, { platformPromotion: unknown }>['platformPromotion'];

export type DeploymentReviewApproval = Readonly<{
  review: DeploymentReviewV1 | PlatformReview | DeploymentPlatformCreateReviewV1 | DeploymentRemovalReviewV1;
  /** A promotion wraps the destination's deploy review with the Compose document change it applies. */
  promotion: Readonly<{ composeChanges?: boolean; sourceRevision?: DeploymentReviewRevisionV1 }> | null;
}>;

/**
 * The reviewed effect the installed host attached to a deploy, rollback, promotion or provider create approval. It
 * reads through the Deployment Protocol schema, from the deploy preparation's `deploymentReview` or, for an Action
 * whose host-reviewed children carry it (a provider create), from that host content; anything else (another Action's
 * preview, an older host) is simply not a deploy review and the page keeps its generic reading.
 */
export function readDeploymentReviewApproval(
  approval: Pick<ApprovalRequest, 'preview'>,
): DeploymentReviewApproval | null {
  const preview = readRecord(approval.preview);
  const carried = preview.deploymentReview ?? readRecord(preview.hostReviewedContent).deploymentReview;
  if (carried === undefined) return null;
  // A teardown carries what it removes (the Deployments program's typed removal facts, 8e4e19f0122).
  const removal = DeploymentRemovalApprovalReviewV1Schema.safeParse(carried);
  if (removal.success) return { review: removal.data.removal, promotion: null };
  const parsed = DeploymentApprovalReviewV1Schema.safeParse(carried);
  if (!parsed.success) return null;
  if ('platformCreate' in parsed.data) return { review: parsed.data.platformCreate, promotion: null };
  if ('platformRollback' in parsed.data) return { review: parsed.data.platformRollback, promotion: null };
  if ('platformPromotion' in parsed.data) return { review: parsed.data.platformPromotion, promotion: {} };
  return 'deployment' in parsed.data
    ? {
        review: parsed.data.deployment,
        promotion: {
          sourceRevision: parsed.data.promotion.sourceRevision,
          composeChanges:
            parsed.data.promotion.previousDocument !==
            parsed.data.promotion.candidateDocument,
        },
      }
    : { review: parsed.data, promotion: null };
}

const REFERENCE_ROUTE_LABEL = {
  direct: 'projects.deployments.editors.referenceRouteDirect',
  relay: 'projects.deployments.editors.referenceRouteRelay',
  unknown: 'projects.deployments.editors.referenceRouteUnknown',
} as const;

/** Root-granting settings read first; a missing restart policy is only worth a mention. */
const RISK_KINDS: readonly DeploymentReviewRiskKindV1[] = [
  'privileged',
  'docker_socket',
  'host_network',
  'host_pid',
  'host_ipc',
  'additional_capabilities',
  'devices',
  'host_bind',
  'in_release_bind',
  'non_loopback_publish',
  'missing_reboot_restart_policy',
  'inspection_unknown',
];

function describeEngine(
  engine: DeploymentMachineReviewV1['target']['engine'],
): string | null {
  return engine === 'native'
    ? t('projects.deployments.review.engineNative')
    : engine === 'dockerDesktop'
      ? t('projects.deployments.review.engineDockerDesktop')
      : null;
}

function describeService(service: DeploymentReviewServiceV1): string {
  const copies = Number(service.replicas);
  return joinHappierFacts(
    copies > 1 ? t('projects.deployments.review.copies', { count: copies }) : null,
    ...service.ports.filter(port => port.published !== null).map(port => (
      port.bindAddress !== null && isLiteralLoopbackHostname(port.bindAddress)
        ? t('projects.deployments.review.portLocal', { port: String(port.published) })
        : t('projects.deployments.review.port', { port: String(port.published) }))),
    service.healthcheck === 'absent' ? t('projects.deployments.review.noHealthCheck') : null,
  );
}

type ReviewMachine = Readonly<{
  id: string | null;
  review: DeploymentMachineReviewV1;
}>;

/** Every Machine the reviewed deploy runs on, by id (a controller's runtime Machines, else the review's own). */
export function readDeploymentReviewMachineIds(review: DeploymentReviewApproval['review']): readonly string[] {
  if (isRemoval(review)) return review.placements?.map(placement => placement.machineId) ?? [];
  return readMachines(review).flatMap((machine) => (machine.id ? [machine.id] : []));
}

function readMachines(review: DeploymentReviewApproval['review']): readonly ReviewMachine[] {
  if ('platformName' in review || isRemoval(review)) return [];
  return review.runtimeMachines?.length
    ? review.runtimeMachines.map((machine) => ({
        id: machine.machineId,
        review: machine.review,
      }))
    : [{ id: review.machineId ?? null, review }];
}

function readRollbackData(review: DeploymentReviewApproval['review']): 'keep' | 'restoreBackup' | undefined {
  if (isRemoval(review)) return undefined;
  return 'platformName' in review ? ('data' in review ? review.data : undefined) : review.rollbackData;
}

/** A provider create has no version or Environment of its own yet: it reads as the resource it makes. */
function isPlatformCreate(review: DeploymentReviewApproval['review']): review is DeploymentPlatformCreateReviewV1 {
  return 'resourceName' in review;
}

/** A teardown: what it removes, never a version or a Machine of its own. */
export function isDeploymentRemovalReview(approval: DeploymentReviewApproval | null): boolean {
  return approval !== null && isRemoval(approval.review);
}

function isRemoval(review: DeploymentReviewApproval['review']): review is DeploymentRemovalReviewV1 {
  return 'subject' in review;
}

function describeRemovalProviderScope(scope: DeploymentRemovalReviewV1['providerScope']): string | null {
  return scope ? joinHappierFacts(scope.projectName, scope.environmentName) : null;
}

/** The rows a teardown's "What stays" section draws: the data it keeps, never listed as deleted (R19-D6). */
const REMOVAL_KEPT_PATH = 'removal.kept';

/** What a teardown deletes, where, and what goes with it, as the delete sheet said it before the request. */
function describeRemovalFields(removal: DeploymentRemovalReviewV1, names: MachineNames, projectName: string | null): ApprovalFieldsPresentation {
  const { subject } = removal;
  const providerScope = describeRemovalProviderScope(removal.providerScope);
  const domains = subject.kind === 'domain' ? [subject.hostname] : removal.domains ?? [];
  const describeVolume = ({ name, machineId }: NonNullable<DeploymentRemovalReviewV1['volumes']>[number]) =>
    machineId && names[machineId] && (removal.placements?.length ?? 0) > 1
      ? joinHappierFacts(name, names[machineId]) : name;
  const volumes = removal.volumes ?? [];
  const deleted = volumes.filter(volume => volume.removed).map(describeVolume);
  const kept = volumes.filter(volume => !volume.removed).map(describeVolume);
  // A volume name can still be the engine's handle: it keeps one line, its exact value under Technical details.
  const dataLine = { singleLine: true } as const;
  return { rows: [
    ...field('removal.project', t('capabilities.store.appPage.projectTitle'), projectName),
    ...field('removal.environment', t('projects.deployments.review.environment'), removal.environment, {
      note: removal.removeEnvironment ? t('projects.deployments.review.removalEnvironmentToo') : undefined,
    }),
    ...field('removal.where', t('projects.deployments.review.whereTitle'),
      subject.kind === 'platformResource' ? providerScope ?? subject.platform : null),
    ...removal.placements?.flatMap(({ machineId, services }, index) =>
      field(`removal.placement.${index}`, t('projects.deployments.machine'),
        names[machineId] ?? t('approvals.machineNotKnown'), { note: services?.join(', ') })) ?? [],
    ...field('removal.name', t('projects.deployments.review.createName'), subject.kind === 'platformResource' && !providerScope ? subject.name : null),
    ...domains.flatMap((hostname, index) => field(`removal.domains.${index}`, t('projects.deployments.domainFieldHost'), hostname, {
      note: t('projects.deployments.review.removalDomainStops'),
    })),
    ...field('removal.data', t('projects.deployments.factData'), deleted.length ? deleted.join(', ')
      : !kept.length && removal.placements?.length ? t('projects.deployments.factDataValue') : null, dataLine),
    ...field(REMOVAL_KEPT_PATH, t('projects.deployments.factData'), kept.join(', '), dataLine),
    ...volumes.map(({ name }, index) => ({ kind: 'value' as const, path: `removal.volumes.${index}`,
      title: t('projects.deployments.factData'), value: name, technical: true as const })),
  ], unrepresentable: null };
}

/** Display only: null hides a status read, undefined keeps the shared action title. */
export function describeDeploymentRemovalStepTitle(
  approval: DeploymentReviewApproval | null,
  step: Readonly<{ role: string; input?: unknown }>,
): string | null | undefined {
  if (!approval || !isRemoval(approval.review)) return undefined;
  const { subject, domains } = approval.review;
  switch (step.role) {
    case 'observe':
    case 'projects.observe':
      return null;
    case 'teardown':
    case 'projects.delete':
    case 'branches.delete':
      if (subject.kind !== 'platformResource') return undefined;
      return step.role === 'teardown' && subject.platform === 'Railway'
        ? t('projects.deployments.review.removalStepService', { name: subject.name })
        : t('projects.deployments.review.removalStepResource', {
          name: describeRemovalProviderScope(approval.review.providerScope) ?? subject.name,
        });
    case 'domains.remove':
    case 'disable': {
      const hostname = subject.kind === 'domain' ? subject.hostname
        : (domains?.length ?? 0) > 1 ? readDeploymentDomainHostnameV1(readRecord(readRecord(step.input).domain).hostname) : null;
      return hostname
        ? t('projects.deployments.review.decisionRemoveDomain', { hostname })
        : t('projects.deployments.review.removalStepItsDomain');
    }
    default:
      return undefined;
  }
}

/** What a provider create makes, where, and what it builds from. */
function describeCreateFields(create: DeploymentPlatformCreateReviewV1): ApprovalFieldsPresentation {
  const source = joinHappierFacts(create.repository ?? null, create.productionBranch ?? null) || null;
  return { rows: [
    // Where in Happier it links leads, as the deploy review leads with its Environment.
    ...field('create.environment', t('projects.deployments.review.environment'), create.environment?.name),
    ...field('create.where', t('projects.deployments.review.whereTitle'), create.platformName),
    ...field('create.name', t('projects.deployments.review.createName'), create.resourceName),
    ...field('create.source', t('projects.deployments.review.createSource'), source, {
      note: create.followsBranch && create.productionBranch
        ? t('projects.deployments.review.createFollowsBranch', { platform: create.platformName, branch: create.productionBranch })
        : undefined,
    }),
  ], unrepresentable: null };
}

// One name for a deployed version on every surface (PAGE-ACCEPT-176 R12-D4): its short id, as the Receipt, History and
// Roll back say it, through the one revision formatter.
const revisionText = deploymentRevisionLabel;

const selectSentenceName = (machine: Machine | null): string | null =>
  machine ? getMachineSentenceName(machine) : null;

/**
 * The Machine as the person knows it, read as a string so the page redraws on a rename and not on
 * every presence heartbeat of the Machine object. Null while this Home has no record of it: a raw id is never a name.
 */
function useReviewMachineName(serverId: string | null, machineId: string | null): string | null {
  const name = useServerScopedMachine(serverId, machineId ?? '', selectSentenceName);
  return machineId ? name : null;
}

type MachineNames = Readonly<Record<string, string>>;

/**
 * Names every Machine the review mentions, each as the person knows it, through the one server-scoped reader
 * (a rename redraws, a presence heartbeat does not). One link per Machine, so the hook count stays fixed.
 */
export function NamedMachines(props: Readonly<{
  serverId: string | null;
  ids: readonly string[];
  names?: MachineNames;
  children: (names: MachineNames) => React.ReactNode;
}>): React.ReactNode {
  const [id, ...rest] = props.ids;
  if (id === undefined) return props.children(props.names ?? {});
  return <NamedMachine {...props} id={id} rest={rest} />;
}

function NamedMachine(props: Readonly<{
  serverId: string | null;
  id: string;
  rest: readonly string[];
  names?: MachineNames;
  children: (names: MachineNames) => React.ReactNode;
}>) {
  const name = useReviewMachineName(props.serverId, props.id);
  // Only Machines this Home knows get a name; a value row says "a Machine this Home doesn't know yet", a sentence drops the name.
  const names = React.useMemo(() => (name ? { ...props.names, [props.id]: name } : props.names), [props.names, props.id, name]);
  return <NamedMachines serverId={props.serverId} ids={props.rest} names={names}>{props.children}</NamedMachines>;
}

export function describeDeploymentFolderReviewFiles(folder: DeploymentFolderReviewRevisionV1) {
  const unsupported = new Set(folder.unsupportedFilePaths);
  const reasons = new Map(folder.exclusionReasons?.map(({ path, reason }) => [path, reason]));
  const labels = {
    gitIgnore: t('workspaceSync.review.reasonGitIgnore'),
    repositoryMetadata: t('workspaceSync.review.reasonRepositoryMetadata'),
    env: t('projects.deployments.review.folderEnvExcluded'),
    symlink: t('projects.deployments.review.folderSymlinkExcluded'),
  };
  const excluded = folder.excludedPaths.map(path => {
    const reason = reasons.get(path);
    const label = unsupported.has(path) ? t('projects.deployments.review.folderUnsupportedFile')
      : reason === undefined ? null : labels[reason];
    return label ? `${path} (${label})` : path;
  });
  return [
    { key: 'folderFiles', label: t('projects.deployments.review.folderFiles'),
      value: t('projects.deployments.review.folderContents', { count: folder.fileCount,
        size: formatHappierDataBytes(folder.totalBytes, { kind: 'storage' }) }) },
    // Each path left out with its reason, as names: the shared value collapses a long list past a handful.
    { key: 'folderExcluded', label: t('projects.deployments.review.folderExcluded'),
      value: excluded.length ? excluded.join('\n') : t('projects.deployments.review.folderNoneExcluded'),
      ...(excluded.length ? { names: excluded } : {}) },
  ] satisfies ReadonlyArray<Readonly<{ key: string; label: string; value: string; names?: readonly string[] }>>;
}

const field = (path: string, title: string, value: string | null | undefined, extras: ApprovalFieldExtras = {}) =>
  value ? [{ kind: 'value' as const, path, title, value, ...(extras.names?.length ? { names: extras.names } : {}),
    ...(extras.note ? { note: extras.note } : {}), ...(extras.singleLine ? { singleLine: true } : {}) }] : [];

const sentences = (...parts: readonly (string | null | false | undefined)[]) => parts.filter(Boolean).join(' ') || undefined;

/** Where one Machine runs it: its name and engine, then (beneath) what the engine cannot do, in words. */
function describeMachine(name: string | null, review: DeploymentMachineReviewV1): Readonly<{ value: string | null; note?: string }> {
  const { target } = review;
  const value = joinHappierFacts(name, describeEngine(target.engine)) || null;
  const note = sentences(
    target.requiresAwakeComputerAndDockerDesktop && t('projects.deployments.review.awakeNote'),
    target.domains === 'unavailableDockerDesktop' && t('projects.deployments.review.domainsUnavailable'),
  );
  // Notes alone still say where it can run.
  return value ? { value, note } : { value: note ?? null };
}

/** The Machine a reader is told about by name: the only one, or none when several share the deploy. */
function soleMachineName(machines: readonly ReviewMachine[], names: MachineNames): string | null {
  const id = machines.length === 1 ? machines[0]!.id : null;
  return id ? names[id] ?? null : null;
}

/**
 * The review as approval fields (lab d3 review card): one row per fact, its name then its value, through the
 * shared approval-fields owner every Action approval reads with. Facts come from the host's review only.
 */
function describeReviewFields(
  approval: DeploymentReviewApproval,
  machines: readonly ReviewMachine[],
  names: MachineNames,
  collectorMachineId: string | null,
  projectName: string | null,
): ApprovalFieldsPresentation {
  const { review, promotion } = approval;
  if (isPlatformCreate(review)) return describeCreateFields(review);
  if (isRemoval(review)) return describeRemovalFields(review, names, projectName);
  const { environment, revision } = review;
  const reviewedVersion = promotion?.sourceRevision ?? revision;
  const replaces = 'replaces' in review ? review.replaces : undefined;
  const native = 'platformName' in review ? undefined : review;
  const platform = 'platformName' in review ? review : undefined;
  const { secretBindingNames, ownServer, onFailure } = native ?? {};
  const rollbackData = readRollbackData(review);
  const ingress = environment?.ingress;
  const nameOf = (id: string | null) => (id ? names[id] ?? null : null);
  const valueNameOf = (id: string | null) => (id ? names[id] ?? t('approvals.machineNotKnown') : null);
  const multiple = machines.length > 1;
  const soleMachine = soleMachineName(machines, names);
  const buildPlatforms = [...new Set(machines.flatMap(machine => machine.review.buildSupport?.requestedPlatforms ?? []))];
  const replacesNote = replaces === undefined ? undefined
    // Deploying the version that already serves is a redeploy; it does not "replace" itself.
    : replaces && areDeploymentSourceLabelsEqualV1(replaces.revision, revision) === true ? t('projects.deployments.review.replacesSame')
      : replaces ? t('projects.deployments.review.replacesNote', { revision: revisionText(replaces.revision) })
        : t('projects.deployments.review.replacesNothing');
  const rows = [
    // A promotion replaces what the destination serves: that note belongs to the Destination, not to the version (R12-D4).
    ...field('destination', t('projects.deployments.promotion.destination'), promotion ? environment?.name : null,
      { note: promotion ? replacesNote : undefined }),
    ...field('environment', t('projects.deployments.review.environment'), !promotion ? environment?.name : null),
    // What it replaces finishes the version's line (lab d3: "Replaces #38 · b81e0d4"); alone it keeps its own row.
    ...(reviewedVersion ? field('version', t('projects.deployments.review.version'), revisionText(reviewedVersion), {
      note: promotion ? undefined : replacesNote,
    }) : field('replaces', t('projects.deployments.review.replaces'), replaces === undefined ? null
      : replaces ? revisionText(replaces.revision) : t('projects.deployments.review.replacesNothing'))),
    ...(revision?.kind === 'folder' ? describeDeploymentFolderReviewFiles(revision)
      .flatMap((row) => field(row.key, row.label, row.value, 'names' in row ? { names: row.names } : {})) : []),
    ...field('secrets', t('projects.deployments.review.secrets'), secretBindingNames?.length ? secretBindingNames.join(', ') : null, {
      names: secretBindingNames,
      note: soleMachine ? t('projects.deployments.review.secretsNoteOn', { machine: soleMachine }) : t('projects.deployments.review.secretsNote'),
    }),
    ...field('buildPlatforms', t('projects.deployments.review.buildPlatforms'), buildPlatforms.join(', '), {
      note: t('projects.deployments.review.emulationCost'),
    }),
    ...(platform ? field('where.platform', t('projects.deployments.review.whereTitle'),
      joinHappierFacts(platform.platformName, platform.providerResourceId, platform.providerEnvironment)) : []),
    ...machines.flatMap((machine, index) => [
      ...(() => {
        const where = describeMachine(valueNameOf(machine.id), machine.review);
        return field(`where.${index}`, t('projects.deployments.review.whereTitle'), where.value, { note: where.note });
      })(),
      ...field(`services.${index}`,
        multiple && nameOf(machine.id)
          ? t('projects.deployments.review.servicesOn', { machine: nameOf(machine.id)! })
          : t('projects.deployments.review.servicesTitle'),
        machine.review.services.map((service) => joinHappierFacts(service.name, describeService(service) || null)).join('\n')),
    ]),
    ...field('telemetryCollector', t('projects.deployments.review.telemetryCollector'), valueNameOf(collectorMachineId),
      { note: t('projects.deployments.review.telemetryCollectorAtLaunch') }),
    ...(rollbackData ? field('rollbackData', t('projects.deployments.review.rollbackData'),
      rollbackData === 'restoreBackup' ? t('projects.deployments.review.rollbackDataRestored')
        : t('projects.deployments.review.rollbackDataKept')) : []),
    // How it is reached follows where it runs, as the lab places Domain; the version leads the facts.
    ...field('ingress', t('projects.deployments.review.reachedThrough'), ingress
      ? ingress.kind === 'cloudflareTunnel' ? t('projects.deployments.review.ingressTunnel') : valueNameOf(ingress.edgeMachineId)
      : null),
    ...(promotion && !platform ? field('promotion', t('projects.deployments.review.promotion'), [
      t('projects.deployments.review.promotionImages'),
      promotion.composeChanges ? t('projects.deployments.review.promotionCompose') : null,
    ].filter(Boolean).join(' ')) : []),
    ...(ownServer ? [
      ...field('rollout', t('projects.deployments.review.rollout'), t(`projects.deployments.review.rollouts.${ownServer.rollout}`)),
      // The migration leads; its backup and failure handling finish it beneath.
      ...field('beforeStart', t('projects.deployments.review.beforeStart'), ownServer.migration
        ? t('projects.deployments.review.migrationRuns', { service: ownServer.migration.service, command: ownServer.migration.argv.join(' ') })
        : null, { note: sentences(
        ownServer.backupBeforeMigration && t('projects.deployments.review.backupFirst'),
        ownServer.migrationFailurePolicy && t(`projects.deployments.review.migrationFails.${ownServer.migrationFailurePolicy}`),
      ) }),
      // A rollback's "previous release" would read as the version it goes back to: name the one that comes back (R14-D9).
      ...field('ifItFails', t('projects.deployments.review.ifItFails'), !ownServer.autoRestorePreviousRelease
        ? t('projects.deployments.review.staysDown')
        : replaces && areDeploymentSourceLabelsEqualV1(replaces.revision, revision) !== true
          ? t('projects.deployments.review.restoresVersion', { revision: revisionText(replaces.revision) })
          : t('projects.deployments.review.restoresPrevious')),
    ] : []),
    // The rollout choice the person made before requesting; reviewed as captured, changed only by asking again.
    // What happens when one Machine of several fails: a fleet choice, said only where there is a fleet (R12-D4).
    ...field('onFailure', t('projects.deployments.receipt.policy'), onFailure && multiple
      ? t(`projects.deployments.receipt.${onFailure}`) : null),
  ];
  return { rows, unrepresentable: null };
}

export type DeploymentReviewDecision = Readonly<{
  /** The decision as one sentence ("Deploy 7f3e2b1 to Production API"); the page's title. */
  title: string;
  /** What confirming does, in one line. */
  description: string;
  /** The approve button names the effect ("Deploy 7f3e2b1"). */
  approve: string | null;
}>;

export function readSoleDeploymentReviewMachineId(approval: DeploymentReviewApproval | null): string | null {
  const machines = approval ? readMachines(approval.review) : [];
  return machines.length === 1 ? machines[0]!.id : null;
}

/** The decision leads both an immediate confirmation and a saved approval, using the host's captured facts. */
export function describeDeploymentReviewDecision(
  approval: DeploymentReviewApproval | null,
  actionId: string | null,
  machine: string | null,
): DeploymentReviewDecision | null {
  if (!approval) return null;
  const { review } = approval;
  if (isPlatformCreate(review)) return {
    title: t('projects.deployments.review.decisionCreate', { name: review.resourceName, platform: review.platformName }),
    description: t('projects.deployments.review.consequence'),
    approve: t('projects.deployments.review.approveCreate', { name: review.resourceName }),
  };
  if (isRemoval(review)) {
    const { subject } = review;
    if (subject.kind === 'platformResource') {
      const providerScope = describeRemovalProviderScope(review.providerScope);
      return {
        title: providerScope ? t('projects.deployments.review.removalDeletesProviderScope', { scope: providerScope })
          : t('projects.deployments.review.decisionDeletePlatform', { name: subject.name, platform: subject.platform }),
        // The decision bar supplies the irreversible Action's footnote.
        description: t('projects.deployments.review.consequence'),
        approve: t('projects.deployments.platformLink.confirmDelete', { resource: providerScope ?? subject.name }),
      };
    }
    if (subject.kind === 'domain') return {
      title: t('projects.deployments.review.decisionRemoveDomain', { hostname: subject.hostname }),
      description: t('projects.deployments.review.consequence'),
      approve: t('projects.deployments.review.decisionRemoveDomain', { hostname: subject.hostname }),
    };
    if (!review.environment) return null;
    const removeOwn = t('projects.deployments.deleteConfirmRemove', { name: review.environment });
    return { title: removeOwn, description: t('projects.deployments.review.consequence'), approve: removeOwn };
  }
  const { revision, environment } = review;
  if (!revision || !environment) return null;
  const vars = { version: revisionText(approval.promotion?.sourceRevision ?? revision), environment: environment.name };
  const rollback = actionId === DEPLOYMENT_ROLLBACK_ACTION_ID_V1;
  const title = approval.promotion ? t('projects.deployments.review.decisionPromote', vars)
    : rollback ? t('projects.deployments.review.decisionRollback', vars)
      : t('projects.deployments.review.decisionDeploy', vars);
  const data = readRollbackData(approval.review);
  const description = rollback && data
    ? t(data === 'restoreBackup' ? 'projects.deployments.review.rollbackRestoresBackup' : 'projects.deployments.review.rollbackKeepsData', { machine })
    : machine ? t('projects.deployments.review.consequenceOn', { machine }) : t('projects.deployments.review.consequence');
  return {
    title,
    description,
    approve: approval.promotion ? t('projects.deployments.review.approvePromote', vars)
      : rollback ? t('projects.deployments.review.approveRollback', vars)
        : t('projects.deployments.review.approveDeploy', vars),
  };
}

/**
 * A backup setup review is titled by what that press does (R15-D3): a Test saves nothing, so it never reads as
 * "Configure deployment backups". The consequence sentence stays the Action's own summary.
 */
export function describeDeploymentBackupConfigureDecision(
  actionId: string | null,
  input: unknown,
): Readonly<{ title: string; approve: string }> | null {
  if (actionId !== DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1) return null;
  switch (readRecord(input).intent) {
    case 'test': return { title: t('projects.deployments.review.decisionBackupTest'), approve: t('projects.deployments.review.approveBackupTest') };
    case 'initializeAndSave': return { title: t('projects.deployments.review.decisionBackupInitialize'),
      approve: t('projects.deployments.review.approveBackupInitialize') };
    case 'save': return { title: t('projects.deployments.review.decisionBackupSave'), approve: t('projects.deployments.review.approveBackupSave') };
    default: return null;
  }
}

export function useDeploymentReviewDecision(
  approval: DeploymentReviewApproval | null,
  actionId: string | null,
  serverId: string | null,
): DeploymentReviewDecision | null {
  const machine = useReviewMachineName(serverId, readSoleDeploymentReviewMachineId(approval));
  return describeDeploymentReviewDecision(approval, actionId, machine);
}

/** Changed references and settings worth checking share one amber callout after the facts. */
function MachineRisks(props: Readonly<{ machine: ReviewMachine; name: string | null; multiple: boolean; decided: boolean; testID: string }>) {
  const { review } = props.machine;
  const risks = RISK_KINDS.flatMap((kind) => {
    const services = review.risks.filter((risk) => risk.kind === kind).map((risk) => risk.service);
    // An incomplete read can arrive without naming a service; it still has to be said.
    return services.length > 0 || (kind === 'inspection_unknown' && review.inspection === 'unknown')
      ? [{ kind, services: [...new Set(services)] }]
      : [];
  });
  const warnings = review.storage?.warnings ?? [];
  const referenceChanges = review.referenceChanges ?? [];
  const variableUseWarnings = review.variableUseWarnings ?? [];
  if (risks.length === 0 && warnings.length === 0 && referenceChanges.length === 0 && variableUseWarnings.length === 0) return null;
  const on = props.multiple && props.name ? { machine: props.name } : null;
  return (
    <AttentionBanner
      testID={props.testID}
      // Once decided there is nothing left to check: the same points stay, as what this review flagged.
      tone={props.decided ? 'neutral' : 'warning'}
      title={props.decided ? t('projects.deployments.review.risksNotedTitle')
        : on ? t('projects.deployments.review.risksOn', on) : t('projects.deployments.review.risksTitle')}
      points={[
        ...variableUseWarnings.map(warning => [
          { code: warning.name }, ' · ', t(warning.kind === 'unusedBinding'
            ? 'projects.deployments.editors.composeBindingUnused' : 'projects.deployments.editors.composeVariableUnbound'),
        ]),
        ...referenceChanges.map(change => [
          { code: change.name }, ' · ',
          t(change.phase === 'build' ? 'projects.deployments.phaseBuild' : 'projects.deployments.phaseRuntime'), ' · ',
          // The path the resolver observed for a Happier network address; a native-network address has none.
          ...(change.route?.kind === 'iroh' ? [t(REFERENCE_ROUTE_LABEL[change.route.observedPath]), ' · '] : []),
          t('projects.deployments.editors.referenceAddressChanged'),
        ]),
        // The service leads, as the lab reads it: "worker · Can control Docker on the host".
        ...risks.map((risk) => [
          ...(risk.services.length > 0 ? [{ code: risk.services.join(', ') }, ' · '] : []),
          t(`projects.deployments.review.risk.${risk.kind}`),
        ]),
        ...warnings.map((warning) => [
          warning.kind === 'writable_source'
            ? t('projects.deployments.review.writableSource', { service: warning.service, target: warning.target })
            : t('projects.deployments.review.concurrentWriters', {
                service: warning.service, target: warning.target, count: warning.replicas ?? 2,
              }),
        ]),
      ]}
    />
  );
}

/**
 * What an installed host says a deploy will do, before the person decides (lab d3 review): the facts as
 * approval fields — what deploys, where, what starts and how it rolls out — then the one callout for the
 * settings worth a second look. Nothing here is planned or inferred, and secret values never travel in it.
 */
export const DeploymentReviewApprovalFacts = React.memo(
  function DeploymentReviewApprovalFacts(
    props: Readonly<{
      approval: DeploymentReviewApproval;
      serverId: string | null;
      testID: string;
      /** The request is decided: the facts stay as a record and stop asking for a check. */
      decided?: boolean;
      /** The request's exact ids, kept one press away under Technical details. */
      technicalRows?: ApprovalFieldsPresentation['rows'];
    }>,
  ) {
    const { review } = props.approval;
    const machines = React.useMemo(() => readMachines(review), [review]);
    const removalProjectId = isRemoval(review) ? review.projectSourceId ?? null : null;
    const { binding } = useServerCredentialAccountScopeBinding(removalProjectId ? props.serverId : null);
    const projectName = useProjectSourceName(binding, removalProjectId);
    const collectorMachineId = machines.find(({ review }) => review.deferredTelemetryCollectorMachineId)
      ?.review.deferredTelemetryCollectorMachineId ?? null;
    const environment = !isRemoval(props.approval.review) && 'environment' in props.approval.review
      ? props.approval.review.environment : undefined;
    const ids = React.useMemo(() => {
      const ingress = environment?.ingress;
      return [...new Set([
        ...readDeploymentReviewMachineIds(review),
        ...(ingress?.kind === 'edgeCaddy' ? [ingress.edgeMachineId] : []),
        ...(collectorMachineId ? [collectorMachineId] : []),
      ])];
    }, [review, environment?.ingress, collectorMachineId]);
    return (
      <NamedMachines serverId={props.serverId} ids={ids}>
        {(names) => (
          <ReviewFields approval={props.approval} machines={machines} names={names} collectorMachineId={collectorMachineId} projectName={projectName}
            serverId={props.serverId} testID={props.testID} decided={props.decided === true} technicalRows={props.technicalRows} />
        )}
      </NamedMachines>
    );
  },
);

const ReviewFields = React.memo(function ReviewFields(props: Readonly<{
  approval: DeploymentReviewApproval;
  machines: readonly ReviewMachine[];
  names: MachineNames;
  collectorMachineId: string | null;
  projectName: string | null;
  serverId: string | null;
  testID: string;
  decided: boolean;
  technicalRows?: ApprovalFieldsPresentation['rows'];
}>) {
  const { presentation, kept } = React.useMemo(() => {
    const facts = describeReviewFields(props.approval, props.machines, props.names, props.collectorMachineId, props.projectName);
    const isKept = (row: ApprovalFieldsPresentation['rows'][number]) => row.kind === 'value' && row.path === REMOVAL_KEPT_PATH;
    const isTechnical = (row: ApprovalFieldsPresentation['rows'][number]) => row.kind === 'value' && row.technical === true;
    const keptRows = facts.rows.filter(isKept);
    // Technical details close the last section the review draws, so the exact ids sit after every fact they name.
    const technical = [...facts.rows.filter(isTechnical), ...props.technicalRows ?? []];
    const factRows = facts.rows.filter(row => !isKept(row) && !isTechnical(row));
    return keptRows.length
      ? { presentation: { ...facts, rows: factRows }, kept: { rows: [...keptRows, ...technical], unrepresentable: null } }
      : { presentation: { ...facts, rows: [...factRows, ...technical] }, kept: null };
  }, [props.approval, props.machines, props.names, props.collectorMachineId, props.projectName, props.technicalRows]);
  const multiple = props.machines.length > 1;
  return (
    <>
      <ActionApprovalFieldsCard presentation={presentation} anatomy="page" serverId={props.serverId}
        title={t(isPlatformCreate(props.approval.review) ? 'projects.deployments.review.createWhatTitle'
          : isRemoval(props.approval.review) ? 'projects.deployments.review.removalWhatTitle'
          : readRollbackData(props.approval.review) ? 'projects.deployments.review.rollbackWhatChanges'
            : 'projects.deployments.review.whatTitle')} testID={`${props.testID}.fields`} />
      {/* Kept data is its own section: listed under "What gets deleted" it read as deleted (R19-D6). */}
      {kept ? <ActionApprovalFieldsCard presentation={kept} anatomy="page" serverId={props.serverId}
        title={t('projects.deployments.review.removalKeptTitle')} testID={`${props.testID}.kept`} /> : null}
      {isRemoval(props.approval.review) ? <DeploymentVolumeRemovalFact phase="review" volumeRemoval={props.approval.review.volumeRemoval}
        serverId={props.serverId} testID={`${props.testID}.volumeRemoval`} /> : null}
      {props.machines.map((machine, index) => (
        <MachineRisks key={machine.id ?? 'host'} machine={machine} multiple={multiple} decided={props.decided}
          name={machine.id ? props.names[machine.id] ?? null : null}
          testID={multiple ? `${props.testID}.${index}.risks` : `${props.testID}.risks`} />
      ))}
    </>
  );
});

type EnvironmentUpdatePatch = NonNullable<DeploymentEnvironmentUpdateInputV1['patch']>;

/** An Environment update that changes what runs or what it connects to: its own admitted input is the exact effect. */
export type DeploymentEnvironmentUpdateApproval = Readonly<{
  environmentId: string;
  definition: EnvironmentUpdatePatch['definition'];
  bindings: EnvironmentUpdatePatch['bindings'];
}>;

/**
 * An Environment update approval reads as what it changes, from the request's own arguments (the exact effect it
 * runs with): no host review exists for it. Only a content change (its definition or its variables) reads this way;
 * a preview or a setting-only update keeps the generic reading.
 */
export function readDeploymentEnvironmentUpdateApproval(
  request: Readonly<{ actionId?: string | null; actionArgs?: unknown }>,
): DeploymentEnvironmentUpdateApproval | null {
  if (request.actionId !== DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1) return null;
  const args = readRecord(request.actionArgs);
  if (args.mode !== undefined || typeof args.environmentId !== 'string') return null;
  const patch = DeploymentEnvironmentUpdatePatchV1Schema.safeParse(args.patch);
  if (!patch.success || (!patch.data.definition && !patch.data.bindings)) return null;
  return { environmentId: args.environmentId, definition: patch.data.definition, bindings: patch.data.bindings };
}

type EnvironmentNames = Readonly<Record<string, string>>;

/** Names every Environment the update's variables read from, one read each, so the hook count stays fixed. */
function NamedEnvironments(props: Readonly<{
  serverId: string | null;
  ids: readonly string[];
  names?: EnvironmentNames;
  children: (names: EnvironmentNames) => React.ReactNode;
}>): React.ReactNode {
  const [id, ...rest] = props.ids;
  if (id === undefined) return props.children(props.names ?? {});
  return <NamedEnvironment {...props} id={id} rest={rest} />;
}

function NamedEnvironment(props: Readonly<{
  serverId: string | null;
  id: string;
  rest: readonly string[];
  names?: EnvironmentNames;
  children: (names: EnvironmentNames) => React.ReactNode;
}>) {
  const { name } = useEnvironmentName(props.serverId, props.id);
  const names = React.useMemo(() => (name ? { ...props.names, [props.id]: name } : props.names), [props.names, props.id, name]);
  return <NamedEnvironments serverId={props.serverId} ids={props.rest} names={names}>{props.children}</NamedEnvironments>;
}

/** The facts an Environment update changes, consequences first: what stops, then what each variable reads. */
export function describeDeploymentEnvironmentUpdateFields(
  approval: DeploymentEnvironmentUpdateApproval,
  current: Readonly<{ name: string | null; services: readonly string[] | null }>,
  environmentNames: EnvironmentNames,
): ApprovalFieldsPresentation {
  const nextServices = approval.definition?.services;
  const removed = nextServices && current.services ? current.services.filter(service => !nextServices.includes(service)) : [];
  const added = nextServices && current.services ? nextServices.filter(service => !current.services!.includes(service)) : [];
  const set = (approval.bindings?.set ?? []).flatMap(binding => binding.purpose === 'variable' ? [binding] : []);
  const removedVariables = (approval.bindings?.remove ?? []).flatMap(binding => binding.purpose === 'variable' ? [binding] : []);
  return { rows: [
    ...field('environmentUpdate.environment', t('projects.deployments.review.environment'), current.name),
    ...field('environmentUpdate.removedServices', t('projects.deployments.review.updateRemovesServices'), removed.join(', '), {
      note: removed.length ? t('projects.deployments.review.updateRemovesServicesNote') : undefined }),
    ...field('environmentUpdate.addedServices', t('projects.deployments.review.updateAddsServices'), added.join(', ')),
    ...set.map((binding, index) => ({ kind: 'value' as const, path: `environmentUpdate.variables.${index}`, title: binding.name,
      value: deploymentBindingSourceTitle(binding, id => environmentNames[id] ?? null) })),
    ...removedVariables.map((binding, index) => ({ kind: 'value' as const, path: `environmentUpdate.removedVariables.${index}`,
      title: binding.name, value: t('projects.deployments.review.updateVariableRemoved') })),
    // The definition reads as one fact; its exact Compose text stays under Technical details.
    ...field('environmentUpdate.definition', t('projects.deployments.review.updateDefinition'),
      approval.definition ? t('projects.deployments.review.updateDefinitionChanged') : null),
  ], unrepresentable: null };
}

/**
 * An Environment update's approval (a Move's cutover, a Connect change): what changes, in words, through the same
 * fields card a deploy review uses. The request's exact ids, Compose text and secret references stay one press away
 * under Technical details.
 */
export const DeploymentEnvironmentUpdateApprovalFacts = React.memo(function DeploymentEnvironmentUpdateApprovalFacts(props: Readonly<{
  approval: DeploymentEnvironmentUpdateApproval;
  serverId: string | null;
  testID: string;
  technicalRows?: ApprovalFieldsPresentation['rows'];
}>) {
  const { approval } = props;
  const record = useEnvironmentRecord(props.serverId, approval.environmentId);
  const content = record.value?.content;
  const name = content?.name ?? null;
  const services = content ? content.definition.kind === 'stored' ? content.definition.services : null : null;
  const referenced = React.useMemo(() => [...new Set((approval.bindings?.set ?? []).flatMap(binding =>
    binding.purpose === 'variable' && binding.source.kind === 'reference' ? [binding.source.environmentId] : []))], [approval.bindings]);
  return <NamedEnvironments serverId={props.serverId} ids={referenced}>
    {(names) => <EnvironmentUpdateFields approval={approval} name={name} services={services} names={names}
      serverId={props.serverId} testID={props.testID} technicalRows={props.technicalRows} />}
  </NamedEnvironments>;
});

const EnvironmentUpdateFields = React.memo(function EnvironmentUpdateFields(props: Readonly<{
  approval: DeploymentEnvironmentUpdateApproval;
  name: string | null;
  services: readonly string[] | null;
  names: EnvironmentNames;
  serverId: string | null;
  testID: string;
  technicalRows?: ApprovalFieldsPresentation['rows'];
}>) {
  const presentation = React.useMemo(() => {
    const facts = describeDeploymentEnvironmentUpdateFields(props.approval, { name: props.name, services: props.services }, props.names);
    return { ...facts, rows: [...facts.rows, ...props.technicalRows ?? []] };
  }, [props.approval, props.name, props.services, props.names, props.technicalRows]);
  return <ActionApprovalFieldsCard presentation={presentation} anatomy="page" serverId={props.serverId}
    title={t('projects.deployments.review.updateWhatTitle')} testID={`${props.testID}.fields`} />;
});

/** The decision an Environment update leads with, once its Environment has a name ("Update Harbor QA"). */
export function describeDeploymentEnvironmentUpdateDecision(
  approval: DeploymentEnvironmentUpdateApproval | null,
  environmentName: string | null,
): string | null {
  return approval && environmentName ? t('projects.deployments.review.decisionUpdateEnvironment', { environment: environmentName }) : null;
}
