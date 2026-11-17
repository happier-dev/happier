import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { TeamSummaryV1Schema } from '@happier-dev/protocol/teams/projections';
import { DiscussionCreateResultV1Schema, DiscussionListResultV1Schema } from '@happier-dev/protocol/discussions/actions';
import { SharedSavedSecretListOutputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { sealSavedSecretResourceRecipientEnvelopeV1, sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { PRIVATE_LABEL_RECIPIENT_CENSUS_PATH } from '@happier-dev/protocol/crypto/privateLabelRecipientCensusV1';
import { prepareCliPrivateLabels } from '../../../../apps/cli/src/api/privateLabels';
import { teamGroupLabelBinding } from '@happier-dev/protocol/teams/groupLabel';
import { fetchAccountId } from '../../src/testkit/socialFriends';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';

describe('Team setup F: credential and conversation discovery', () => {
  let fixture: TeamSetupFFixture;
  let owner: Awaited<ReturnType<TeamSetupFFixture['createAccount']>>;
  let author: Awaited<ReturnType<TeamSetupFFixture['createAccount']>>;
  let groupReader: Awaited<ReturnType<TeamSetupFFixture['createAccount']>>;
  let teamOnlyReader: Awaited<ReturnType<TeamSetupFFixture['createAccount']>>;
  let machine: Awaited<ReturnType<TeamSetupFFixture['enrollDaemon']>>;
  let teamId: string;
  let sharedDiscussionId: string;
  let sharedSecretId: string;
  let groupId: string;

  beforeAll(async () => {
    fixture = await startTeamSetupFFixture({ testDir: await mkdtemp(join(tmpdir(), 'team-setup-f-credentials-')) });
    owner = await fixture.createAccount('resource-credentials-owner');
    machine = await fixture.enrollDaemon(owner);
    await fixture.assertKnownGoodSessionControl(owner, machine);
    expect((await fixture.claimHomeOwner(owner)).result.status).toBe('claimed');
    const team = await owner.executeReviewed('teams.create', { v: 1, name: 'F Credential resources', requestKey: randomUUID(),
      initialOwnerAccountId: readAccountIdFromToken(owner.credentials.token) });
    if (!team.ok) throw new Error(`Team creation refused (${team.errorCode})`);
    expect(team.ok).toBe(true);
    teamId = TeamSummaryV1Schema.parse(team.result).id;
    const accountId = await fetchAccountId(fixture.server.baseUrl, owner.credentials.token);
    author = await fixture.createAccount('resource-group-author');
    const authorId = await fetchAccountId(fixture.server.baseUrl, author.credentials.token);
    groupReader = await fixture.createAccount('resource-group-reader');
    const groupReaderId = await fetchAccountId(fixture.server.baseUrl, groupReader.credentials.token);
    teamOnlyReader = await fixture.createAccount('resource-team-only-reader');
    const teamOnlyReaderId = await fetchAccountId(fixture.server.baseUrl, teamOnlyReader.credentials.token);
    for (const memberId of [authorId, groupReaderId, teamOnlyReaderId]) {
      const member = await owner.executeReviewed('teams.members.add', { v: 1, teamId, accountId: memberId,
        role: 'member', historyAccess: 'all_existing' });
      if (!member.ok) throw new Error(`Team membership refused (${member.errorCode})`);
      expect(member.ok).toBe(true);
    }
    groupId = randomUUID();
    const [groupName] = await prepareCliPrivateLabels({ endpoint: fixture.server.baseUrl,
      token: owner.credentials.token, accountMode: 'e2ee', owner: { kind: 'team', teamId },
      recipientCensusPath: PRIVATE_LABEL_RECIPIENT_CENSUS_PATH,
      labels: [{ binding: teamGroupLabelBinding(groupId, 'name'), value: 'Restricted group' }] });
    const group = await owner.executeReviewed('teams.groups.create', { v: 1, teamId, groupId,
      requestKey: randomUUID(), name: groupName });
    if (!group.ok) throw new Error(`Group creation refused (${group.errorCode})`);
    expect(group.ok).toBe(true);
    for (const memberId of [authorId, groupReaderId]) {
      const groupMember = await owner.executeReviewed('teams.groups.members.add', { v: 1, teamId, groupId,
        accountId: memberId, historyAccess: 'all_existing' });
      if (!groupMember.ok) throw new Error(`Group membership refused (${groupMember.errorCode})`);
      expect(groupMember.ok).toBe(true);
    }
    // Team ownership does not make the viewer a member of this Group.
    for (const scope of ['team', 'private', 'group'] as const) {
      const shared = scope === 'team';
      const writer = scope === 'group' ? author : owner;
      const writerId = scope === 'group' ? authorId : accountId;
      const created = await writer.executeReviewed('discussion.create', { title: `${scope} discussion`,
        firstMessage: { content: { v: 1, parts: [{ t: 'text', text: 'Selected Team resource' }] } } });
      if (!created.ok) throw new Error(`Discussion creation refused (${created.errorCode})`);
      expect(created.ok).toBe(true);
      const discussionId = DiscussionCreateResultV1Schema.parse(created.result).discussion.id;
      if (scope !== 'private') {
        if (shared) sharedDiscussionId = discussionId;
        const granted = await writer.executeAsPerson('discussion.access.grants.set', { discussionId,
          principal: shared ? { kind: 'team', teamId } : { kind: 'group', teamId, groupId }, accessLevel: 'view' });
        expect(granted.ok).toBe(true);
        if (shared) {
          const groupGrant = await writer.executeAsPerson('discussion.access.grants.set', { discussionId,
            principal: { kind: 'group', teamId, groupId }, accessLevel: 'view' });
          expect(groupGrant.ok).toBe(true);
        }
      }
      const resourceId = randomUUID();
      if (shared) sharedSecretId = resourceId;
      const resourceDataKey = Uint8Array.from(randomBytes(32));
      const displayName = `${scope} saved secret`;
      const secret = await writer.executeReviewed('secrets.shared.create', { resourceId, displayName, kind: 'token',
        encryptionMode: 'e2ee', teamGrants: shared ? [teamId] : [], groupGrants: scope !== 'private' ? [groupId] : [],
        storedContent: sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'e2ee', resourceDataKey,
          content: { v: 1, name: displayName, kind: 'token', value: 'F_RESOURCE_SECRET_SENTINEL' }, randomBytes }),
        keyEnvelopes: [{ recipientAccountId: writerId, ...sealSavedSecretResourceRecipientEnvelopeV1({
          resourceDataKey, recipientContentPublicKey: writer.credentials.encryption.publicKey, randomBytes,
        }) }, ...(shared ? [{ recipientAccountId: authorId, ...sealSavedSecretResourceRecipientEnvelopeV1({
          resourceDataKey, recipientContentPublicKey: author.credentials.encryption.publicKey, randomBytes,
        }) }] : []), ...(scope !== 'private' ? [{ recipientAccountId: groupReaderId,
          ...sealSavedSecretResourceRecipientEnvelopeV1({ resourceDataKey,
            recipientContentPublicKey: groupReader.credentials.encryption.publicKey, randomBytes }),
        }] : []), ...(shared ? [{ recipientAccountId: teamOnlyReaderId,
          ...sealSavedSecretResourceRecipientEnvelopeV1({ resourceDataKey,
            recipientContentPublicKey: teamOnlyReader.credentials.encryption.publicKey, randomBytes }),
        }] : [])],
      });
      if (!secret.ok) throw new Error(`Saved Secret creation refused (${secret.errorCode})`);
      expect(secret.ok).toBe(true);
    }
  });
  afterAll(async () => { await fixture?.stop(); });

  it('TS.F.kindPaging keeps unrelated owned discussions outside the selected Team', async () => {
    await fixture.assertKnownGoodSessionControl(owner, machine);
    const listed = await owner.execute('discussion.list', { sharedWithTeamId: teamId, limit: 1 });
    if (!listed.ok) throw new Error(`Discussion page refused (${listed.errorCode})`);
    expect(listed.ok).toBe(true);
    const result = DiscussionListResultV1Schema.parse(listed.result);
    expect(result.discussions.map(row => row.id)).toEqual([sharedDiscussionId]);
    expect(result.nextCursor).toBeNull();
    const detail = await owner.execute('discussion.get', { discussionId: sharedDiscussionId });
    expect(detail.ok).toBe(true);
  });

  it('TS.F.kindPaging keeps unrelated owned Saved Secrets outside the selected Team', async () => {
    await fixture.assertKnownGoodSessionControl(owner, machine);
    const listed = await owner.execute('secrets.shared.list', { sharedWithTeamId: teamId, limit: 1 });
    if (!listed.ok) throw new Error(`Saved Secret page refused (${listed.errorCode})`);
    expect(listed.ok).toBe(true);
    const result = SharedSavedSecretListOutputV1Schema.parse(listed.result);
    expect(result.resources).toEqual([expect.objectContaining({ ref: formatSharedSavedSecretRefV1(sharedSecretId), sharedWithTeamScope: 'team_and_group' })]);
    expect(JSON.stringify(result)).not.toContain('F_RESOURCE_SECRET_SENTINEL');
  });

  it('TS.F.summaryDemand agrees with credential-domain Team pages without revealing content', async () => {
    await fixture.assertKnownGoodSessionControl(owner, machine);
    const summary = await owner.execute('teams.sharedResources.summary' as ActionId, { v: 1, teamId });
    if (!summary.ok) throw new Error(`Resource summary refused (${summary.errorCode})`);
    expect(summary.ok).toBe(true);
    expect(summary.result).toMatchObject({ teamId, kinds: expect.arrayContaining([
      expect.objectContaining({ kind: 'discussions', status: 'available', count: 1 }),
      expect.objectContaining({ kind: 'savedSecrets', status: 'available', count: 1 }),
      expect.objectContaining({ kind: 'credentials', status: 'available', count: 0 }),
    ]) });
    expect(JSON.stringify(summary.result)).not.toContain('F_RESOURCE_SECRET_SENTINEL');
  });

  it('TS.F.kindPaging admits the actual Group member across exact-kind cursor pages', async () => {
    await fixture.assertKnownGoodSessionControl(owner, machine);
    const discussions: string[] = [];
    const discussionScopes: string[] = [];
    let discussionCursor: string | undefined;
    do {
      const page = await groupReader.execute('discussion.list', { sharedWithTeamId: teamId, limit: 1,
        ...(discussionCursor ? { cursor: discussionCursor } : {}) });
      if (!page.ok) throw new Error(`Group Discussion page refused (${page.errorCode})`);
      expect(page.ok).toBe(true);
      const parsed = DiscussionListResultV1Schema.parse(page.result);
      expect(parsed.discussions).toHaveLength(1);
      discussions.push(...parsed.discussions.map(row => row.id));
      discussionScopes.push(...parsed.discussions.map(row => row.sharedWithTeamScope ?? 'missing'));
      discussionCursor = parsed.nextCursor ?? undefined;
    } while (discussionCursor);
    expect(new Set(discussions).size).toBe(2);
    expect(discussions).toContain(sharedDiscussionId);
    expect(discussionScopes.sort()).toEqual(['group', 'team_and_group']);
    const secrets: string[] = [];
    const secretScopes: string[] = [];
    let secretCursor: string | undefined;
    do {
      const page = await groupReader.execute('secrets.shared.list', { sharedWithTeamId: teamId, limit: 1,
        ...(secretCursor ? { cursor: secretCursor } : {}) });
      if (!page.ok) throw new Error(`Group Saved Secret page refused (${page.errorCode})`);
      expect(page.ok).toBe(true);
      const parsed = SharedSavedSecretListOutputV1Schema.parse(page.result);
      expect(parsed.resources).toHaveLength(1);
      secrets.push(...parsed.resources.flatMap(row => 'ref' in row ? [row.ref] : []));
      secretScopes.push(...parsed.resources.map(row => row.sharedWithTeamScope ?? 'missing'));
      secretCursor = 'nextCursor' in parsed && typeof parsed.nextCursor === 'string' ? parsed.nextCursor : undefined;
    } while (secretCursor);
    expect(new Set(secrets).size).toBe(2);
    expect(secretScopes.sort()).toEqual(['group', 'team_and_group']);
    const summary = await groupReader.execute('teams.sharedResources.summary' as ActionId, { v: 1, teamId });
    if (!summary.ok) throw new Error(`Group resource summary refused (${summary.errorCode})`);
    expect(summary.ok).toBe(true);
    expect(summary.result).toMatchObject({ kinds: expect.arrayContaining([
      expect.objectContaining({ kind: 'discussions', status: 'available', count: 2 }),
      expect.objectContaining({ kind: 'savedSecrets', status: 'available', count: 2 }),
    ]) });
  });

  it('TS.F.kindPaging projects only the Team arm for a reader outside the private Group', async () => {
    await fixture.assertKnownGoodSessionControl(owner, machine);
    const discussionPage = await teamOnlyReader.execute('discussion.list', { sharedWithTeamId: teamId, limit: 1 });
    if (!discussionPage.ok) throw new Error(`Team-only Discussion page refused (${discussionPage.errorCode})`);
    expect(discussionPage.ok).toBe(true);
    expect(DiscussionListResultV1Schema.parse(discussionPage.result).discussions).toEqual([
      expect.objectContaining({ id: sharedDiscussionId, sharedWithTeamScope: 'team' }),
    ]);
    const secretPage = await teamOnlyReader.execute('secrets.shared.list', { sharedWithTeamId: teamId, limit: 1 });
    if (!secretPage.ok) throw new Error(`Team-only Saved Secret page refused (${secretPage.errorCode})`);
    expect(secretPage.ok).toBe(true);
    expect(SharedSavedSecretListOutputV1Schema.parse(secretPage.result).resources).toEqual([
      expect.objectContaining({ ref: formatSharedSavedSecretRefV1(sharedSecretId), sharedWithTeamScope: 'team' }),
    ]);
  });

  it('TS.F.kindPaging reflects removed Team grants on reopen while retaining private owner access', async () => {
    await fixture.assertKnownGoodSessionControl(owner, machine);
    const removed = await owner.executeAsPerson('discussion.access.grants.remove', { discussionId: sharedDiscussionId,
      principal: { kind: 'team', teamId } });
    expect(removed.ok).toBe(true);
    const groupRemoved = await owner.executeAsPerson('discussion.access.grants.remove', { discussionId: sharedDiscussionId,
      principal: { kind: 'group', teamId, groupId } });
    expect(groupRemoved.ok).toBe(true);
    const secrets = await owner.executeAsPerson('secrets.shared.grants.set', { resourceId: sharedSecretId,
      expectedRevision: 1, accountGrants: [], teamGrants: [], groupGrants: [] });
    expect(secrets.ok).toBe(true);
    const listed = await owner.execute('discussion.list', { sharedWithTeamId: teamId, limit: 1 });
    if (!listed.ok) throw new Error(`Discussion page refused (${listed.errorCode})`);
    expect(listed.ok).toBe(true);
    expect(DiscussionListResultV1Schema.parse(listed.result).discussions).toEqual([]);
    const secretPage = await owner.execute('secrets.shared.list', { sharedWithTeamId: teamId, limit: 1 });
    if (!secretPage.ok) throw new Error(`Saved Secret page refused (${secretPage.errorCode})`);
    expect(secretPage.ok).toBe(true);
    expect(SharedSavedSecretListOutputV1Schema.parse(secretPage.result).resources).toEqual([]);
    const detail = await owner.execute('discussion.get', { discussionId: sharedDiscussionId });
    expect(detail.ok).toBe(true);
  });
});
