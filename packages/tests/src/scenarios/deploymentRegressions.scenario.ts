import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { expect } from 'vitest';
import { connectUiPersonActionClient } from '@happier-tests/ui-action-client';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import { ApprovalRequestGetResultV1Schema } from '@happier-dev/protocol/approvals/approvalRequestPublicRead';
import { SharedSavedSecretListOutputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { TeamSummaryV1Schema } from '@happier-dev/protocol/teams/projections';
import { ProjectSourcesReadOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { REGISTRY_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/registries/registryActionsV1';
import { MachineInstallationIdentityV1Schema } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { buildCatalogAppTemplateBindings, DeploymentTemplateInstantiateInputV1Schema,
  DeploymentTemplateInstantiateResultV1Schema } from '@happier-dev/protocol/deployments/deploymentTemplateInstantiationV1';
import { readDeploymentRefusalRecoveryV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import { DeploymentActionOutputSchemasV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { createOwnServerDockerBoundary } from '../../../../apps/cli/src/deployments/targets/ownServer/ownServerDeployment.testkit';
import { createSavedSecretResource, updateSavedSecretResourceInContext } from '../../../../apps/ui/sources/sync/ops/settings/savedSecretResourceOperations';
import { captureLazyActionAccountContext } from '../../../../apps/ui/sources/sync/ops/actions/actionAccountContext';
import { runTeamAction, TeamActionApprovalPendingError } from '../../../../apps/ui/sources/sync/ops/teams/teamActionClient';
import type { TeamSetupFFixture } from '../testkit/teamSetupF';

/** Regression a376848886b: nested UI Team dispatch must retain the Agent caller.
 * The real UI wrapper, policy, Artifact writer, Home and enrolled daemon stay real.
 * Calling the CLI executor with an Agent surface alone cannot detect this defect. */
export async function runAgentAskDeploymentRegression(fixture: TeamSetupFFixture) {
  const account = await fixture.createAccount(`agent-ask-${randomUUID()}`);
  const homeOwner = await fixture.claimHomeOwner(account);
  expect(homeOwner.result, 'The fresh managed Home must have an owner before creating its Team').toMatchObject({ status: 'claimed' });
  const machine = await fixture.enrollDaemon(account);
  const session = await fixture.assertKnownGoodSessionControl(account, machine);
  const ui = await connectUiPersonActionClient({ serverUrl: fixture.actionServerApiUrl,
    addressAnchorUrl: fixture.server.baseUrl, accountSecret: account.auth.accountSigningSeed });
  try {
    const person: ActionExecutorContext = { surface: 'ui', authority: 'present_user', serverId: ui.serverId,
      actionCaller: { kind: 'host' }, serverIdentityId: fixture.serverId };
    const context = await captureLazyActionAccountContext(ui.serverId);
    try {
      const scope = { serverId: context.serverId, accountId: context.accountId };
      const secret = await createSavedSecretResource({ scope, name: 'Original deployment credential', kind: 'token',
        value: 'journey-private-test-value', accountGrants: [], teamGrants: [], groupGrants: [] });
      expect(secret, 'Saved Secret setup must complete before approval regression').toMatchObject({ ok: true });
      if (!secret.ok) throw new Error(`Saved Secret setup blocked (${secret.reason})`);
      const ref = parseSavedSecretRefV1(secret.resourceRef);
      if (ref.kind !== 'shared_resource') throw new Error('Saved Secret creation omitted its Resource reference');
      const createdTeam = await ui.executeConfirmed('teams.create', { v: 1, name: 'Agent Ask Team',
        initialOwnerAccountId: homeOwner.targetAccountId, requestKey: randomUUID() }, person);
      expect(createdTeam, `Team setup must complete before approval regression${createdTeam.ok ? '' : ` (${createdTeam.errorCode})`}`)
        .toMatchObject({ ok: true });
      if (!createdTeam.ok) throw new Error(`Team setup blocked (${createdTeam.errorCode})`);
      const team = TeamSummaryV1Schema.parse(createdTeam.result);
      for (const actionId of ['secrets.shared.update', 'teams.update'] as const) {
        expect(await ui.executeConfirmed('actions.policy.set', { actionId, audience: 'agent', mode: 'ask_first' }, person))
          .toMatchObject({ ok: true, result: { mode: 'ask_first' } });
      }
      const agent: ActionExecutorContext = { surface: 'agent', authority: 'account_automation',
        serverId: ui.serverId, serverIdentityId: fixture.serverId, defaultSessionMachineId: machine.target.machineId,
        actionCaller: { kind: 'session', sessionId: session.sessionId, starterDepth: 0, turnDepth: 0 } };
      const secretPending: unknown = await updateSavedSecretResourceInContext(context, {
        resourceId: ref.resourceId, expectedRevision: secret.revision, nextName: 'Agent requested rename',
        executeAdmittedMutation: mutation => runTeamAction({ ...mutation, actionContext: agent }),
      }).catch((error: unknown) => error);
      const teamPending: unknown = await runTeamAction({ scope, actionId: 'teams.update',
        input: { v: 1, teamId: team.id, name: 'Agent requested Team rename' },
        parse: value => TeamSummaryV1Schema.parse(value), actionContext: agent,
      }).catch((error: unknown) => error);
      for (const [actionId, pending] of [['secrets.shared.update', secretPending], ['teams.update', teamPending]] as const) {
        expect(pending, `${actionId} must stop at Ask rather than execute as the person`).toBeInstanceOf(TeamActionApprovalPendingError);
        if (!(pending instanceof TeamActionApprovalPendingError)) throw new Error(`${actionId} did not return its Inbox approval`);
        const observed = await ui.execute('approval.request.get', { artifactId: pending.artifactId }, person);
        expect(observed).toMatchObject({ ok: true });
        if (!observed.ok) throw new Error(`Approval read failed (${observed.errorCode})`);
        const request = ApprovalRequestGetResultV1Schema.parse(observed.result).request;
        expect(request).toMatchObject({ actionId, status: 'open', createdBy: { surface: 'agent' },
          executionOriginV1: { authority: 'account_automation', surface: 'agent', caller: agent.actionCaller } });
        expect(request.execution).toBeUndefined();
      }
      const listed = await ui.execute('secrets.shared.list', {}, person);
      expect(listed).toMatchObject({ ok: true });
      if (!listed.ok) throw new Error(`Saved Secret post-Ask read failed (${listed.errorCode})`);
      expect(SharedSavedSecretListOutputV1Schema.parse(listed.result).resources)
        .toContainEqual(expect.objectContaining({ ref: secret.resourceRef, name: 'Original deployment credential', revision: secret.revision }));
      const unchangedTeam = await ui.execute('teams.get', { v: 1, teamId: team.id }, person);
      expect(unchangedTeam).toMatchObject({ ok: true, result: { id: team.id, name: team.name } });
    } finally { context.dispose(); }
  } finally { await ui.close(); }
}

/** A Team Source is authored through the same Actions as Home. The bundled
 * catalog reader produces the exact pinned template; no fixture fabricates a
 * release, admission, prepared Environment or recovery response. */
export async function runTeamDeploymentTemplateRegression(fixture: TeamSetupFFixture) {
  const tools = await mkdtemp(join(tmpdir(), 'team-template-docker-'));
  await createOwnServerDockerBoundary(tools);
  const account = await fixture.createAccount(`team-template-${randomUUID()}`);
  const homeOwner = await fixture.claimHomeOwner(account);
  expect(homeOwner.result, 'The fresh managed Home must have an owner before creating its Team').toMatchObject({ status: 'claimed' });
  const machine = await fixture.enrollDaemon(account, { env: { PATH: `${tools}${delimiter}${process.env.PATH ?? ''}` } });
  const teamResult = await account.executeAsPerson('teams.create', { v: 1, name: 'Template deployment Team',
    initialOwnerAccountId: homeOwner.targetAccountId, requestKey: randomUUID() });
  expect(teamResult, `Team setup must settle before instantiation${teamResult.ok ? '' : ` (${teamResult.errorCode})`}`)
    .toMatchObject({ ok: true });
  if (!teamResult.ok) throw new Error(`Team setup blocked (${teamResult.errorCode})`);
  const team = TeamSummaryV1Schema.parse(teamResult.result);
  const sourceResult = await account.executeAsPerson('projects.sources.create', { serverId: fixture.serverId,
    name: 'Team template Project', owner: { kind: 'team', teamId: team.id }, requestKey: randomUUID() });
  expect(sourceResult, 'Team Source setup must settle before instantiation').toMatchObject({ ok: true });
  if (!sourceResult.ok) throw new Error(`Team Source setup blocked (${sourceResult.errorCode})`);
  const source = ProjectSourcesReadOutputV1Schema.parse(sourceResult.result);
  if (!source.ok) throw new Error(`Team Source setup blocked (${source.error})`);
  expect(source.source.owner).toEqual({ kind: 'team', teamId: team.id });
  const sourcesResult = await account.executeAsPerson('registries.sources.list', { kind: 'app' });
  expect(sourcesResult, 'The actual daemon must publish its bundled app catalog').toMatchObject({ ok: true });
  if (!sourcesResult.ok) throw new Error(`Catalog setup blocked (${sourcesResult.errorCode})`);
  const catalog = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.sources.list'].parse(sourcesResult.result).sources
    .find(candidate => 'packageContent' in candidate && candidate.origin.pluginId === 'happier.deployment.templates');
  if (!catalog) throw new Error('Catalog setup blocked: bundled deployment templates are not active on the enrolled daemon');
  const selectionResult = await account.executeAsPerson('registries.items.read', { kind: 'app', sourceId: catalog.id, itemId: 'postgresql' });
  expect(selectionResult, 'The catalog owner must produce the selected template').toMatchObject({ ok: true });
  if (!selectionResult.ok) throw new Error(`Template selection blocked (${selectionResult.errorCode})`);
  const selected = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(selectionResult.result).item;
  if (selected.payload.kind !== 'app' || selected.payload.state !== 'ready' || !selected.summary.version) {
    throw new Error('Catalog did not produce a ready pinned App template');
  }
  const identity = MachineInstallationIdentityV1Schema.parse(JSON.parse(await readFile(join(machine.homeDir, 'installation-identity.json'), 'utf8')));
  const input = DeploymentTemplateInstantiateInputV1Schema.parse({ mode: 'apply', ...machine.target,
    projectSourceId: source.source.id, templateRef: { sourceId: catalog.id, itemId: selected.summary.itemId,
      version: selected.summary.version, ref: selected.payload.ref },
    environment: { kind: 'create', name: 'Team PostgreSQL', requestKey: randomUUID(), protection: 'nonProduction',
      purpose: 'standard', deployerMode: 'managers', controllerMachineId: machine.target.machineId },
    target: { kind: 'new', installationId: identity.installationId }, destination: { kind: 'stored' },
    ...buildCatalogAppTemplateBindings(selected.payload.app),
  });
  const instantiated = await account.execute('deployments.templates.instantiate', input,
    { presentUserConfirmation: { actionId: 'deployments.templates.instantiate' } });
  if (!instantiated.ok) {
    // A setup/auth/transport failure is not a successful product refusal. Only
    // the deployment owner's recognized, actionable refusal is acceptable.
    const recovery = readDeploymentRefusalRecoveryV1(instantiated.errorCode, instantiated.details);
    expect(recovery, 'Template refusal must retain its typed next step at the real caller').not.toBeNull();
    expect(recovery).toMatchObject({ requiredFact: expect.any(String), remedy: expect.any(String),
      nextAction: { kind: 'navigate', destination: expect.any(String), label: expect.any(String) } });
    return { outcome: 'refused' as const, errorCode: instantiated.errorCode, recovery };
  }
  const applied = DeploymentTemplateInstantiateResultV1Schema.parse(instantiated.result);
  expect(applied).toMatchObject({ kind: 'applied' });
  if (applied.kind !== 'applied') throw new Error(`Team template did not apply (${applied.kind})`);
  const observed = await account.execute('deployments.environments.get', { serverId: fixture.serverId, environmentId: applied.environmentId });
  expect(observed).toMatchObject({ ok: true });
  if (!observed.ok) throw new Error(`Instantiated Environment read failed (${observed.errorCode})`);
  const environment = DeploymentActionOutputSchemasV1['deployments.environments.get'].parse(observed.result);
  expect(environment).toMatchObject({ ok: true, environment: { projectSourceId: source.source.id,
    owner: { kind: 'team', teamId: team.id } } });
  return { outcome: 'applied' as const, environmentId: applied.environmentId };
}
