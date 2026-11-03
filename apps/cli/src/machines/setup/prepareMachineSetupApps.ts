import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { MachineSetupAppChildV1, MachineSetupAppReviewV1, MachineSetupPlanInputV1,
  MachineSetupPlanResultV1, MachineSetupPlanReviewV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { DeploymentEnvironmentGetResultV1Schema, DeploymentTemplateInstantiationReviewV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { readMachineSetupAppIdentityV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import type { MachineSetupAcceptedAppRunV1 } from '@happier-dev/protocol/machines/setup/machineSetupSourcesV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { DeploymentTemplateInstantiateInputV1 } from '@happier-dev/protocol/deployments/deploymentTemplateInstantiationV1';
import { deriveWorkflowReplacementId } from '@happier-dev/protocol';
import { readDeploymentReceiptArtifactV1, readDeploymentEnvironmentArtifactV1,
  type DeploymentArtifactDocumentV1 } from '@happier-dev/deployment-protocol';
import { readMachineSetupAcceptedAppRuns, type MachineSetupAcceptedAppRunObservation } from './acceptedAppRuns';

type AppObservation = NonNullable<MachineSetupPlanReviewV1['apps']>[number];
type AppRuntime = Pick<Parameters<typeof readMachineSetupAcceptedAppRuns>[0], 'execute' | 'isCurrent'>;
export type MachineSetupAppPreparationHost = Readonly<{
  installationId?: string;
  prepareDeploymentTemplateInstantiation?: ActionExecutorDeps['prepareDeploymentTemplateInstantiation'];
  deploymentAction?: ActionExecutorDeps['deploymentAction'];
  readArtifact?(input: Readonly<{ serverId: string; contentArtifactId: string; contentHeaderVersion: number; contentBodyVersion: number }>,
    context: ActionExecutorContext): Promise<DeploymentArtifactDocumentV1 | null>;
  readAppRuntime?(context: ActionExecutorContext): AppRuntime | null;
}>;
const failure = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });

async function observeApps(input: MachineSetupPlanInputV1, plan: MachineSetupPlanResultV1,
  context: ActionExecutorContext, host: MachineSetupAppPreparationHost): Promise<AppObservation[]> {
  const references = new Map<string, MachineSetupAcceptedAppRunV1[]>();
  for (const facts of Object.values(plan.sourceFacts ?? {})) for (const reference of facts.acceptedAppRuns ?? []) {
    const identity = readMachineSetupAppIdentityV1({ kind: 'app', definition: reference.intent,
      ...(reference.authoredKey === undefined ? {} : { authoredKey: reference.authoredKey }) });
    if (identity === undefined) continue;
    const existing = references.get(identity) ?? [];
    if (!existing.some(value => sameStrictJsonValue(value, reference))) existing.push(reference);
    references.set(identity, existing);
  }
  const apps = plan.sources.flatMap((source, sourceIndex) => (source.setup.items ?? []).flatMap((item, itemIndex) =>
    item.kind === 'app' ? [{ sourceIndex, itemIndex, item }] : []));
  const requests: Parameters<typeof readMachineSetupAcceptedAppRuns>[0]['apps'][number][] = [];
  const pending = apps.map(app => {
    const origin = plan.appOrigins?.find(value => value.sourceIndex === app.sourceIndex && value.itemIndex === app.itemIndex);
    const identity = readMachineSetupAppIdentityV1(app.item);
    const candidates = origin?.kind === 'retained' && identity !== undefined ? references.get(identity) ?? [] : [];
    const start = requests.length;
    if (input.mode) for (const reference of candidates) requests.push({ intent: app.item.definition,
      ...(app.item.authoredKey === undefined ? {} : { authoredKey: app.item.authoredKey }), reference });
    return { app, origin, start, count: requests.length - start };
  });
  // Reuse DF's exact Run/page reader only for saved references. Ordinary reads
  // and legacy/missing references never acquire an outcome-read runtime.
  const runtime = requests.length ? host.readAppRuntime?.(context) : null;
  const outcomes: readonly MachineSetupAcceptedAppRunObservation[] = runtime
    ? await readMachineSetupAcceptedAppRuns({ homeId: input.homeId, machineId: input.machineId,
      apps: requests, ...runtime, ...(context.signal ? { signal: context.signal } : {}) }) : [];
  return pending.map(({ app, origin, start, count }): AppObservation => {
    const address = { sourceIndex: app.sourceIndex, itemIndex: app.itemIndex };
    if (origin?.kind === 'new') return { ...address, kind: 'new' };
    const candidates = outcomes.slice(start, start + count);
    const completed = candidates.filter(value => value.outcome.kind === 'completed');
    const selected = completed.length === 1 ? completed[0]
      : completed.length === 0 && candidates.length === 1 ? candidates[0] : undefined;
    return { ...address, kind: selected?.outcome.kind ?? 'unknown',
      ...(selected?.environmentId === undefined ? {} : { environmentId: selected.environmentId }) };
  });
}

async function prepareApp(input: MachineSetupPlanInputV1, plan: MachineSetupPlanResultV1,
  child: MachineSetupAppChildV1, context: ActionExecutorContext, host: MachineSetupAppPreparationHost):
  Promise<MachineSetupAppReviewV1 | ActionExecuteFailure | null> {
  const item = plan.sources[child.sourceIndex]?.setup.items?.[child.itemIndex];
  if (item?.kind !== 'app' || child.input.serverId !== input.homeId) return failure('machine_setup_app_plan_changed');
  if (child.actionId === 'deployments.templates.instantiate') {
    const selected = child.input;
    if (item.definition.definition.from !== 'catalogApp' || selected.mode !== 'apply' || selected.deploy === undefined
      || selected.machineId !== input.machineId
      || (item.definition.project.kind === 'existing'
        ? selected.projectSourceId !== item.definition.project.projectSourceId
        : selected.projectSourceId !== undefined || selected.newProject?.owner.kind !== 'account'
          || selected.newProject.owner.accountId !== context.runtimeAccountId)
      || !sameStrictJsonValue(selected.templateRef, item.definition.definition.templateRef)
      || !sameStrictJsonValue(selected.bindings, item.definition.bindings)
      || selected.environment.kind === 'create' && selected.environment.name !== item.definition.name
      || !host.prepareDeploymentTemplateInstantiation) return failure('machine_setup_app_plan_changed');
    // P45 is local to this receiving target. It owns installation, catalog pin,
    // variables and capacity preparation; no routing-host preview is invented.
    const prepared = await host.prepareDeploymentTemplateInstantiation({ input: selected, context });
    if ('errorCode' in prepared) return prepared;
    if (!sameStrictJsonValue(prepared.input, selected)) return failure('machine_setup_app_plan_changed');
    return { sourceIndex: child.sourceIndex, itemIndex: child.itemIndex, actionId: child.actionId,
      review: DeploymentTemplateInstantiationReviewV1Schema.parse(prepared.preview) };
  }
  if (child.actionId !== 'deployments.deploy' || item.definition.project.kind !== 'existing' || item.definition.definition.from !== 'compose'
    || !host.deploymentAction || !host.readArtifact) return failure('machine_setup_app_preparation_unavailable');
  const selected = child.input;
  const receipt = readDeploymentReceiptArtifactV1(selected, await host.readArtifact(selected, context));
  if (!receipt.ok) return failure(receipt.error);
  const definition = item.definition.definition;
  const intent = receipt.content.sourceIntent;
  if (intent?.kind !== 'stored' || intent.document !== definition.document
    || !sameStrictJsonValue(intent.profiles, definition.profiles) || !sameStrictJsonValue(intent.services, definition.services)
    || intent.primaryService !== definition.primaryService || !receipt.content.machines.includes(input.machineId))
    return failure('machine_setup_app_plan_changed');
  const loaded = await host.deploymentAction('deployments.environments.get', {
    serverId: selected.serverId, environmentId: selected.environmentId,
  }, context);
  if ('errorCode' in loaded) return loaded;
  const parsed = DeploymentEnvironmentGetResultV1Schema.safeParse(loaded);
  if (!parsed.success || !parsed.data.ok) return failure('deployment_content_unavailable');
  const { environment, targetLinks } = parsed.data;
  const runtime = targetLinks.find(link => link.id === selected.targetLinkId);
  if (environment.projectSourceId !== item.definition.project.projectSourceId
    || environment.revision !== selected.expectedRevision || environment.runtimeTargetLinkId !== selected.targetLinkId
    || environment.deletedAtMs !== undefined || !runtime || runtime.revision !== selected.expectedTargetLinkRevision
    || runtime.deletedAtMs !== undefined || runtime.detachedAtMs !== undefined
    || !runtime.members.some(member => member.machineId === input.machineId)) return failure('machine_setup_app_plan_changed');
  const opened = readDeploymentEnvironmentArtifactV1(environment,
    await host.readArtifact({ ...environment, serverId: selected.serverId }, context));
  if (!opened.ok) return failure(opened.error);
  const basis = receipt.content.ownServer?.approvedInputBasis;
  if (opened.title !== item.definition.name || !sameStrictJsonValue(opened.content.definition, intent)
    || !sameStrictJsonValue(opened.content.bindings, item.definition.bindings)
    || !basis || basis.environmentId !== environment.id || basis.environmentRevision !== environment.revision
    || basis.targetLinkId !== runtime.id || basis.targetLinkRevision !== runtime.revision
    || !sameStrictJsonValue(basis.sourceIntent, intent)
    || !sameStrictJsonValue(basis.members, runtime.members.map(({ machineId, installationId }) => ({ machineId, installationId }))))
    return failure('machine_setup_app_plan_changed');
  return null;
}

/** Target Plan owns app preparation and outcome projection; parent only aggregates. */
export async function prepareMachineSetupApps(input: MachineSetupPlanInputV1, plan: MachineSetupPlanResultV1,
  context: ActionExecutorContext, host: MachineSetupAppPreparationHost): Promise<MachineSetupPlanResultV1 | ActionExecuteFailure> {
  const apps = await observeApps(input, plan, context, host);
  if (context.signal?.aborted) return failure('cancelled');
  const children: MachineSetupAppChildV1[] = [...input.appChildren ?? []];
  if (input.mode === 'effects' && input.appChildren === undefined) {
    for (const app of apps.filter(app => app.kind === 'new')) {
      const item = plan.sources[app.sourceIndex]?.setup.items?.[app.itemIndex];
      if (item?.kind !== 'app' || item.definition.definition.from !== 'catalogApp'
        || !host.installationId || !context.runtimeAccountId) continue;
      // Stable owner request keys keep repeated Plan reads inert and bind the
      // ordinary P45 create/deploy to this exact desired-setup revision.
      const key = (phase: string) => deriveWorkflowReplacementId(['machines.setup.apply', input.homeId, input.machineId,
        String(plan.desiredRevision), readMachineSetupAppIdentityV1(item)!, phase]);
      const selected = { mode: 'apply', serverId: input.homeId,
        machineId: input.machineId, ...(item.definition.project.kind === 'existing'
          ? { projectSourceId: item.definition.project.projectSourceId }
          : { newProject: { name: input.machineId, requestKey: key('project'),
            owner: { kind: 'account', accountId: context.runtimeAccountId } } }),
        templateRef: item.definition.definition.templateRef,
        environment: { kind: 'create', name: item.definition.name, requestKey: key('environment'),
          protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', controllerMachineId: input.machineId },
        target: { kind: 'new', installationId: host.installationId }, destination: { kind: 'stored' },
        bindings: item.definition.bindings, deploy: { requestKey: key('deploy') } } satisfies DeploymentTemplateInstantiateInputV1;
      children.push({ sourceIndex: app.sourceIndex, itemIndex: app.itemIndex,
        actionId: 'deployments.templates.instantiate', input: selected });
    }
  }
  let prior = -1;
  for (const child of children) {
    const index = apps.findIndex(app => app.sourceIndex === child.sourceIndex && app.itemIndex === child.itemIndex);
    if (index <= prior) return failure('machine_setup_app_plan_changed');
    prior = index;
  }
  const executable = input.mode === 'effects' ? children.filter(child => apps.some(app => app.kind === 'new'
    && app.sourceIndex === child.sourceIndex && app.itemIndex === child.itemIndex)) : [];
  if ((input.appChildren !== undefined || context.externalActionExecutionAuthorization?.binding.actionId === 'machines.setup.apply')
    && input.mode === 'effects'
    && apps.filter(app => app.kind === 'new').length !== executable.length) return failure('machine_setup_app_preparation_unavailable');
  const reviews: MachineSetupAppReviewV1[] = [];
  for (const child of executable) {
    const prepared = await prepareApp(input, plan, child, context, host);
    if (prepared && 'errorCode' in prepared) return prepared;
    if (prepared) reviews.push(prepared);
  }
  if (context.signal?.aborted) return failure('cancelled');
  const preparedApps = new Set(reviews.map(app => `${app.sourceIndex}:${app.itemIndex}`));
  return { ...plan, ...(input.appChildren === undefined && !children.length ? {} : { appChildren: executable, appReviews: reviews }),
    support: plan.support.map(entry => preparedApps.has(`${entry.sourceIndex}:${entry.itemIndex}`)
      ? { sourceIndex: entry.sourceIndex, itemIndex: entry.itemIndex, status: 'drifted' as const } : entry),
    ...(plan.review ? { review: { ...plan.review, apps } } : {}) };
}
