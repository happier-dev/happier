import { createRailwayProjectOperations } from '@happier-dev/railway-api';
import { expect, it } from 'vitest';

const selection = { projectId: 'project', environmentId: 'production', serviceId: 'database', workspaceId: 'workspace' };
type Request = { query: string; variables: Record<string, unknown> };
const page = <T>(nodes: T[], endCursor: string | null = null) => ({
  edges: nodes.map(node => ({ node })), pageInfo: { hasNextPage: endCursor !== null, endCursor },
});
const att = (environmentId: string, serviceId: string | null, volumeId: string, extra: Record<string, unknown> = {}) => ({
  id: environmentId + '-' + volumeId, environmentId, serviceId, volumeId, deletedAt: null, isPendingDeletion: false, ...extra,
});

function vendor(respond: (request: Request) => unknown) {
  const requests: Request[] = [];
  const project = createRailwayProjectOperations(async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as Request;
    requests.push(request);
    return Response.json({ data: respond(request) });
  });
  return { project, requests };
}
const projectWith = (environments: unknown) => () => ({ project: { id: 'project', environments } });

it('N1 sibling in another environment with deletedAt ABSENT is not silently dropped', async () => {
  const sibling = att('staging', 'database', 'vol'); delete (sibling as Record<string, unknown>).deletedAt;
  const { project } = vendor(projectWith(page([
    { id: 'production', volumeInstances: page([att('production', 'database', 'vol')]) },
    { id: 'staging', volumeInstances: page([sibling]) },
  ])));
  const result = await project.readServiceVolume(selection).then(value => ({ value }), error => ({ error: String(error) }));
  // SAFE iff it throws (kept-unchecked) or counts staging. UNSAFE iff otherEnvironments === 0.
  expect(result).not.toMatchObject({ value: { volume: { otherEnvironments: 0 } } });
});

it('N2 sibling only on the second environments page is counted', async () => {
  const { project, requests } = vendor(({ variables }) => ({ project: { id: 'project', environments: variables.after === null
    ? page([{ id: 'production', volumeInstances: page([att('production', 'database', 'vol')]) }], 'p2')
    : page([{ id: 'qa', volumeInstances: page([att('qa', 'other-svc', 'vol')]) }]) } }));
  await expect(project.readServiceVolume(selection)).resolves.toMatchObject({ volume: { id: 'vol', otherEnvironments: 1 } });
  expect(requests).toHaveLength(2);
});

it('starts independent attachment continuations before either chain advances, keeping inventory order', async () => {
  const { project, requests } = vendor(({ query, variables }) => {
    if (query.includes('environment(id:')) {
      const { environmentId, after } = variables;
      if (environmentId === 'staging') {
        return { environment: { id: 'staging', projectId: 'project', volumeInstances: after === 'staging-2'
          ? page([], 'staging-3') : page([att('staging', 'database', 'vol')]) } };
      }
      return { environment: { id: 'qa', projectId: 'project', volumeInstances: page([att('qa', 'database', 'vol')]) } };
    }
    return { project: { id: 'project', environments: variables.after === null ? page([
      { id: 'production', volumeInstances: page([att('production', 'database', 'vol')]) },
      { id: 'staging', volumeInstances: page([], 'staging-2') },
    ], 'next-environment') : page([{ id: 'qa', volumeInstances: page([], 'qa-2') }]) } };
  });
  await expect(project.readServiceVolume(selection)).resolves.toEqual({
    volume: { id: 'vol', otherEnvironments: 2,
      url: 'https://railway.com/project/project/volume/vol?environmentId=staging' },
  });
  expect(requests).toHaveLength(5);
  const continuations = requests.filter(({ variables }) => variables.environmentId).map(({ variables }) => variables.after);
  expect(continuations.slice(0, 2)).toEqual(expect.arrayContaining(['staging-2', 'qa-2']));
  expect(continuations[2]).toBe('staging-3');
});

it('N3 null volumeInstances in another environment throws (kept-unchecked), never exclusive', async () => {
  const { project } = vendor(projectWith(page([
    { id: 'production', volumeInstances: page([att('production', 'database', 'vol')]) },
    { id: 'staging', volumeInstances: null },
  ])));
  await expect(project.readServiceVolume(selection)).rejects.toThrow();
});

it('N4 reviewed environment absent from the inventory throws', async () => {
  const { project } = vendor(projectWith(page([{ id: 'staging', volumeInstances: page([]) }])));
  await expect(project.readServiceVolume(selection)).rejects.toThrow();
});

it('N5 two attachments of the reviewed service throw (never pick one)', async () => {
  const { project } = vendor(projectWith(page([{ id: 'production', volumeInstances: page([
    att('production', 'database', 'vol-a'), att('production', 'database', 'vol-b')]) }])));
  await expect(project.readServiceVolume(selection)).rejects.toThrow();
});

it('N6 hasNextPage with null endCursor throws', async () => {
  const { project } = vendor(projectWith({ edges: [{ node: { id: 'production',
    volumeInstances: page([att('production', 'database', 'vol')]) } }], pageInfo: { hasNextPage: true, endCursor: null } }));
  await expect(project.readServiceVolume(selection)).rejects.toThrow();
});

it('N7 project null / wrong project id throws', async () => {
  await expect(vendor(() => ({ project: null })).project.readServiceVolume(selection)).rejects.toThrow();
  await expect(vendor(() => ({ project: { id: 'other', environments: page([{ id: 'production',
    volumeInstances: page([att('production', 'database', 'vol')]) }]) } })).project.readServiceVolume(selection)).rejects.toThrow();
});

it('N8 an attachment listed under the wrong environment node throws', async () => {
  const { project } = vendor(projectWith(page([
    { id: 'production', volumeInstances: page([att('production', 'database', 'vol'), att('staging', 'x', 'vol')]) },
  ])));
  await expect(project.readServiceVolume(selection)).rejects.toThrow();
});

it('N9 instance page 2 answered for a different environment throws', async () => {
  const { project } = vendor(({ query }) => query.includes('environment(id:')
    ? { environment: { id: 'production', projectId: 'project', volumeInstances: page([]) } }
    : { project: { id: 'project', environments: page([
      { id: 'production', volumeInstances: page([att('production', 'database', 'vol')]) },
      { id: 'staging', volumeInstances: page([], 'c2') },
    ]) } });
  await expect(project.readServiceVolume(selection)).rejects.toThrow();
});

it('N10 pending-deletion sibling still keeps the volume', async () => {
  const { project } = vendor(projectWith(page([
    { id: 'production', volumeInstances: page([att('production', 'database', 'vol')]) },
    { id: 'staging', volumeInstances: page([att('staging', 'database', 'vol', { deletedAt: '2026-11-26T00:00:00Z', isPendingDeletion: true })]) },
  ])));
  await expect(project.readServiceVolume(selection)).resolves.toMatchObject({ volume: { otherEnvironments: 1 } });
});

it('N11 another service in the SAME environment on the same volume, no other env: throws (never delete)', async () => {
  const { project } = vendor(projectWith(page([{ id: 'production', volumeInstances: page([
    att('production', 'database', 'vol'), att('production', 'web', 'vol')]) }])));
  await expect(project.readServiceVolume(selection)).rejects.toThrow();
});

it('N12 read issues queries only (no mutation)', async () => {
  const { project, requests } = vendor(projectWith(page([{ id: 'production', volumeInstances: page([att('production', 'database', 'vol')]) }])));
  await expect(project.readServiceVolume(selection)).resolves.toMatchObject({ volume: { id: 'vol', otherEnvironments: 0 } });
  expect(requests.every(({ query }) => !/\bmutation\b/u.test(query))).toBe(true);
});

it('N13 own attachment with serviceId ABSENT field (post-delete shape) is not nominated', async () => {
  const own = att('production', 'database', 'vol'); delete (own as Record<string, unknown>).serviceId;
  const { project } = vendor(projectWith(page([{ id: 'production', volumeInstances: page([own]) }])));
  const result = await project.readServiceVolume(selection).then(value => ({ value }), error => ({ error: String(error) }));
  expect(result).not.toMatchObject({ value: { volume: { id: 'vol' } } });
});
