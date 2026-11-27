import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import {
  DeploymentEnvironmentCreateIntentInputV1Schema,
  DeploymentEnvironmentCreateResultV1Schema,
  DeploymentEnvironmentGetResultV1Schema,
  DeploymentEnvironmentUpdateResultV1Schema,
  DeploymentReceiptResultV1Schema,
} from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { MachineInstallationIdentityV1Schema } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { ProjectSourcesReadOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { REGISTRY_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/registries';
import { TeamMembershipV1Schema } from '@happier-dev/protocol/teams/membership';
import { TeamSummaryV1Schema } from '@happier-dev/protocol/teams/projections';

import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { startDatabaseWorkbenchFixture } from '../../src/testkit/databaseWorkbench';
import { trackDatabaseWorkbenchDeployments } from '../../src/testkit/databaseWorkbenchDeployments';
import { repoRootDir } from '../../src/testkit/paths';

// TS.P3.F5a (D15): CLI Action executor → real server on PostgreSQL → enrolled
// daemon → native Compose deploy. Nothing internal is mocked. G1 control
// P3-F5a-known-good-team-deploy: the chosen Team's member deploys natively
// before the withdrawn-membership refusal counts.
it('TS.P3.F5a: a Team chosen through CLI Environment update admits its member to deploy and edit until membership ends', async () => {
  const started = Date.now();
  const step = (label: string) => console.info(`TS.P3.F5a +${Math.round((Date.now() - started) / 1000)}s ${label}`);
  const testDir = await mkdtemp(join(tmpdir(), 'happier-dbw-f5a-'));
  const fixture = await startDatabaseWorkbenchFixture({ testDir });
  const deployments = trackDatabaseWorkbenchDeployments(fixture, testDir);
  await deployments.run(async () => {
    const owner = await fixture.createAccount('f5a-owner');
    const member = await fixture.createAccount('f5a-member');
    await fixture.claimHomeOwner(owner);
    const machine = await fixture.enrollDaemon(owner, {
      cliLaunchSpec: {
        command: process.execPath,
        args: [
          '--import',
          resolve(
            repoRootDir(),
            'packages/cli-common/registerSourceRuntime.mjs',
          ),
          resolve(repoRootDir(), 'apps/cli/src/index.ts'),
        ],
        cwd: repoRootDir(),
      },
    });
    step('enrolled');
    const installation = MachineInstallationIdentityV1Schema.parse(
      JSON.parse(
        await readFile(
          join(machine.homeDir, 'installation-identity.json'),
          'utf8',
        ),
      ),
    );
    const ownerAccountId = readAccountIdFromToken(owner.credentials.token);
    const memberAccountId = readAccountIdFromToken(member.credentials.token);
    const onMachine = (actionId: ActionId) => ({
      externalActionTarget: {
        kind: 'machine' as const,
        machineId: machine.target.machineId,
      },
      presentUserConfirmation: { actionId },
    });
    async function invoke(
      account: typeof owner,
      actionId: ActionId,
      input: unknown,
    ) {
      const result = await account.execute(actionId, input, {
        presentUserConfirmation: { actionId },
      });
      if (!result.ok)
        throw new Error(`F5a setup ${actionId} refused (${result.errorCode})`);
      return result.result;
    }

    // The owner answers their own Ask for an access change in place (existing Environment editor Save).
    async function reviewed(account: typeof owner, actionId: ActionId, input: unknown) {
      const result = await account.executeReviewed(actionId, input, { presentUserConfirmation: { actionId } });
      if (!result.ok) throw new Error(`F5a ${actionId} refused (${result.errorCode})`);
      return result.result;
    }
    // The catalog is read through the person's UI client, as in R6; it is setup, not the F5a entry.
    async function asPerson(account: typeof owner, actionId: ActionId, input: unknown) {
      const result = await account.executeAsPerson(actionId, input);
      if (!result.ok) throw new Error(`F5a setup ${actionId} refused (${result.errorCode})`);
      return result.result;
    }
    // The shipped PostgreSQL app is the native deploy fixture (same recipe as R6).
    const sources = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1[
      'registries.sources.list'
    ].parse(
      await asPerson(owner, 'registries.sources.list', { kind: 'app' }),
    ).sources;
    const catalog = sources.find(
      (source) =>
        'packageContent' in source &&
        source.origin.pluginId === 'happier.deployment.templates',
    );
    if (!catalog)
      throw new Error(`F5a setup daemon omitted the shipped app catalog (${JSON.stringify(
        sources.map((source) => source.id))})`);
    const item = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1[
      'registries.items.read'
    ].parse(
      await asPerson(owner, 'registries.items.read', {
        kind: 'app',
        sourceId: catalog.id,
        itemId: 'postgresql',
      }),
    ).item;
    if (
      item.payload.kind !== 'app' ||
      item.payload.state !== 'ready' ||
      !item.summary.version
    ) {
      throw new Error('F5a setup PostgreSQL app is unavailable');
    }
    step('catalog read');
    const created = await owner.executeReviewed(
      'deployments.environments.create',
      DeploymentEnvironmentCreateIntentInputV1Schema.parse({
        serverId: fixture.serverId,
        name: 'F5a Team access',
        requestKey: randomUUID(),
        newProject: {
          name: 'F5a Team access',
          requestKey: randomUUID(),
          owner: { kind: 'account', accountId: ownerAccountId },
        },
        definition: {
          from: 'catalogApp',
          templateRef: {
            sourceId: catalog.id,
            itemId: 'postgresql',
            version: item.summary.version,
            ref: item.payload.ref,
          },
        },
        protection: 'nonProduction',
        purpose: 'standard',
        deployerMode: 'managers',
        controllerMachineId: machine.target.machineId,
        buildMachineId: machine.target.machineId,
        firstTargetLink: {
          machines: [
            {
              machineId: machine.target.machineId,
              installationId: installation.installationId,
            },
          ],
        },
      }),
      onMachine('deployments.environments.create'),
    );
    if (!created.ok)
      throw new Error(
        `F5a setup Environment creation refused (${created.errorCode})`,
      );
    const environmentResult = DeploymentEnvironmentCreateResultV1Schema.parse(
      created.result,
    );
    if (!environmentResult.ok)
      throw new Error(
        `F5a setup Environment creation failed (${environmentResult.error})`,
      );
    const address = {
      serverId: fixture.serverId,
      environmentId: environmentResult.environmentId,
    };
    async function read(account: typeof owner) {
      const result = await account.execute(
        'deployments.environments.get',
        address,
      );
      if (!result.ok)
        return { ok: false as const, errorCode: result.errorCode };
      return DeploymentEnvironmentGetResultV1Schema.parse(result.result);
    }
    step('environment created');
    const initial = await read(owner);
    if (!initial.ok || !('environment' in initial))
      throw new Error('F5a setup Environment read failed');
    const targetLinkId = initial.environment.runtimeTargetLinkId;
    if (!targetLinkId)
      throw new Error('F5a setup Environment omitted its runtime target');

    // The member reaches the Project through its Team audience; the Environment names the Team.
    step('initial read');
    const team = TeamSummaryV1Schema.parse(
      await invoke(owner, 'teams.create', {
        v: 1,
        name: 'F5a Team',
        initialOwnerAccountId: ownerAccountId,
        requestKey: randomUUID(),
      }),
    );
    const membership = TeamMembershipV1Schema.parse(await invoke(owner, 'teams.members.add', {
      v: 1,
      teamId: team.id,
      accountId: memberAccountId,
      role: 'member',
      historyAccess: 'all_existing',
    }));
    const sourceAddress = {
      serverId: fixture.serverId,
      sourceId: initial.environment.projectSourceId,
    };
    const source = ProjectSourcesReadOutputV1Schema.parse(
      await invoke(owner, 'projects.sources.read', sourceAddress),
    );
    if (!source.ok)
      throw new Error(`F5a setup Project read failed (${source.error})`);
    await invoke(owner, 'projects.sources.update', {
      ...sourceAddress,
      expectedRevision: source.source.revision,
      patch: {
        audience: [
          { principal: { kind: 'team', teamId: team.id }, level: 'view' },
        ],
      },
    });

    step('team + audience set');
    const teamRef = { kind: 'team' as const, teamId: team.id };
    const content = {
      contentArtifactId: initial.environment.contentArtifactId,
      contentHeaderVersion: initial.environment.contentHeaderVersion,
      contentBodyVersion: initial.environment.contentBodyVersion,
    };
    const save = async (expectedRevision: number) =>
      DeploymentEnvironmentUpdateResultV1Schema.parse(
        await reviewed(owner, 'deployments.environments.update', {
          ...address,
          ...content,
          expectedRevision,
          patch: {
            deployerMode: 'chosen',
            deployerPrincipals: [teamRef],
            dataEditorMode: 'chosen',
            dataEditors: [teamRef],
          },
        }),
      );
    step('update next');
    const saved = await save(initial.environment.revision);
    expect(saved).toMatchObject({
      ok: true,
      revision: initial.environment.revision + 1,
    });
    // An unchanged Save writes nothing.
    expect(await save(initial.environment.revision + 1)).toMatchObject({
      ok: true,
      revision: initial.environment.revision + 1,
    });

    step('update saved');
    const memberView = await read(member);
    expect(memberView, JSON.stringify(memberView)).toMatchObject({
      ok: true,
      environment: {
        deployerMode: 'chosen',
        deployerPrincipals: [teamRef],
        dataEditorMode: 'chosen',
        dataEditors: [teamRef],
        capabilities: { deploy: true, editData: true },
      },
    });

    console.info('TS.P3.F5a Team chosen through CLI update; member deploy next');
    // Keep the member's Machine access after removing them from the Environment Team.
    const machineTeam = TeamSummaryV1Schema.parse(await reviewed(owner, 'teams.create', {
      v: 1, name: 'F5a Machine users', initialOwnerAccountId: ownerAccountId, requestKey: randomUUID(),
    }));
    await reviewed(owner, 'teams.members.add', {
      v: 1, teamId: machineTeam.id, accountId: memberAccountId, role: 'member', historyAccess: 'all_existing',
    });
    await reviewed(owner, 'machines.access.grant.set', {
      ...machine.target,
      principal: { kind: 'team', teamId: machineTeam.id },
      level: 'view',
    });
    await reviewed(owner, 'machines.access.prepareKeys', machine.target);
    const machineAccess = await asPerson(member, 'machines.access.grants.list', machine.target);
    expect(machineAccess).toMatchObject({ access: { role: 'use', accessState: 'ready' } });
    await deployments.recordInitialDeploy(owner, { environmentId: address.environmentId, targetLinkId });

    // G1 control: the member's deploy is admitted and runs natively on the controller.
    const deploy = () =>
      member.executeReviewed(
        'deployments.deploy',
        { ...address, targetLinkId },
        onMachine('deployments.deploy'),
      );
    const deployed = await deploy();
    if (!deployed.ok)
      throw new Error(`F5a G1 member deploy refused (${deployed.errorCode})`);
    const receipt = DeploymentReceiptResultV1Schema.parse(deployed.result);
    expect(receipt, JSON.stringify(receipt)).toMatchObject({
      ok: true,
      state: 'succeeded',
    });

    console.info('P3-F5a-known-good-team-deploy passed');
    // Membership ends: the next admission refuses the deploy and the edit through the same matcher.
    await reviewed(owner, 'teams.members.remove', {
      v: 1,
      teamId: team.id,
      membershipId: membership.id,
    });
    expect(await read(member)).toMatchObject({
      ok: false,
      errorCode: 'deployment_unavailable',
    });
    expect(await deploy()).toMatchObject({
      ok: false,
      errorCode: 'credential_scope_denied',
    });
    expect(await read(owner)).toMatchObject({
      ok: true,
      environment: { capabilities: { deploy: true, editData: true } },
    });
  });
  // One fixture start plus one native PostgreSQL deploy (the R6 recipe exceeds the 180 s suite default).
}, 1_200_000);
