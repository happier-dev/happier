import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { isProjectSetupTrustRequestV1, PROJECT_ACTION_INPUT_SCHEMAS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { ProjectSetupReviewV1Schema, type ProjectSetupReviewV1 } from '@happier-dev/protocol/actions/projectSetupConsentFailure';
import { ProjectExecutionChoiceV1Schema } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';
import { LocalServiceStartApprovalReviewV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { ProjectServiceRelocateInputV1Schema } from '@happier-dev/protocol/workspaces/projectServiceRelocationV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { HostReviewedChildrenPlanV1Schema } from '@happier-dev/protocol/actions/executor/hostReviewedChildrenV1';
import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import type { ProjectExecutionChoiceV1 } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

import { HappierApprovalFields, happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { CodeBlockView } from '@/components/ui/code/blocks/CodeBlockView';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import {
  useMachinePoolListForServer,
  useServerScopedMachine,
} from '@/sync/store/hooks';
import { t } from '@/text';
import { getMachineSentenceName } from '@/utils/sessions/machineDisplayNames';
import { listReviewedSetupCommands } from '@/components/projects/projectSetup/projectSetupEffectPresentation';
import { formatProjectInvocation } from '@/components/projects/projectSetup/projectScriptPresentation';
import { ProjectSetupReviewFacts } from '@/components/projects/projectSetup/ProjectSetupReview';
import { useApprovalFieldsLook } from './ActionApprovalFieldsCard';

export type ProjectCommandApprovalPresentation =
  | Readonly<{
      kind: 'exec';
      workspace: WorkspaceAddressV1;
      serverId: string;
      sourceMachineId: string;
      command: string;
      cwd: string;
      destination: Destination;
    }>
  | Readonly<{
      kind: 'script';
      workspace: WorkspaceAddressV1;
      serverId: string;
      sourceMachineId: string;
      name: string;
      destination: Destination;
    }>
  | Readonly<{
      /** Target-produced setup review; presentation never grants consent or executes it. */
      kind: 'setup';
      workspace: WorkspaceAddressV1;
      serverId: string;
      sourceMachineId: string;
      destination: Destination;
      setupReview: ProjectSetupReviewV1 | null;
      /** The agent asked for Until it changes: approving remembers this reviewed setup instead of only running it. */
      remembersConsent: boolean;
    }>
  | Readonly<{
      /** A declared service's current effect, disclosed by the starter before it launches (plan 22). */
      kind: 'service';
      serverId: string;
      sourceMachineId: string;
      /** The declared Service's name; the question and the decisions are about it. */
      name: string | null;
      command: string | null;
      destination: Destination;
      workspace?: WorkspaceAddressV1;
      setupReview?: ProjectSetupReviewV1;
      moveFromMachineId?: string;
      restart?: true;
    }>;
type Destination =
  | Readonly<{ kind: 'primary' }>
  | Readonly<{ kind: 'machine'; machineId: string }>
  | Readonly<{ kind: 'pool'; poolId: string }>;

/**
 * An agent's finite Project command waiting on the person's configurable Action approval (lab `s-agent`
 * ADHOC, plan 21 §6): the exact command, where it would run, what files it sees and as whom. It reads the
 * request's own strict Action input; it decides nothing and grants no setup consent.
 */
export function readProjectCommandApproval(
  approval: Pick<ApprovalRequest, 'actionId' | 'actionArgs'> & Partial<Pick<ApprovalRequest, 'preview'>>,
): ProjectCommandApprovalPresentation | null {
  if (approval.actionId === 'projects.service.relocate') {
    const move = ProjectServiceRelocateInputV1Schema.safeParse(approval.actionArgs);
    if (!move.success) return null;
    return { kind: 'service', serverId: move.data.workspace.serverId, sourceMachineId: move.data.sourceMachineId,
      moveFromMachineId: move.data.currentTarget.machineId, name: move.data.serviceName, command: null,
      destination: { kind: 'machine', machineId: move.data.selectedTarget.machineId },
      ...(move.data.setupReview ? { setupReview: move.data.setupReview } : {}) };
  }
  if (approval.actionId === 'localServices.launcher.start' || approval.actionId === 'localServices.actions.restartManaged') {
    const preview = isRecord(approval.preview) ? approval.preview : null;
    const restart = approval.actionId === 'localServices.actions.restartManaged';
    const content = restart ? isRecord(preview?.hostReviewedContent) ? preview.hostReviewedContent : null : preview;
    const review = LocalServiceStartApprovalReviewV1Schema.safeParse(content?.serviceStartReview);
    if (!review.success) return null;
    const children = restart ? HostReviewedChildrenPlanV1Schema.safeParse(preview?.hostReviewedChildren) : null;
    const matches = restart ? children?.success && children.data.children.some(child =>
      child.action === 'localServices.launcher.start' && sameStrictJsonValue(child.input, review.data.request))
      : sameStrictJsonValue(review.data.request, approval.actionArgs);
    if (!matches) return null;
    const source = review.data.request.workspace!;
    const target = review.data.target;
    const selection = review.data.request.declaration!.selection;
    return { ...readProjectServiceEffectApproval({ serverId: review.data.target.serverId,
      sourceMachineId: source.machineId, reviewedEffect: review.data.reviewedEffect,
      name: selection.kind === 'manifest' ? selection.name : selection.source.target }),
      kind: 'service', serverId: target.serverId, sourceMachineId: source.machineId,
      workspace: target, destination: sameStrictJsonValue(source, target) ? { kind: 'primary' }
        : { kind: 'machine', machineId: target.machineId },
      ...(restart ? { restart: true as const } : {}),
      ...(review.data.setup?.required ? { setupReview: review.data.setup } : {}) };
  }
  if (approval.actionId === 'projects.compute.exec') {
    const input = PROJECT_ACTION_INPUT_SCHEMAS_V1[
      'projects.compute.exec'
    ].safeParse(approval.actionArgs);
    if (!input.success) return null;
    const { workspace, executable, argv, cwd, choice } = input.data;
    return {
      kind: 'exec',
      workspace,
      serverId: workspace.serverId,
      sourceMachineId: workspace.machineId,
      command: formatProjectInvocation({ tool: executable, args: argv }),
      cwd,
      destination: readDestination(choice),
    };
  }
  if (approval.actionId === 'projects.prepare') {
    const input = PROJECT_ACTION_INPUT_SCHEMAS_V1['projects.prepare'].safeParse(approval.actionArgs);
    // Teardown is not a setup ask; it keeps the generic Action reading.
    if (!input.success || input.data.phase !== 'setup') return null;
    const reviewed = ProjectSetupReviewV1Schema.safeParse(isRecord(approval.preview) ? approval.preview.setupReview : undefined);
    const setupReview = reviewed.success && (input.data.expectedEffectDigest === undefined
      || input.data.expectedEffectDigest === reviewed.data.reviewedEffectDigest) ? reviewed.data : null;
    return {
      kind: 'setup',
      workspace: input.data.workspace,
      serverId: input.data.workspace.serverId,
      sourceMachineId: input.data.workspace.machineId,
      destination: { kind: 'primary' },
      setupReview,
      remembersConsent: isProjectSetupTrustRequestV1(approval.actionId, approval.actionArgs),
    };
  }
  if (approval.actionId === 'projects.script.run') {
    const input = PROJECT_ACTION_INPUT_SCHEMAS_V1[
      'projects.script.run'
    ].safeParse(approval.actionArgs);
    if (!input.success) return null;
    const { workspace, selection, choice } = input.data;
    const name =
      selection.kind === 'named'
        ? selection.name
        : `${selection.source.file}#${selection.source.target}`;
    return {
      kind: 'script',
      workspace,
      serverId: workspace.serverId,
      sourceMachineId: workspace.machineId,
      name,
      destination: readDestination(choice),
    };
  }
  return null;
}

/**
 * A declared service's reviewed effect (the starter's safe `reviewedEffect` DTO) as the same facts:
 * the exact command, where it runs, which files it sees. A worker copy names its concrete target.
 */
export function readProjectServiceEffectApproval(input: Readonly<{
  serverId: string;
  sourceMachineId: string;
  reviewedEffect: unknown;
  name?: string;
}>): Extract<ProjectCommandApprovalPresentation, { kind: 'service' }> {
  const effect = isRecord(input.reviewedEffect) ? input.reviewedEffect : {};
  const serviceEffect = isRecord(effect.serviceEffect) ? effect.serviceEffect : null;
  const command = listReviewedSetupCommands({ commands: [effect.command ?? serviceEffect?.command].filter(Boolean) })?.[0] ?? null;
  const target = isRecord(effect.target) && typeof effect.target.machineId === 'string' ? effect.target.machineId : null;
  const choice = ProjectExecutionChoiceV1Schema.safeParse(effect.choice);
  return {
    kind: 'service',
    serverId: input.serverId,
    sourceMachineId: input.sourceMachineId,
    name: input.name ?? null,
    command,
    destination: target && target !== input.sourceMachineId
      ? { kind: 'machine', machineId: target }
      : readDestination(choice.success ? choice.data : undefined),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readDestination(choice: ProjectExecutionChoiceV1 | undefined): Destination {
  if (!choice || choice.kind === 'primary') return { kind: 'primary' };
  return choice.destination.kind === 'machine'
    ? { kind: 'machine', machineId: choice.destination.machineId }
    : { kind: 'pool', poolId: choice.destination.poolId };
}

/**
 * The card's question: one-off commands, named Scripts and declared Services ask differently; a worker
 * is named as such. A Service starts where it will run, so its question names that machine.
 */
export function describeProjectCommandApprovalTitle(
  presentation: ProjectCommandApprovalPresentation,
  sourceMachineName: string,
  runsOnMachineName: string = sourceMachineName,
  moveFromMachineName: string = sourceMachineName,
): string {
  if (presentation.kind === 'service' && presentation.moveFromMachineId)
    return t('projectServices.moveConfirm', { service: presentation.name ?? '', from: moveFromMachineName, to: runsOnMachineName });
  if (presentation.kind === 'service' && presentation.restart && presentation.name)
    return t('localServices.effectReview.restartTitle', { service: presentation.name });
  // Remembered consent covers the Project on any of the person's machines, so its question names none.
  if (presentation.kind === 'setup')
    return presentation.remembersConsent
      ? t('projects.scripts.setup.agentAsksRememberedTitle')
      : t('projects.authoring.sessionAsk', { machine: sourceMachineName });
  if (presentation.kind === 'script')
    return t('projects.scripts.adhocRunScriptTitle', { name: presentation.name });
  if (presentation.kind === 'service' && presentation.name)
    return presentation.destination.kind === 'pool'
      ? t('localServices.effectReview.startTitle', { service: presentation.name })
      : t('localServices.effectReview.startTitleOn', { service: presentation.name, machine: runsOnMachineName });
  return presentation.destination.kind === 'primary'
    ? t('projects.scripts.adhocTitle')
    : t('projects.scripts.adhocTitleWorker');
}

/** The question and the decision labels of a Project approval, named by the machine, never its id. */
export function useProjectCommandApprovalTitle(presentation: ProjectCommandApprovalPresentation): string;
export function useProjectCommandApprovalTitle(presentation: ProjectCommandApprovalPresentation | null): string | null;
export function useProjectCommandApprovalTitle(
  presentation: ProjectCommandApprovalPresentation | null,
): string | null {
  const source = useServerScopedMachine(presentation?.serverId ?? null, presentation?.sourceMachineId ?? '');
  const runsOnId = presentation?.destination.kind === 'machine' ? presentation.destination.machineId : '';
  const runsOn = useServerScopedMachine(presentation?.serverId ?? null, runsOnId);
  const fromId = presentation?.kind === 'service' ? presentation.moveFromMachineId ?? '' : '';
  const from = useServerScopedMachine(presentation?.serverId ?? null, fromId);
  if (!presentation) return null;
  const sourceName = source ? getMachineSentenceName(source) : presentation.sourceMachineId;
  return describeProjectCommandApprovalTitle(presentation, sourceName,
    runsOnId ? (runsOn ? getMachineSentenceName(runsOn) : runsOnId) : sourceName,
    from ? getMachineSentenceName(from) : fromId || sourceName);
}

/** The two decisions a Project approval asks, in the words of the Scripts page (setup), the Services page (Start) or the command card. */
export function describeProjectCommandApprovalDecisions(
  presentation: ProjectCommandApprovalPresentation,
): Readonly<{ approve: string; reject: string }> {
  if (presentation.kind === 'service')
    return { approve: t(presentation.moveFromMachineId ? 'projectServices.move' : presentation.restart
      ? 'localServices.effectReview.restart' : 'localServices.effectReview.start'), reject: t('localServices.effectReview.notNow') };
  return presentation.kind === 'setup'
    ? {
        approve: presentation.remembersConsent ? t('projects.authoring.allowUntilChanged') : t('projects.scripts.setup.run'),
        reject: t('projects.scripts.setup.notNow'),
      }
    : { approve: t('projects.scripts.adhocRunOnce'), reject: t('projects.scripts.adhocDeny') };
}

export const ProjectCommandApprovalFacts = React.memo(
  function ProjectCommandApprovalFacts(
    props: Readonly<{
      presentation: ProjectCommandApprovalPresentation;
      testID: string;
    }>,
  ) {
    const { theme } = useUnistyles();
    const fieldsLook = useApprovalFieldsLook();
    const { presentation } = props;
    const destination = presentation.destination;
    const source = useServerScopedMachine(
      presentation.serverId,
      presentation.sourceMachineId,
    );
    const target = useServerScopedMachine(
      presentation.serverId,
      destination.kind === 'machine' ? destination.machineId : '',
    );
    const pools = useMachinePoolListForServer(presentation.serverId);
    const sourceName =
      source ? getMachineSentenceName(source) : presentation.sourceMachineId;
    const pool =
      destination.kind === 'pool'
        ? (pools?.find((candidate) => candidate.pool.id === destination.poolId)?.pool ??
          null)
        : null;
    const where =
      destination.kind === 'primary'
        ? sourceName
        : destination.kind === 'machine'
          ? (target ? getMachineSentenceName(target) : destination.machineId)
          : t('projects.scripts.adhocWherePool', {
              pool: pool?.name ?? destination.poolId,
            });
    const runsOn =
      destination.kind === 'primary'
        ? source
        : destination.kind === 'machine'
          ? target
          : null;
    const runsAs =
      runsOn?.isShared && runsOn.metadata?.username
        ? t('projects.scripts.adhocAsUser', {
            user: runsOn.metadata.username,
            machine: where,
          })
        : destination.kind === 'pool'
          ? t('projects.scripts.adhocAsYouAnywhere')
          : t('projects.scripts.adhocAsYou', { machine: where });
    const rows: ReadonlyArray<readonly [string, string, string]> = [
      ['where', t('projects.scripts.adhocWhere'), where],
      ...(presentation.kind === 'service' && !presentation.workspace
        ? []
        : [['checkout', t('common.path'), presentation.workspace!.rootPath] as const]),
      // A Service that starts where its checkout is runs from the Path above; only a copy elsewhere is news.
      ...(presentation.kind === 'service' && destination.kind === 'primary'
        ? []
        : [[
            'files',
            t('projects.scripts.adhocFiles'),
            destination.kind === 'primary'
              ? t('projects.scripts.adhocFilesHere')
              : t('projects.scripts.adhocFilesCopy', { machine: sourceName }),
          ] as const]),
      ['as', t('projects.scripts.adhocAs'), runsAs],
    ];
    return (
      <View style={styles.root} testID={props.testID}>
        {presentation.kind !== 'setup' && (presentation.kind !== 'service' || presentation.command) ? (
          <View testID={`${props.testID}.command`}>
            <CodeBlockView
              code={presentation.kind === 'script' ? presentation.name : `$ ${presentation.command}`}
              showHeaderRow={false}
              wrap
            />
          </View>
        ) : null}
        {presentation.kind === 'setup' && presentation.remembersConsent ? (
          <View testID={`${props.testID}.rememberedConsent`} style={styles.consent}>
            <Text variant="label" emphasis="semiBold" style={{ color: theme.colors.text.primary }}>
              {t('projects.scripts.setup.agentAsksRemembered')}
            </Text>
            <Text style={[styles.value, { color: theme.colors.text.secondary }]}>
              {t('projects.scripts.setup.agentAsksRememberedBody')}
            </Text>
          </View>
        ) : null}
        {presentation.kind === 'setup' ? (
          presentation.setupReview ? (
            // The same review anatomy as the Scripts page and the Session ask; the owner reads the effect.
            <ProjectSetupReviewFacts
              testID={`${props.testID}.review`}
              reviewedEffect={presentation.setupReview.reviewedEffect}
              machineName={sourceName}
              sharedRunAs={null}
            />
          ) : (
            <Text
              style={[styles.value, { color: theme.colors.text.tertiary }]}
              testID={`${props.testID}.stepsUnavailable`}
            >
              {t('projects.scripts.setup.stepsUnavailable')}
            </Text>
          )
        ) : null}
        {presentation.kind === 'service' && presentation.setupReview ? (
          <ProjectSetupReviewFacts testID={`${props.testID}.review`} reviewedEffect={presentation.setupReview.reviewedEffect}
            machineName={where} sharedRunAs={null} />
        ) : null}
        <HappierApprovalFields
          {...fieldsLook}
          density="page"
          testID={`${props.testID}.rows`}
          rows={rows.map(([key, label, value]) => ({ kind: 'value' as const, key, label, value }))}
        />
        {presentation.kind === 'exec' ? (
          <View
            style={[
              styles.note,
              { borderTopColor: theme.colors.border.subtle },
            ]}
          >
            <Icon name="info" size={12} color={theme.colors.text.tertiary} />
            <Text
              style={[styles.noteText, { color: theme.colors.text.tertiary }]}
            >
              {t('projects.scripts.adhocAllowedBy')}
            </Text>
          </View>
        ) : null}
      </View>
    );
  },
);

const styles = StyleSheet.create(() => ({
  root: { gap: 10 },
  consent: { gap: 2 },
  value: { ...Typography.default(), ...happierPageTextMetrics('rowDescription'), flex: 1, minWidth: 0 },
  note: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  noteText: { ...Typography.default(), ...happierPageTextMetrics('meta'), flex: 1, minWidth: 0 },
}));
