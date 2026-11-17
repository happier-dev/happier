import type { IconName } from '@/components/ui/icons/Icon';
import { DEPLOYMENT_RECEIPT_EVENT_REFS_V1 } from '@happier-dev/protocol/deployments/deploymentReceiptEventsV1';
import type { DeploymentEnvironmentRefV1 } from '@happier-dev/protocol/deployments/deploymentEnvironmentRefV1';
import { HEALTH_CHECK_EVENT_REFS_V1 } from '@happier-dev/protocol/deployments/healthCheckV1';
import { createHealthCheckSourceInstanceIdV1 } from '@happier-dev/protocol/deployments/healthCheckSubjectV1';
import type { HealthCheckDomainSetupIntentV1 } from '@happier-dev/protocol/deployments/healthCheckSourceV1';
import type { PluginUiOpenAutomationEventRequestV1 } from '@happier-dev/protocol/plugins/ui';
import { getWorkflowStarterExamplesV1 } from '@happier-dev/protocol/workflows/builtins/examples';
import type { TriggerSubject } from './accountTriggerRows';
import { createDefaultWhen, readDeviceTimeZone, type TriggerWhenValue } from './sessionTriggerForm';
import { buildSimpleScheduleCron } from './triggerSchedule';

export type SubjectSentenceStarter = 'healthFailed' | 'deploymentFailed' | 'nightly';
type SubjectEventStarter = SubjectSentenceStarter | 'healthRecovered';

const STARTER_EVENT: Readonly<Partial<Record<SubjectEventStarter, PluginUiOpenAutomationEventRequestV1['eventRef']>>> = {
  healthFailed: HEALTH_CHECK_EVENT_REFS_V1.failed,
  healthRecovered: HEALTH_CHECK_EVENT_REFS_V1.recovered,
  deploymentFailed: DEPLOYMENT_RECEIPT_EVENT_REFS_V1.failed,
};

/** The page supplies its subject; the existing contributed setup owns configuring the source. */
export function subjectStarterEventSeed(
  starter: SubjectEventStarter | null,
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
  const health = starter === 'healthFailed' || starter === 'healthRecovered';
  if (health && params.subject?.kind === 'environment') {
    const subject = { kind: 'environment' as const, environmentId: params.subject.environmentId };
    return { eventRef, ...observer, sourceInstanceId: createHealthCheckSourceInstanceIdV1(subject),
      setupInput: { v: 1, subject, ...(params.domain ? { domain: params.domain } : {}) } };
  }
  if (health && params.subject?.kind === 'service') {
    const subject = { kind: 'machineService' as const,
      machineId: params.subject.machineId, serviceId: params.subject.serviceId };
    return { eventRef, sourceInstanceId: createHealthCheckSourceInstanceIdV1(subject), setupInput: { v: 1, subject } };
  }
  return undefined;
}

/** Ordinary editor intent; source configuration and durable Save remain with their existing owners. */
export function subjectStarterWhen(starter: SubjectEventStarter | null): TriggerWhenValue {
  if (starter === 'nightly') {
    const schedule = { repeat: 'daily' as const, hour: 3, minute: 0, day: 1 };
    return { kind: 'schedule', schedule, expression: buildSimpleScheduleCron(schedule), timezone: readDeviceTimeZone() };
  }
  const eventRef = starter ? STARTER_EVENT[starter] : undefined;
  return eventRef ? { kind: 'pluginEvent', value: null, eventRef } : createDefaultWhen('schedule');
}

/**
 * A subject page's suggested entries: an ordinary sentence starter, or `addCheck`, which opens the trigger editor at
 * the service's own health form (a service can have several checks, so it is always offered).
 */
export type SubjectTriggerStarter = SubjectSentenceStarter | 'addCheck' | 'scheduledJob' | 'deployOnPush';

/**
 * The one starter table every subject page's Triggers section suggests when it is empty: what usually needs
 * watching on a Machine, an Environment or a service. Pages add a subject's starters here (MACH-COMPOSE-1107 §0.2,
 * shared by the Machine service page and the Environment page) instead of keeping their own list.
 */
export const SUBJECT_TRIGGER_STARTERS: Readonly<Record<TriggerSubject['kind'], readonly SubjectTriggerStarter[]>> = {
  machine: ['healthFailed', 'nightly'],
  environment: ['deployOnPush', 'scheduledJob', 'deploymentFailed', 'healthFailed', 'nightly'],
  service: ['addCheck', 'healthFailed', 'nightly'],
};

/**
 * The starters that stay under a subject's triggers once it has some (O-MACH 11-07): a service keeps Add a check and
 * Investigate when health fails, because the section can't know which checks already exist (checks can be observed
 * from another Machine); the editor asks which health source to use.
 */
export const SUBJECT_TRIGGER_PERSISTENT_STARTERS: Readonly<Record<TriggerSubject['kind'], readonly SubjectTriggerStarter[]>> = {
  machine: [],
  environment: ['deployOnPush', 'scheduledJob'],
  service: ['addCheck', 'healthFailed'],
};

export const SUBJECT_TRIGGER_STARTER_GLYPH: Readonly<Record<SubjectTriggerStarter, IconName>> = {
  addCheck: 'plus',
  scheduledJob: 'clock',
  deployOnPush: 'rocket-launch',
  healthFailed: 'pulse',
  deploymentFailed: 'rocket-launch',
  nightly: 'moon',
};

export const SUBJECT_OPERATION_STARTERS = ['deploymentFailed', 'healthRecovered', 'restoreDrill'] as const;
export type SubjectOperationStarter = typeof SUBJECT_OPERATION_STARTERS[number];

/** Authoring only: the open Workflows editor owns the When catalog, configuration and eventual Action.
 * The drill keeps its existing disabled schedule and required isolated-destination inputs. */
export function buildSubjectOperationStarter(starter: SubjectOperationStarter,
    context: Parameters<typeof subjectStarterEventSeed>[1]) {
    if (starter === 'restoreDrill') {
        const example = getWorkflowStarterExamplesV1().find(example => example.key === 'restore-drill');
        if (!example) throw new Error('Missing built-in restore drill');
        return { kind: 'workflow' as const, example };
    }
    return { kind: 'sentence' as const, when: subjectStarterWhen(starter), eventSeed: subjectStarterEventSeed(starter, context) };
}
