import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { ArtifactAccessRecipientCensusResponseV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import {
  DeploymentEnvironmentCreateIntentInputV1Schema,
  DeploymentEnvironmentCreateResultV1Schema,
  DeploymentEnvironmentGetResultV1Schema,
  DeploymentEnvironmentUpdateResultV1Schema,
} from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { MachineInstallationIdentityV1Schema } from '@happier-dev/protocol/machines/identity/installationIdentity';
import {
  ProjectSourcesReadOutputV1Schema,
  ProjectSourcesUpdateOutputV1Schema,
} from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { REGISTRY_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/registries';
import { TeamSummaryV1Schema } from '@happier-dev/protocol/teams/projections';

import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { startDatabaseWorkbenchFixture } from '../../src/testkit/databaseWorkbench';
import { fetchJson } from '../../src/testkit/http';
import { repoRootDir } from '../../src/testkit/paths';

// CLI Action executor → real server on PostgreSQL → enrolled daemon. Nothing internal is mocked.
// A Source audience reads the Source's E2EE deployment content once the keyholder has delivered
// recipient envelopes (docs/deployment.md "effective Source audience"). The two committed-change
// triggers deliver them: Environment Permissions Save and a Source audience edit.
it('E2EE Source audience receives Environment and target-link envelopes at Permissions Save and Source audience edit', async () => {
  const started = Date.now();
  const step = (label: string) =>
    console.info(
      `TEAM-RECIPIENTS +${Math.round((Date.now() - started) / 1000)}s ${label}`,
    );
  const testDir = await mkdtemp(join(tmpdir(), 'happier-team-recipients-'));
  const fixture = await startDatabaseWorkbenchFixture({ testDir });
  try {
    const owner = await fixture.createAccount('recipients-owner');
    const member = await fixture.createAccount('recipients-member');
    const viewer = await fixture.createAccount('recipients-viewer');
    const outsider = await fixture.createAccount('recipients-outsider');
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
    const accountIds = {
      member: readAccountIdFromToken(member.credentials.token),
      viewer: readAccountIdFromToken(viewer.credentials.token),
      outsider: readAccountIdFromToken(outsider.credentials.token),
    };
    async function invoke(
      account: typeof owner,
      actionId: ActionId,
      input: unknown,
    ) {
      const result = await account.execute(actionId, input, {
        presentUserConfirmation: { actionId },
      });
      if (!result.ok)
        throw new Error(`setup ${actionId} refused (${result.errorCode})`);
      return result.result;
    }
    async function asPerson(
      account: typeof owner,
      actionId: ActionId,
      input: unknown,
    ) {
      const result = await account.executeAsPerson(actionId, input);
      if (!result.ok)
        throw new Error(`setup ${actionId} refused (${result.errorCode})`);
      return result.result;
    }
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
      throw new Error('setup daemon omitted the shipped app catalog');
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
      throw new Error('setup PostgreSQL app is unavailable');
    }
    const created = await owner.executeReviewed(
      'deployments.environments.create',
      DeploymentEnvironmentCreateIntentInputV1Schema.parse({
        serverId: fixture.serverId,
        name: 'Team recipients',
        requestKey: randomUUID(),
        newProject: {
          name: 'Team recipients',
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
      {
        externalActionTarget: {
          kind: 'machine',
          machineId: machine.target.machineId,
        },
        presentUserConfirmation: {
          actionId: 'deployments.environments.create',
        },
      },
    );
    if (!created.ok)
      throw new Error(
        `setup Environment creation refused (${created.errorCode})`,
      );
    const environmentResult = DeploymentEnvironmentCreateResultV1Schema.parse(
      created.result,
    );
    if (!environmentResult.ok)
      throw new Error(
        `setup Environment creation failed (${environmentResult.error})`,
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
    const initial = await read(owner);
    if (!initial.ok || !('environment' in initial))
      throw new Error('setup Environment read failed');
    if (!initial.targetLinks.length)
      throw new Error('setup Environment omitted its own-server target link');
    const contentArtifactIds = [
      initial.environment.contentArtifactId,
      ...initial.targetLinks.map((link) => link.contentArtifactId),
    ];
    step('environment created');

    async function census(artifactId: string) {
      const response = await fetchJson(
        `${fixture.server.baseUrl}/v1/artifacts/${encodeURIComponent(artifactId)}/access/recipients`,
        { headers: { authorization: `Bearer ${owner.auth.token}` } },
      );
      expect(response.status, JSON.stringify(response.data)).toBe(200);
      return ArtifactAccessRecipientCensusResponseV1Schema.parse(response.data)
        .recipients;
    }
    async function enveloped(accountId: string) {
      return Promise.all(
        contentArtifactIds.map(async (artifactId) =>
          (await census(artifactId)).some(
            (row) =>
              row.recipientAccountId === accountId &&
              row.encryptedDataKey !== null,
          ),
        ),
      );
    }
    async function createTeam(name: string, accountId: string) {
      const team = TeamSummaryV1Schema.parse(
        await invoke(owner, 'teams.create', {
          v: 1,
          name,
          initialOwnerAccountId: ownerAccountId,
          requestKey: randomUUID(),
        }),
      );
      await invoke(owner, 'teams.members.add', {
        v: 1,
        teamId: team.id,
        accountId,
        role: 'member',
        historyAccess: 'all_existing',
      });
      return team;
    }
    const sourceAddress = {
      serverId: fixture.serverId,
      sourceId: initial.environment.projectSourceId,
    };
    const readSource = async () => {
      const source = ProjectSourcesReadOutputV1Schema.parse(
        await invoke(owner, 'projects.sources.read', sourceAddress),
      );
      if (!source.ok)
        throw new Error(`setup Project read failed (${source.error})`);
      return source.source;
    };

    // An audience that predates delivery: written below every client, so no keyholder ran.
    const deployers = await createTeam('Deployers', accountIds.member);
    const deployerRef = { kind: 'team' as const, teamId: deployers.id };
    const before = await readSource();
    const patched = await fetchJson(
      `${fixture.server.baseUrl}/v1/projects/sources/${encodeURIComponent(sourceAddress.sourceId)}`,
      {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${owner.auth.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...sourceAddress,
          expectedRevision: before.revision,
          patch: { audience: [{ principal: deployerRef, level: 'view' }] },
        }),
      },
    );
    expect(
      ProjectSourcesUpdateOutputV1Schema.parse(patched.data),
      JSON.stringify(patched.data),
    ).toMatchObject({ ok: true });
    expect(await read(member)).toMatchObject({
      ok: false,
      errorCode: 'deployment_content_unavailable',
    });
    expect(await enveloped(accountIds.member)).toEqual(
      contentArtifactIds.map(() => false),
    );
    step('pre-existing audience without envelopes');

    // Trigger 2: Environment Permissions Save, as the keyholding owner.
    const saved = DeploymentEnvironmentUpdateResultV1Schema.parse(
      await (async () => {
        const result = await owner.executeReviewed(
          'deployments.environments.update',
          {
            ...address,
            contentArtifactId: initial.environment.contentArtifactId,
            contentHeaderVersion: initial.environment.contentHeaderVersion,
            contentBodyVersion: initial.environment.contentBodyVersion,
            expectedRevision: initial.environment.revision,
            patch: {
              deployerMode: 'chosen',
              deployerPrincipals: [deployerRef],
              dataEditorMode: 'chosen',
              dataEditors: [deployerRef],
            },
          },
          {
            presentUserConfirmation: {
              actionId: 'deployments.environments.update',
            },
          },
        );
        if (!result.ok)
          throw new Error(`Permissions Save refused (${result.errorCode})`);
        return result.result;
      })(),
    );
    expect(saved).toMatchObject({ ok: true });
    step('permissions saved');
    expect(await enveloped(accountIds.member)).toEqual(
      contentArtifactIds.map(() => true),
    );
    const memberView = await read(member);
    expect(memberView, JSON.stringify(memberView)).toMatchObject({
      ok: true,
      environment: {
        deployerMode: 'chosen',
        capabilities: { deploy: true, editData: true },
      },
    });

    // Trigger 1: a Source audience edit through the client Action delivers to the new audience.
    const readers = await createTeam('Readers', accountIds.viewer);
    const current = await readSource();
    const updated = ProjectSourcesUpdateOutputV1Schema.parse(
      await invoke(owner, 'projects.sources.update', {
        ...sourceAddress,
        expectedRevision: current.revision,
        patch: {
          audience: [
            { principal: deployerRef, level: 'view' },
            { principal: { kind: 'team', teamId: readers.id }, level: 'view' },
          ],
        },
      }),
    );
    expect(updated).toMatchObject({ ok: true });
    step('source audience edited');
    expect(await enveloped(accountIds.viewer)).toEqual(
      contentArtifactIds.map(() => true),
    );
    expect(await read(viewer)).toMatchObject({
      ok: true,
      environment: { capabilities: { deploy: false } },
    });

    // Outsiders stay refused and the census never names anyone outside the admitted audience.
    expect(await read(outsider)).toMatchObject({
      ok: false,
      errorCode: 'deployment_unavailable',
    });
    expect(await enveloped(accountIds.outsider)).toEqual(
      contentArtifactIds.map(() => false),
    );
    const admitted = new Set([
      ownerAccountId,
      accountIds.member,
      accountIds.viewer,
    ]);
    for (const artifactId of contentArtifactIds) {
      for (const row of await census(artifactId))
        expect(
          admitted.has(row.recipientAccountId),
          row.recipientAccountId,
        ).toBe(true);
    }
    const direct = await fetchJson(
      `${fixture.server.baseUrl}/v1/artifacts/${encodeURIComponent(initial.environment.contentArtifactId)}`,
      { headers: { authorization: `Bearer ${outsider.auth.token}` } },
    );
    expect(direct.status).not.toBe(200);
  } finally {
    await fixture.stop();
  }
}, 1_200_000);
