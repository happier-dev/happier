import { normalizeWorkflowIngress } from '@happier-dev/protocol/workflows/workflowValidationV1';
import type { WorkflowTriggerAddRequestV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import type { TriggerTargetV1 } from '@happier-dev/protocol/workflows/triggers/triggerTargetV1';
import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows';
import type { WorkflowSessionAuthoringSelection } from '@happier-dev/protocol/workflows/workflowV1';
import type { z } from 'zod/mini';
import { readApprovalProfileV1 } from '@happier-dev/protocol/actions/approvalProfiles';
import { DEPLOYMENT_RECEIPT_EVENT_REFS_V1, readDeploymentReceiptEventPendingObservationV1 } from '@happier-dev/protocol/deployments/deploymentReceiptEventsV1';
import type { DeploymentEnvironmentRefV1 } from '@happier-dev/protocol/deployments/deploymentEnvironmentRefV1';
import { HEALTH_CHECK_EVENT_REFS_V1 } from '@happier-dev/protocol/deployments/healthCheckV1';
import { createHealthCheckSourceInstanceIdV1 } from '@happier-dev/protocol/deployments/healthCheckSubjectV1';
import type { HealthCheckDomainSetupIntentV1 } from '@happier-dev/protocol/deployments/healthCheckSourceV1';
import type { PluginUiOpenAutomationEventRequestV1 } from '@happier-dev/protocol/plugins/ui';

import { t } from '@/text';

import { buildSimpleScheduleCron } from './triggerSchedule';
import type { TriggerSubject } from './accountTriggerRows';
import {
  NOTIFY_ME_ACTION_ID,
  buildTriggerDefinition,
  buildTriggerTarget,
  createDefaultWhen,
  readDeviceTimeZone,
  type TriggerWhenValue,
} from './sessionTriggerForm';

/**
 * "Set up an automation" (OPS-AUTOMATIONS-1102 D3): four questions — When, Look at, Then, Tell —
 * answered once and written as ONE ordinary Account trigger through `workflow.trigger.add`. The
 * answers become the trigger's own steps (an Agent prompt, optional fixer/reviewer steps and a Notify
 * me step) and its approval profile reference; nothing here stores the answers anywhere else.
 */

export const GUIDED_LOOK_AT = [
  'logs',
  'receipts',
  'health',
  'repository',
] as const;
export type GuidedLookAt = (typeof GUIDED_LOOK_AT)[number];

export const GUIDED_THEN_MODES = [
  'investigate',
  'propose',
  'apply',
  'chain',
] as const;
export type GuidedThenMode = (typeof GUIDED_THEN_MODES)[number];

/** The approval profile that enforces each Then at admission (D4); the prompt only says it in words. */
const GUIDED_APPROVAL_PROFILE: Readonly<Record<GuidedThenMode, string>> = {
  investigate: 'builtin:read-propose',
  propose: 'builtin:read-propose',
  apply: 'builtin:apply-safe',
  chain: 'builtin:apply-safe',
};

export type GuidedAutomationDraft = Readonly<{
  when: TriggerWhenValue;
  lookAt: readonly GuidedLookAt[];
  mode: GuidedThenMode;
  selection: WorkflowSessionAuthoringSelection | undefined;
  /** Notify me channels beyond the Inbox, which every Session result reaches anyway. */
  channels: readonly string[];
  /** A profile the person chose; until then the Then's own profile applies. */
  approvalProfileId?: string;
}>;

/** The approval profile the automation runs under (D4): the chosen one, else the Then's own. */
export function guidedApprovalProfileId(draft: GuidedAutomationDraft): string {
  return draft.approvalProfileId ?? GUIDED_APPROVAL_PROFILE[draft.mode];
}

export type GuidedStarter = 'healthFailed' | 'deploymentFailed' | 'nightly';

const STARTER_EVENT: Readonly<Partial<Record<GuidedStarter, PluginUiOpenAutomationEventRequestV1['eventRef']>>> = {
  healthFailed: HEALTH_CHECK_EVENT_REFS_V1.failed,
  deploymentFailed: DEPLOYMENT_RECEIPT_EVENT_REFS_V1.failed,
};

/** The page supplies its subject; the existing contributed setup owns configuring the source. */
export function guidedStarterEventSeed(
  starter: GuidedStarter | null,
  params: Readonly<{
    subject?: TriggerSubject;
    deploymentEnvironment?: DeploymentEnvironmentRefV1;
    controllerMachineId?: string;
    domain?: HealthCheckDomainSetupIntentV1;
  }>,
): PluginUiOpenAutomationEventRequestV1 | undefined {
  const eventRef = starter ? STARTER_EVENT[starter] : undefined;
  if (!eventRef) return undefined;
  const observer = params.controllerMachineId ? { monitoringMachineId: params.controllerMachineId } : {};
  if (starter === 'deploymentFailed' && params.deploymentEnvironment) {
    const { serverId, environmentId } = params.deploymentEnvironment;
    return { eventRef, ...observer, setupInput: { v: 1, serverId, environmentId } };
  }
  if (starter === 'healthFailed' && params.subject?.kind === 'environment') {
    const subject = { kind: 'environment' as const, environmentId: params.subject.environmentId };
    return { eventRef, ...observer, sourceInstanceId: createHealthCheckSourceInstanceIdV1(subject),
      setupInput: { v: 1, subject, ...(params.domain ? { domain: params.domain } : {}) } };
  }
  if (starter === 'healthFailed' && params.subject?.kind === 'service') {
    const subject = { kind: 'machineService' as const,
      machineId: params.subject.machineId, serviceId: params.subject.serviceId };
    return { eventRef, sourceInstanceId: createHealthCheckSourceInstanceIdV1(subject), setupInput: { v: 1, subject } };
  }
  return undefined;
}

export function guidedStarterDraft(
  starter: GuidedStarter | null,
  selection?: WorkflowSessionAuthoringSelection,
): GuidedAutomationDraft {
  const base = {
    lookAt: ['logs', 'receipts', 'health'] as const,
    selection,
    channels: [],
  };
  if (starter === 'nightly') {
    const schedule = { repeat: 'daily' as const, hour: 3, minute: 0, day: 1 };
    return {
      ...base,
      mode: 'investigate',
      when: {
        kind: 'schedule',
        schedule,
        expression: buildSimpleScheduleCron(schedule),
        timezone: readDeviceTimeZone(),
      },
    };
  }
  const eventRef = starter ? STARTER_EVENT[starter] : undefined;
  return {
    ...base,
    mode: 'propose',
    when: eventRef
      ? {
          kind: 'pluginEvent',
          value: null,
          eventRef,
        }
      : createDefaultWhen('schedule'),
  };
}

type GuidedAddRequest = z.input<typeof WorkflowTriggerAddRequestV1Schema> &
  Readonly<{
    target: TriggerTargetV1;
    project: WorkflowProjectTargetV1;
    approvalProfileId: string;
  }>;

function lookAtList(lookAt: readonly GuidedLookAt[]): string {
  return lookAt
    .map((entry) => t(`workflows.triggers.guided.lookAtOption.${entry}`))
    .join(', ');
}

/** The write for these answers, or null while one is unanswered (an unconfigured event, no Agent, nothing to read). */
export function buildGuidedAutomationRequest(
  draft: GuidedAutomationDraft,
  params: Readonly<{
    subjectName: string;
    project: WorkflowProjectTargetV1;
  }>,
): GuidedAddRequest | null {
  if (draft.lookAt.length === 0) return null;
  const trigger = buildTriggerDefinition({
    when: draft.when,
    enabled: true,
    sessionId: null,
  });
  if (trigger === null) return null;
  const subject = params.subjectName;
  const lookAt = lookAtList(draft.lookAt);
  const task = t(
    `workflows.triggers.guided.prompt.${draft.mode === 'chain' ? 'investigate' : draft.mode}`,
    { subject, lookAt },
  );
  const first = `${task}\n\n${t('workflows.triggers.guided.prompt.diagnosis')}`;
  const agentStep = buildTriggerTarget(
    {
      kind: 'sendPrompt',
      prompt: first,
      runsIn: { kind: 'newSession' },
      ...(draft.selection ? { selection: draft.selection } : {}),
    },
    'account',
  );
  if (agentStep?.kind !== 'inline' || draft.selection?.agentTarget == null)
    return null;
  const followUps =
    draft.mode === 'chain'
      ? [
          t('workflows.triggers.guided.prompt.chainFix'),
          t('workflows.triggers.guided.prompt.chainReview', { subject }),
        ]
      : [];
  const notify =
    draft.channels.length === 0
      ? []
      : [
          {
            kind: 'action',
            id: 'notify',
            actionId: NOTIFY_ME_ACTION_ID,
            input: {
              message: {
                kind: 'literal',
                value: t('workflows.triggers.guided.notifyMessage', {
                  subject,
                }),
              },
              channels: { kind: 'literal', value: [...draft.channels] },
            },
          },
        ];
  // The first step carries the Then's name, so its rows and Library entry say what it does.
  const [firstStep, ...restBlocks] = agentStep.definition.blocks;
  const named = firstStep?.kind === 'step' ? { ...firstStep, name: t(`workflows.triggers.guided.mode.${draft.mode}`) } : firstStep;
  const outcome = normalizeWorkflowIngress({
    ...agentStep.definition,
    blocks: [...(named ? [named] : []), ...restBlocks, ...followUps, ...notify],
  });
  if (outcome.kind !== 'parsed') return null;
  return {
    target: { kind: 'inline', definition: outcome.definition },
    project: params.project,
    trigger,
    executionTarget: { kind: 'session' },
    inputs: {},
    approvalProfileId: guidedApprovalProfileId(draft),
  };
}

export type GuidedAutomationReadBack = Readonly<{
  wake: NonNullable<ReturnType<typeof buildGuidedAutomationRequest>>['trigger'];
  project: WorkflowProjectTargetV1;
  deploymentEnvironment: DeploymentEnvironmentRefV1 | null;
  /** Presence comes from the Machine owner; null means it has not been read. */
  controller: Readonly<{ machineId: string; online: boolean | null }> | null;
  pendingObservation: ReturnType<typeof readDeploymentReceiptEventPendingObservationV1>;
  approval: ReturnType<typeof readApprovalProfileV1> | null;
  disclosure: Readonly<{ inbox: true; channelIds: readonly string[] }>;
}>;

/** Typed review for UI refinements. Inputs also have Action readers: workflow.trigger.list,
 * deployments.environments.get, machines.list and actions.policy.get ({ profiles: true }).
 * Unread Account settings do not pretend that a custom profile is missing. */
export function buildGuidedAutomationReadBack(
  draft: GuidedAutomationDraft,
  params: Parameters<typeof buildGuidedAutomationRequest>[1] & Readonly<{
    deploymentEnvironment?: DeploymentEnvironmentRefV1;
    controller?: GuidedAutomationReadBack['controller'];
    approvalSettings?: Parameters<typeof readApprovalProfileV1>[0];
  }>,
): GuidedAutomationReadBack | null {
  // Reviewing an already configured wake source does not require choosing its future Agent.
  // The write owner still refuses an incomplete workflow at Create.
  const trigger = buildTriggerDefinition({ when: draft.when, enabled: true, sessionId: null });
  if (!trigger) return null;
  return {
    wake: trigger,
    project: params.project,
    deploymentEnvironment: params.deploymentEnvironment ?? null,
    controller: params.controller ?? null,
    pendingObservation: trigger.kind === 'pluginEvent' && 'sourceConfig' in trigger
      ? readDeploymentReceiptEventPendingObservationV1(trigger.sourceConfig) : null,
    approval: params.approvalSettings === undefined ? null
      : readApprovalProfileV1(params.approvalSettings, guidedApprovalProfileId(draft)),
    disclosure: { inbox: true, channelIds: draft.channels },
  };
}
