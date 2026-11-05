import { normalizeWorkflowIngress } from '@happier-dev/protocol/workflows/workflowValidationV1';
import type { WorkflowTriggerAddRequestV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import type { TriggerTargetV1 } from '@happier-dev/protocol/workflows/triggers/triggerTargetV1';
import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows';
import type { WorkflowSessionAuthoringSelection } from '@happier-dev/protocol/workflows/workflowV1';
import type { z } from 'zod/mini';

import { t } from '@/text';

import { formatTriggerSummary } from './formatTriggerSummary';
import { buildSimpleScheduleCron } from './triggerSchedule';
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

const MACHINE_SERVICES_PLUGIN_ID = 'happier.machine.services';
const STARTER_EVENT: Readonly<Partial<Record<GuidedStarter, string>>> = {
  healthFailed: 'health-check-failed',
  deploymentFailed: 'deployment-failed',
};

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
  const localId = starter ? STARTER_EVENT[starter] : undefined;
  return {
    ...base,
    mode: 'propose',
    when: localId
      ? {
          kind: 'pluginEvent',
          value: null,
          eventRef: { pluginId: MACHINE_SERVICES_PLUGIN_ID, localId },
        }
      : createDefaultWhen('schedule'),
  };
}

type GuidedAddRequest = z.input<typeof WorkflowTriggerAddRequestV1Schema> &
  Readonly<{
    target: TriggerTargetV1;
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
  const first = t(
    `workflows.triggers.guided.prompt.${draft.mode === 'chain' ? 'investigate' : draft.mode}`,
    { subject, lookAt },
  );
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

/** "When API health check fails on eadc, an agent investigates and asks you before changing anything. You'll get an Inbox item." */
export function describeGuidedAutomation(
  draft: GuidedAutomationDraft,
  params: Readonly<{ subjectName: string; channelLabels: readonly string[] }>,
): string {
  const subject = params.subjectName;
  const trigger = buildTriggerDefinition({ when: draft.when, enabled: true, sessionId: null });
  const when =
    draft.when.kind === 'pluginEvent'
      ? t('workflows.triggers.guided.readBack.whenEvent', {
          event: draft.when.value?.displayLabel?.trim() || t('workflows.triggers.kind.pluginEvent'),
          subject,
        })
      : t('workflows.triggers.guided.readBack.whenSchedule', {
          schedule: trigger ? formatTriggerSummary(trigger) : t('workflows.triggers.summary.schedule'),
          subject,
        });
  const then = t(`workflows.triggers.guided.readBack.${draft.mode}`, { when });
  const tell =
    params.channelLabels.length === 0
      ? t('workflows.triggers.guided.readBack.tellInbox')
      : t('workflows.triggers.guided.readBack.tellChannels', { channels: params.channelLabels.join(', ') });
  return `${then} ${tell}`;
}
