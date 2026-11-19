import { describe, expect, it } from 'vitest';

import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';

import {
  createDeploymentEnvironmentHeaderV1,
  createDeploymentTargetLinkHeaderV1,
} from '@happier-dev/deployment-protocol/testing/v1';
import {
  changesDeploymentEnvironmentAccessV1,
  prepareDeploymentEnvironmentRecipientsV1,
  prepareProjectSourceDeploymentRecipientsV1,
  withDeploymentEnvironmentRecipientDeliveryV1,
  type DeploymentContentRecipientPortsV1,
} from './contentRecipients.js';

const context = {
  surface: 'cli',
  authority: 'present_user',
} as ActionExecutorContext;
const reference = (id: string) => ({
  contentArtifactId: id,
  contentHeaderVersion: 1,
  contentBodyVersion: 1,
});

// Home answers are the boundary here: the stored rows' read projections, built by the canonical fixtures.
function home(options: Readonly<{ domainsFail?: boolean }> = {}) {
  const prepared: string[][] = [];
  const calls: string[] = [];
  const ports = {
    async deploymentAction(
      actionId: string,
      input: Readonly<Record<string, unknown>>,
    ) {
      calls.push(actionId);
      if (actionId === 'deployments.environments.list')
        return {
          ok: true,
          nextCursor: null,
          items: [
            createDeploymentEnvironmentHeaderV1({ id: 'env-a' }),
            createDeploymentEnvironmentHeaderV1({ id: 'env-b' }),
          ],
        };
      const id = String(input.environmentId);
      if (actionId === 'deployments.environments.get')
        return {
          ok: true,
          environment: createDeploymentEnvironmentHeaderV1({
            id,
            ...reference(`${id}-content`),
          }),
          targetLinks: [
            createDeploymentTargetLinkHeaderV1({
              id: `${id}-runtime`,
              environmentId: id,
              ...reference(`${id}-runtime-content`),
            }),
            createDeploymentTargetLinkHeaderV1({
              id: `${id}-retained`,
              environmentId: id,
              ...reference(`${id}-retained-content`),
            }),
          ],
        };
      if (actionId === 'deployments.domains.list') {
        if (options.domainsFail)
          return {
            ok: false,
            errorCode: 'unsupported_action',
            error: 'unsupported_action',
          };
        return {
          ok: true,
          environmentId: id,
          revision: 1,
          nextCursor: null,
          domains: [
            {
              v: 1,
              id: `${id}-domain`,
              environmentId: id,
              targetLinkId: `${id}-runtime`,
              revision: 1,
              state: 'active',
              createdByAccountId: 'owner', createdAtMs: 1, updatedAtMs: 1,
              ...reference(`${id}-domain-content`),
            },
          ],
        };
      }
      throw new Error(`unexpected ${actionId}`);
    },
    async readDefaults() {
      return {
        ok: true,
        projectSourceId: 'source',
        sourceRevision: 1,
        revision: 1,
        content: reference('defaults-content'),
      };
    },
    async prepareArtifactRecipients(ids: readonly string[]) {
      prepared.push([...ids]);
    },
  };
  return {
    ports: ports as unknown as DeploymentContentRecipientPortsV1,
    prepared,
    calls,
  };
}

describe('deployment content recipient delivery', () => {
  it('delivers one Environment content, every target link and its Domains in one preparation', async () => {
    const { ports, prepared } = home();
    await expect(
      prepareDeploymentEnvironmentRecipientsV1(
        ports,
        { serverId: 'home', environmentId: 'env-a' },
        context,
      ),
    ).resolves.toBeUndefined();
    expect(prepared).toEqual([
      [
        'env-a-content',
        'env-a-runtime-content',
        'env-a-retained-content',
        'env-a-domain-content',
      ],
    ]);
  });

  it('delivers every Source head plus defaults and never lists receipts', async () => {
    const { ports, prepared, calls } = home();
    await expect(
      prepareProjectSourceDeploymentRecipientsV1(
        ports,
        { serverId: 'home', projectSourceId: 'source' },
        context,
      ),
    ).resolves.toBeUndefined();
    expect(new Set(prepared.flat())).toEqual(
      new Set([
        'env-a-content',
        'env-a-runtime-content',
        'env-a-retained-content',
        'env-a-domain-content',
        'env-b-content',
        'env-b-runtime-content',
        'env-b-retained-content',
        'env-b-domain-content',
        'defaults-content',
      ]),
    );
    expect(calls).not.toContain('deployments.receipts.list');
  });

  it('still delivers readable heads when one read is refused', async () => {
    const { ports, prepared } = home({ domainsFail: true });
    await expect(
      prepareDeploymentEnvironmentRecipientsV1(
        ports,
        { serverId: 'home', environmentId: 'env-a' },
        context,
      ),
    ).resolves.toBeUndefined();
    expect(prepared).toEqual([
      ['env-a-content', 'env-a-runtime-content', 'env-a-retained-content'],
    ]);
  });

  it('settles without failing when the keyholder preparation is refused', async () => {
    const { ports } = home();
    const refused = {
      ...ports,
      prepareArtifactRecipients: async () => {
        throw new Error('artifact_access_forbidden');
      },
    };
    await expect(
      prepareDeploymentEnvironmentRecipientsV1(
        refused,
        { serverId: 'home', environmentId: 'env-a' },
        context,
      ),
    ).resolves.toBeUndefined();
  });

  it('selects only Permissions edits as Environment access changes', () => {
    expect(
      changesDeploymentEnvironmentAccessV1({
        patch: { deployerMode: 'chosen' },
      }),
    ).toBe(true);
    expect(
      changesDeploymentEnvironmentAccessV1({ patch: { dataEditors: [] } }),
    ).toBe(true);
    expect(
      changesDeploymentEnvironmentAccessV1({
        patch: { protection: 'production' },
      }),
    ).toBe(false);
    expect(changesDeploymentEnvironmentAccessV1({})).toBe(false);
  });

  describe('Permissions Save delivery', () => {
    const update = (patch: Readonly<Record<string, unknown>>, expectedRevision = 3) => ({ serverId: 'home', environmentId: 'env-a',
      ...reference('env-a-content'), expectedRevision, patch });
    async function save(patch: Readonly<Record<string, unknown>>, savedRevision: number, ports: 'own' | 'none' = 'own') {
      const fixture = home();
      const route = (async (actionId: string, input: Readonly<Record<string, unknown>>, context: ActionExecutorContext) =>
        actionId === 'deployments.environments.update' ? { ok: true, environmentId: 'env-a', revision: savedRevision }
          : fixture.ports.deploymentAction(actionId as never, input as never, context)) as DeploymentContentRecipientPortsV1['deploymentAction'];
      const wrapped = withDeploymentEnvironmentRecipientDeliveryV1(route, () => ports === 'own' ? fixture.ports : null);
      const result = await wrapped('deployments.environments.update', update(patch) as never, context);
      return { result, prepared: fixture.prepared };
    }

    it('delivers after a committed Permissions change and returns the route result unchanged', async () => {
      const { result, prepared } = await save({ deployerMode: 'chosen', deployerPrincipals: [{ kind: 'team', teamId: 'team' }] }, 4);
      expect(result).toEqual({ ok: true, environmentId: 'env-a', revision: 4 });
      expect(prepared).toHaveLength(1);
    });

    it('delivers nothing for an unchanged Save, a non-access edit, or a host without its own keys', async () => {
      expect((await save({ deployerMode: 'chosen' }, 3)).prepared).toEqual([]);
      expect((await save({ protection: 'production' }, 4)).prepared).toEqual([]);
      expect((await save({ deployerMode: 'chosen' }, 4, 'none')).prepared).toEqual([]);
    });

    it('settles a committed Save as succeeded when the caller aborts during delivery', async () => {
      const fixture = home();
      const controller = new AbortController();
      const aborting = { ...fixture.ports, async prepareArtifactRecipients() {
        controller.abort();
        throw new DOMException('aborted', 'AbortError');
      } };
      const route = (async () => ({ ok: true, environmentId: 'env-a', revision: 4 })) as DeploymentContentRecipientPortsV1['deploymentAction'];
      const wrapped = withDeploymentEnvironmentRecipientDeliveryV1(route, () => aborting);
      await expect(wrapped('deployments.environments.update', update({ deployerMode: 'chosen' }) as never,
        { ...context, signal: controller.signal })).resolves.toEqual({ ok: true, environmentId: 'env-a', revision: 4 });
    });
  });
});
