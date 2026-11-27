import * as React from 'react';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { PluginContributionIdentityV1Schema, type PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { presentManagedAcquireStep } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';

import { useAppShellPluginUiDeclarationProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { createPluginProjectedActionTitleResolver } from '@/sync/domains/plugins/ui/actionPresentation';
import { usePluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { getTranslationValue, t, tLoose } from '@/text';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ActionApprovalFieldsCard, type ApprovalFieldsPresentation } from './ActionApprovalFieldsCard';
import { readApprovalActionTitle } from './approvalRequestTitle';
import { describeDeploymentRemovalStepTitle, NamedMachines, readDeploymentReviewApproval, readDeploymentReviewMachineIds } from './DeploymentReviewApprovalFacts';
import { useManagedMachineInventory } from '@/components/settings/machines/managed/useManagedMachineInventory';
import { describeRetention } from '@/components/settings/machines/managed/managedRetentionPresentation';

/**
 * `machineIds` null: the step has no input yet (its domain owner supplies it at deploy time). `keepsOn`: the step
 * keeps a managed allocation always on (the target-enable retention child), named by its own reviewed input.
 */
type IncludedStep = Readonly<{
  action: string | PluginContributionIdentityV1;
  role: string;
  input?: unknown;
  machineIds: readonly string[] | null;
  keepsOn: Readonly<{ homeId: string; managedId: string }> | null;
}>;

/** A reviewed retention change that makes the allocation stay until deleted (P41-R31), else null. */
function readKeepsOn(action: string | PluginContributionIdentityV1, input: unknown): IncludedStep['keepsOn'] {
  const record = action === 'machines.managed.retention.update' ? readObject(input) : null;
  return record && readObject(record.retention)?.kind === 'until-delete'
    && typeof record.homeId === 'string' && typeof record.managedId === 'string'
    ? { homeId: record.homeId, managedId: record.managedId } : null;
}

const readObject = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

/**
 * The Machines a step's own normalized input names, by the approval reader's rule that a `machineId` names a
 * Machine on every Action: the input's own `machineId` first, then nested ones (a checkout's, a destination's), each
 * once. Empty when the input names none (a deploy target role runs through its service, not a named Machine).
 */
function readStepMachineIds(input: unknown): readonly string[] {
  const ids: string[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(visit);
    const record = readObject(value);
    if (!record) return;
    const own = record.machineId;
    if (typeof own === 'string' && own && !ids.includes(own)) ids.push(own);
    for (const [key, nested] of Object.entries(record)) if (key !== 'machineId') visit(nested);
  };
  visit(input);
  return ids;
}

/**
 * The child steps the host folded into this approval (`preview.hostReviewedChildren`: each step's Action, role and,
 * once known, normalized input, which owns its Machine routing). A deployment's role steps are folded before their
 * input exists, so a step without input is still listed. All or nothing, as the executor's own reader admits the
 * plan: a plan it would not replay folds nothing, so the page names nothing.
 */
export function readApprovalIncludedSteps(preview: unknown): readonly IncludedStep[] {
  const plan = readObject(readObject(preview)?.hostReviewedChildren);
  if (!plan || !Array.isArray(plan.children) || Object.keys(plan).some((key) => key !== 'children')) return [];
  const children: readonly unknown[] = plan.children;
  const steps: IncludedStep[] = [];
  for (const child of children) {
    const entry = readObject(child);
    const builtIn = ActionIdSchema.safeParse(entry?.action);
    const plugin = builtIn.success ? null : PluginContributionIdentityV1Schema.safeParse(entry?.action);
    const action = builtIn.success ? builtIn.data : plugin?.success ? plugin.data : null;
    if (!action || typeof entry?.role !== 'string' || !entry.role
      || Object.keys(entry).some((key) => key !== 'action' && key !== 'role' && key !== 'input' && key !== 'scopeInput')) return [];
    const machineIds = readStepMachineIds(entry.input === undefined ? entry.scopeInput : entry.input);
    steps.push({ action, role: entry.role, input: entry.input,
      machineIds: entry.input === undefined && machineIds.length === 0 ? null : machineIds, keepsOn: readKeepsOn(action, entry.input) });
  }
  return steps;
}

/**
 * What else the person approves (SEC-APPRCHILD): each folded step by the name a person knows, on the Machine it
 * runs on, as one quiet fact group after the request's facts and before the decision. Nothing when none.
 * A step whose input names no Machine, or has no input yet, runs where the request decides: the reviewed deploy's
 * Machines when this approval carries them, else said in those words. Both cases read the same.
 */
export const ApprovalIncludedSteps = React.memo(function ApprovalIncludedSteps(props: Readonly<{
  preview: unknown;
  serverId: string | null;
  testID: string;
}>) {
  const { steps, reviewedMachineIds } = React.useMemo(() => {
    const included = readApprovalIncludedSteps(props.preview);
    const review = included.length ? readDeploymentReviewApproval({ preview: props.preview }) : null;
    return {
      steps: included.flatMap(step => {
        const title = describeDeploymentRemovalStepTitle(review, step);
        return title === null ? [] : [{ ...step, title }];
      }),
      reviewedMachineIds: review ? readDeploymentReviewMachineIds(review.review) : [],
    };
  }, [props.preview]);
  return steps.length === 0 ? null
    : <IncludedStepFields steps={steps} managedAcquire={readObject(props.preview)?.actionId === 'machines.managed.acquire'}
        reviewedMachineIds={reviewedMachineIds} serverId={props.serverId} testID={props.testID} />;
});

const IncludedStepFields = React.memo(function IncludedStepFields(props: Readonly<{
  steps: readonly (IncludedStep & Readonly<{ title?: string }>)[];
  managedAcquire: boolean;
  reviewedMachineIds: readonly string[];
  serverId: string | null;
  testID: string;
}>) {
  const projection = useAppShellPluginUiDeclarationProjection();
  const localize = usePluginLocalizedTextResolver({ projection });
  const titles = React.useMemo(() => {
    const resolveActionTitle = createPluginProjectedActionTitleResolver(projection);
    return props.steps.map(({ action, role, keepsOn, title }) => {
      if (title !== undefined) return title;
      // The outcome a person approves ("always on"), not the generic "change when a machine stops".
      if (keepsOn) return t('approvals.includedStepKeepAlwaysOn');
      if (typeof action === 'string') return readApprovalActionTitle(action) ?? t('approvals.includedStepUnnamed');
      const actionTitle = resolveActionTitle(action);
      if (actionTitle !== undefined) return localize(action.pluginId, actionTitle);
      const step = props.managedAcquire ? presentManagedAcquireStep(role) : null;
      if (step) return typeof getTranslationValue(step.labelKey) === 'string' ? tLoose(step.labelKey) : step.label;
      const plugin = projection?.installedPackagesById[action.pluginId]?.displayName;
      return plugin ? t('approvals.includedStepFromPlugin', { plugin }) : t('approvals.includedStepUnnamed');
    });
  }, [props.steps, props.managedAcquire, projection, localize]);
  const stepMachineIds = React.useMemo(() => props.steps.map((step) => (
    step.machineIds?.length ? step.machineIds : props.reviewedMachineIds)), [props.steps, props.reviewedMachineIds]);
  const ids = React.useMemo(() => [...new Set(stepMachineIds.flat())], [stepMachineIds]);
  return (
    <NamedMachines serverId={props.serverId} ids={ids}>
      {(names) => {
        // Several Machines this Home does not know read once, not once each. Null: the request decides.
        const places = stepMachineIds.map((ids) => ids.length > 0
          ? [...new Set(ids.map((id) => names[id] ?? t('approvals.machineNotKnown')))].join(', ') : null);
        // Every step runs in one place (a Create's steps all run on the machine it makes): say it once, above the steps.
        if (places.every((place) => place === places[0])) return (
          <ItemGroup title={t('approvals.includedStepsTitle')} testID={props.testID}
            description={places[0] === null ? t('approvals.includedStepsDescriptionRequestMachine')
              : t('approvals.includedStepsDescriptionOnMachine', { machine: places[0]! })}>
            {titles.map((title, index) => {
              const keepsOn = props.steps[index]!.keepsOn;
              const testID = `${props.testID}.rows.row:step.${index}`;
              return keepsOn ? <KeepsOnStep key={`step.${index}`} title={title} serverId={props.serverId} {...keepsOn} testID={testID} />
                : <Item key={`step.${index}`} title={title} mode="info" showChevron={false} testID={testID} />;
            })}
          </ItemGroup>
        );
        const presentation: ApprovalFieldsPresentation = {
          rows: props.steps.map((step, index) => ({ kind: 'value' as const, path: `step.${index}`, title: titles[index]!,
            value: places[index] ?? t('approvals.includedStepMachineFromRequest') })),
          unrepresentable: null,
        };
        return (
          <ActionApprovalFieldsCard presentation={presentation} anatomy="page" serverId={props.serverId}
            title={t('approvals.includedStepsTitle')} description={t('approvals.includedStepsDescription')} testID={props.testID} />
        );
      }}
    </NamedMachines>
  );
});

/**
 * The retention step, with the finite rule it replaces read from the allocation itself ("Now: Stop after 1 h
 * unused"), so the person sees what changes. Until the allocation is read, or when it is already always on,
 * the outcome stands alone.
 */
const KeepsOnStep = React.memo(function KeepsOnStep(props: Readonly<{
  title: string;
  serverId: string | null;
  homeId: string;
  managedId: string;
  testID: string;
}>) {
  const managed = useManagedMachineInventory(props.serverId ? [props.serverId] : [], props.managedId);
  const row = props.serverId ? managed.machinesByServerId[props.serverId]?.find((machine) =>
    machine.id === props.managedId && machine.homeId === props.homeId) : undefined;
  const now = row && row.retention.kind !== 'until-delete'
    ? t('approvals.includedStepRetentionNow', { policy: describeRetention(row.retention) }) : undefined;
  return <Item title={props.title} subtitle={now} mode="info" showChevron={false} testID={props.testID} />;
});
