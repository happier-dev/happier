import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { ProjectSourcesListOutputV1Schema, ProjectSourcesReadOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import type { TeamSetupFFixture } from '../testkit/teamSetupF';

/** Real CLI Actions, Home persistence, enrollment and daemon transport; no seeded resources. */
export async function runFreshDeploymentSourceSmoke(fixture: TeamSetupFFixture, daemonOptions: Parameters<TeamSetupFFixture['enrollDaemon']>[1] = {}) {
  const account = await fixture.createAccount(`journey-${randomUUID()}`);
  const list = await account.execute('projects.sources.list', { serverId: fixture.serverId });
  expect(list.ok).toBe(true);
  if (!list.ok) throw new Error(`Source list refused: ${list.errorCode}`);
  const empty = ProjectSourcesListOutputV1Schema.parse(list.result);
  expect(empty.ok).toBe(true);
  if (!empty.ok) throw new Error(`Source list refused: ${empty.error}`);
  expect(empty.sources).toEqual([]);
  const created = await account.execute('projects.sources.create', { serverId: fixture.serverId,
    name: 'Fresh deployment journey', requestKey: randomUUID() }, { presentUserConfirmation: { actionId: 'projects.sources.create' } });
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error(`Source creation refused: ${created.errorCode}`);
  const source = ProjectSourcesReadOutputV1Schema.parse(created.result);
  expect(source.ok).toBe(true);
  if (!source.ok) throw new Error(`Source creation refused: ${source.error}`);
  const read = await account.execute('projects.sources.read', { serverId: fixture.serverId, sourceId: source.source.id });
  expect(read.ok).toBe(true);
  if (!read.ok) throw new Error(`Source read refused: ${read.errorCode}`);
  expect(ProjectSourcesReadOutputV1Schema.parse(read.result)).toMatchObject({ ok: true, source: { id: source.source.id } });
  const machine = await fixture.enrollDaemon(account, daemonOptions);
  await fixture.assertKnownGoodMachineControl(account, machine);
  return { account, machine, sourceId: source.source.id };
}
