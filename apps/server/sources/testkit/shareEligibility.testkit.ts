import { db } from '@/storage/db';

/**
 * Fixture setup for tests that share a resource through its real grant writer:
 * makes each recipient the sharer's accepted friend, which the one
 * share-eligibility rule (`app/teams/shareEligibility.ts`) admits.
 */
export async function makeShareEligibleForTest(
  sharerAccountId: string,
  recipientAccountIds: string | readonly string[],
  client: Pick<typeof db, "userRelationship"> = db,
): Promise<void> {
  for (const toUserId of typeof recipientAccountIds === 'string'
    ? [recipientAccountIds]
    : recipientAccountIds) {
    if (toUserId === sharerAccountId) continue;
    await client.userRelationship.upsert({
      where: { fromUserId_toUserId: { fromUserId: sharerAccountId, toUserId } },
      create: { fromUserId: sharerAccountId, toUserId, status: 'friend' },
      update: { status: 'friend' },
    });
  }
}
