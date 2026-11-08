import * as React from 'react';
import { DEPLOYMENT_ROLLBACK_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';
import {
  DeploymentApprovalReviewV1Schema,
  type DeploymentMachineReviewV1,
  type DeploymentReviewRevisionV1,
  type DeploymentReviewRiskKindV1,
  type DeploymentReviewServiceV1,
  type DeploymentReviewV1,
} from '@happier-dev/deployment-protocol/v1';
import { isLiteralLoopbackHostname} from '@happier-dev/protocol/server/urls/loopbackHostname';
import { type ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';

import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { useServerScopedMachine } from '@/sync/store/hooks';
import { ActionApprovalFieldsCard, type ApprovalFieldExtras, type ApprovalFieldsPresentation } from './ActionApprovalFieldsCard';
import { t } from '@/text';
import { getMachineSentenceName } from '@/utils/sessions/machineDisplayNames';

export type DeploymentReviewApproval = Readonly<{
  review: DeploymentReviewV1;
  /** A promotion wraps the destination's deploy review with the Compose document change it applies. */
  promotion: Readonly<{ composeChanges: boolean }> | null;
}>;

/**
 * The reviewed effect the installed host attached to a deploy, rollback or promotion approval. It reads
 * through the Deployment Protocol schema; anything else (another Action's preview, an older host) is
 * simply not a deploy review and the page keeps its generic reading.
 */
export function readDeploymentReviewApproval(
  approval: Pick<ApprovalRequest, 'preview'>,
): DeploymentReviewApproval | null {
  const preview = approval.preview;
  if (
    typeof preview !== 'object' ||
    preview === null ||
    !('deploymentReview' in preview)
  )
    return null;
  const parsed = DeploymentApprovalReviewV1Schema.safeParse(
    preview.deploymentReview,
  );
  if (!parsed.success) return null;
  return 'deployment' in parsed.data
    ? {
        review: parsed.data.deployment,
        promotion: {
          composeChanges:
            parsed.data.promotion.previousDocument !==
            parsed.data.promotion.candidateDocument,
        },
      }
    : { review: parsed.data, promotion: null };
}

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
export function readDeploymentReviewMachineIds(review: DeploymentReviewV1): readonly string[] {
  return readMachines(review).flatMap((machine) => (machine.id ? [machine.id] : []));
}

function readMachines(review: DeploymentReviewV1): readonly ReviewMachine[] {
  return review.runtimeMachines?.length
    ? review.runtimeMachines.map((machine) => ({
        id: machine.machineId,
        review: machine.review,
      }))
    : [{ id: review.machineId ?? null, review }];
}

function revisionText(revision: DeploymentReviewRevisionV1): string {
  return revision.kind === 'repository'
    ? revision.sha.slice(0, 7)
    : t('projects.deployments.review.versionStored', { revision: revision.contentRevision });
}

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

const field = (path: string, title: string, value: string | null | undefined, extras: ApprovalFieldExtras = {}) =>
  value ? [{ kind: 'value' as const, path, title, value, ...(extras.names?.length ? { names: extras.names } : {}),
    ...(extras.note ? { note: extras.note } : {}) }] : [];

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
): ApprovalFieldsPresentation {
  const { review, promotion } = approval;
  const { environment, revision, replaces, secretBindingNames } = review;
  const ownServer = review.ownServer;
  const ingress = environment?.ingress;
  const nameOf = (id: string | null) => (id ? names[id] ?? null : null);
  const valueNameOf = (id: string | null) => (id ? names[id] ?? t('approvals.machineNotKnown') : null);
  const multiple = machines.length > 1;
  const soleMachine = soleMachineName(machines, names);
  const rows = [
    // The page's title already names the environment whenever it names the version (`useDeploymentReviewDecision`).
    ...field('environment', t('projects.deployments.review.environment'), revision ? null : environment?.name),
    // What it replaces finishes the version's line (lab d3: "Replaces #38 · b81e0d4"); alone it keeps its own row.
    ...(revision ? field('version', t('projects.deployments.review.version'), revisionText(revision), {
      note: replaces === undefined ? undefined
        : replaces ? t('projects.deployments.review.replacesNote', { revision: revisionText(replaces.revision) })
          : t('projects.deployments.review.replacesNothing'),
    }) : field('replaces', t('projects.deployments.review.replaces'), replaces === undefined ? null
      : replaces ? revisionText(replaces.revision) : t('projects.deployments.review.replacesNothing'))),
    ...field('secrets', t('projects.deployments.review.secrets'), secretBindingNames?.length ? secretBindingNames.join(', ') : null, {
      names: secretBindingNames,
      note: soleMachine ? t('projects.deployments.review.secretsNoteOn', { machine: soleMachine }) : t('projects.deployments.review.secretsNote'),
    }),
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
    // How it is reached follows where it runs, as the lab places Domain; the version leads the facts.
    ...field('ingress', t('projects.deployments.review.reachedThrough'), ingress
      ? ingress.kind === 'cloudflareTunnel' ? t('projects.deployments.review.ingressTunnel') : valueNameOf(ingress.edgeMachineId)
      : null),
    ...(promotion ? field('promotion', t('projects.deployments.review.promotion'), [
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
      ...field('ifItFails', t('projects.deployments.review.ifItFails'), ownServer.autoRestorePreviousRelease
        ? t('projects.deployments.review.restoresPrevious') : t('projects.deployments.review.staysDown')),
    ] : []),
    // The rollout choice the person made before requesting; reviewed as captured, changed only by asking again.
    ...field('onFailure', t('projects.deployments.receipt.policy'), review.onFailure
      ? t(`projects.deployments.receipt.${review.onFailure}`) : null),
  ];
  return { rows, unrepresentable: null };
}

export type DeploymentReviewDecision = Readonly<{
  /** The decision as one sentence ("Deploy 7f3e2b1 to Production API"); the page's title. */
  title: string;
  /** Its consequence: nothing changes until the person confirms. */
  description: string;
  /** The approve button names the effect ("Deploy 7f3e2b1"). */
  approve: string | null;
}>;

/**
 * What the deploy approval page leads with (lab d3 review): the decision and its consequence, read from the
 * host's review only. Null when the review does not name both the version and the environment, so the page
 * keeps the request's own title. Reads the one Machine it names through the server-scoped reader.
 */
export function useDeploymentReviewDecision(
  approval: DeploymentReviewApproval | null,
  actionId: string | null,
  serverId: string | null,
): DeploymentReviewDecision | null {
  const machines = approval ? readMachines(approval.review) : [];
  const soleId = machines.length === 1 ? machines[0]!.id : null;
  const machine = useReviewMachineName(serverId, soleId);
  if (!approval) return null;
  const { revision, environment } = approval.review;
  if (!revision || !environment) return null;
  const vars = { version: revisionText(revision), environment: environment.name };
  const rollback = actionId === DEPLOYMENT_ROLLBACK_ACTION_ID_V1;
  const title = approval.promotion ? t('projects.deployments.review.decisionPromote', vars)
    : rollback ? t('projects.deployments.review.decisionRollback', vars)
      : t('projects.deployments.review.decisionDeploy', vars);
  return {
    title,
    description: machine ? t('projects.deployments.review.consequenceOn', { machine }) : t('projects.deployments.review.consequence'),
    approve: approval.promotion ? t('projects.deployments.review.approvePromote', vars)
      : rollback ? t('projects.deployments.review.approveRollback', vars)
        : t('projects.deployments.review.approveDeploy', vars),
  };
}

/** Changed references and settings worth checking share one amber callout after the facts. */
function MachineRisks(props: Readonly<{ machine: ReviewMachine; name: string | null; multiple: boolean; testID: string }>) {
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
  if (risks.length === 0 && warnings.length === 0 && referenceChanges.length === 0) return null;
  const on = props.multiple && props.name ? { machine: props.name } : null;
  return (
    <AttentionBanner
      testID={props.testID}
      tone="warning"
      title={on ? t('projects.deployments.review.risksOn', on) : t('projects.deployments.review.risksTitle')}
      points={[
        ...referenceChanges.map(change => [
          { code: change.name }, ' · ',
          t(change.phase === 'build' ? 'projects.deployments.phaseBuild' : 'projects.deployments.phaseRuntime'), ' · ',
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
    }>,
  ) {
    const machines = React.useMemo(() => readMachines(props.approval.review), [props.approval.review]);
    const ids = React.useMemo(() => {
      const ingress = props.approval.review.environment?.ingress;
      return [...new Set([
        ...machines.flatMap((machine) => (machine.id ? [machine.id] : [])),
        ...(ingress?.kind === 'edgeCaddy' ? [ingress.edgeMachineId] : []),
      ])];
    }, [machines, props.approval.review.environment?.ingress]);
    return (
      <NamedMachines serverId={props.serverId} ids={ids}>
        {(names) => (
          <ReviewFields approval={props.approval} machines={machines} names={names}
            serverId={props.serverId} testID={props.testID} />
        )}
      </NamedMachines>
    );
  },
);

const ReviewFields = React.memo(function ReviewFields(props: Readonly<{
  approval: DeploymentReviewApproval;
  machines: readonly ReviewMachine[];
  names: MachineNames;
  serverId: string | null;
  testID: string;
}>) {
  const presentation = React.useMemo(
    () => describeReviewFields(props.approval, props.machines, props.names),
    [props.approval, props.machines, props.names],
  );
  const multiple = props.machines.length > 1;
  return (
    <>
      <ActionApprovalFieldsCard presentation={presentation} anatomy="page" serverId={props.serverId}
        title={t('projects.deployments.review.whatTitle')} testID={`${props.testID}.fields`} />
      {props.machines.map((machine, index) => (
        <MachineRisks key={machine.id ?? 'host'} machine={machine} multiple={multiple}
          name={machine.id ? props.names[machine.id] ?? null : null}
          testID={multiple ? `${props.testID}.${index}.risks` : `${props.testID}.risks`} />
      ))}
    </>
  );
});
