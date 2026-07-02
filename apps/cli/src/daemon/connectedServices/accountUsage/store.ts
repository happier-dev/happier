import {
  ProviderAccountUsageAdoptionV1Schema,
  ProviderAccountUsageSnapshotV1Schema,
  normalizeProviderAccountUsageAliases,
  type ProviderAccountUsageAdoptionV1,
  type ProviderAccountUsageAliasV1,
  type ProviderAccountUsageRecordKeyV1,
  type ProviderAccountUsageRecordId,
  type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';

type AliasLookup = Readonly<{
  kind: string;
  providerId: string;
  serviceId?: string;
  profileId?: string;
  groupId?: string;
  pluginId?: string;
  localCredentialRef?: string;
  sessionId?: string;
}>;

export type ProviderAccountUsageStore = Readonly<{
  recordSnapshot(snapshot: ProviderAccountUsageSnapshotV1): Readonly<{ status: 'recorded'; recordId: ProviderAccountUsageRecordId }>;
  resolveRecordId(recordId: string): ProviderAccountUsageSnapshotV1 | null;
  resolveByAlias(alias: AliasLookup): ProviderAccountUsageSnapshotV1 | null;
  listSnapshots(): readonly ProviderAccountUsageSnapshotV1[];
  applyAdoption(adoption: ProviderAccountUsageAdoptionV1): Readonly<{
    status: 'adopted' | 'already_adopted';
    fromRecordId: ProviderAccountUsageRecordId;
    toRecordId: ProviderAccountUsageRecordId;
  }>;
}>;

function mergeAliases(
  left: readonly ProviderAccountUsageAliasV1[],
  right: readonly ProviderAccountUsageAliasV1[],
): readonly ProviderAccountUsageAliasV1[] {
  return normalizeProviderAccountUsageAliases([...left, ...right]);
}

function remapAliasesToSubject(
  aliases: readonly ProviderAccountUsageAliasV1[],
  accountSubjectId: string,
): readonly ProviderAccountUsageAliasV1[] {
  return aliases.map((alias) => ({
    ...alias,
    accountSubjectId,
  }));
}

function aliasMatchesLookup(alias: ProviderAccountUsageAliasV1, lookup: AliasLookup): boolean {
  if (alias.kind !== lookup.kind || alias.providerId !== lookup.providerId) return false;
  if (lookup.serviceId !== undefined && alias.serviceId !== lookup.serviceId) return false;
  if (lookup.profileId !== undefined && alias.profileId !== lookup.profileId) return false;
  if (lookup.groupId !== undefined && alias.groupId !== lookup.groupId) return false;
  if (lookup.pluginId !== undefined && alias.pluginId !== lookup.pluginId) return false;
  if (lookup.localCredentialRef !== undefined && alias.localCredentialRef !== lookup.localCredentialRef) return false;
  if (lookup.sessionId !== undefined && alias.sessionId !== lookup.sessionId) return false;
  return true;
}

export function createProviderAccountUsageStore(): ProviderAccountUsageStore {
  const snapshotsByRecordId = new Map<string, ProviderAccountUsageSnapshotV1>();
  const redirectsByRecordId = new Map<string, string>();
  const stableRecordKeysByRecordId = new Map<string, ProviderAccountUsageRecordKeyV1>();
  const adoptionAliasesByRecordId = new Map<string, readonly ProviderAccountUsageAliasV1[]>();

  function resolveRedirect(recordId: string): string {
    let current = recordId;
    const seen = new Set<string>();
    while (redirectsByRecordId.has(current) && !seen.has(current)) {
      seen.add(current);
      current = redirectsByRecordId.get(current) ?? current;
    }
    return current;
  }

  function redirectChainContains(startRecordId: string, targetRecordId: string): boolean {
    let current = startRecordId;
    const seen = new Set<string>();
    while (!seen.has(current)) {
      if (current === targetRecordId) return true;
      seen.add(current);
      const next = redirectsByRecordId.get(current);
      if (!next) return false;
      current = next;
    }
    return false;
  }

  function recordSnapshot(snapshot: ProviderAccountUsageSnapshotV1): Readonly<{ status: 'recorded'; recordId: ProviderAccountUsageRecordId }> {
    const parsed = ProviderAccountUsageSnapshotV1Schema.parse(snapshot);
    const targetRecordId = resolveRedirect(parsed.recordId);
    const existing = snapshotsByRecordId.get(targetRecordId);
    const targetRecordKey =
      targetRecordId === parsed.recordId
        ? parsed.recordKey
        : existing?.recordKey ?? stableRecordKeysByRecordId.get(targetRecordId);
    if (!targetRecordKey) {
      throw new Error(`Missing provider account usage adoption target key for ${targetRecordId}`);
    }
    const targetAliases =
      targetRecordId === parsed.recordId
        ? parsed.aliases
        : remapAliasesToSubject(parsed.aliases, targetRecordKey.accountSubjectId);
    const adoptionAliases = adoptionAliasesByRecordId.get(targetRecordId) ?? [];
    const aliases = mergeAliases(existing?.aliases ?? adoptionAliases, targetAliases);
    if (existing && parsed.fetchedAtMs < existing.fetchedAtMs) {
      snapshotsByRecordId.set(targetRecordId, ProviderAccountUsageSnapshotV1Schema.parse({
        ...existing,
        aliases: [...aliases],
      }));
      if (targetRecordId !== parsed.recordId) snapshotsByRecordId.delete(parsed.recordId);
      return { status: 'recorded', recordId: targetRecordId as ProviderAccountUsageRecordId };
    }
    const next: ProviderAccountUsageSnapshotV1 = {
      ...parsed,
      recordId: targetRecordId,
      recordKey: targetRecordKey,
      providerId: targetRecordKey.providerId,
      accountSubject: targetRecordId === parsed.recordId
        ? parsed.accountSubject
        : existing?.accountSubject ?? {
          kind: 'providerSubject',
          id: targetRecordKey.accountSubjectId,
        },
      aliases: [...aliases],
    };
    snapshotsByRecordId.set(targetRecordId, ProviderAccountUsageSnapshotV1Schema.parse(next));
    if (targetRecordId !== parsed.recordId) snapshotsByRecordId.delete(parsed.recordId);
    return { status: 'recorded', recordId: targetRecordId as ProviderAccountUsageRecordId };
  }

  function applyAdoption(adoption: ProviderAccountUsageAdoptionV1): Readonly<{
    status: 'adopted' | 'already_adopted';
    fromRecordId: ProviderAccountUsageRecordId;
    toRecordId: ProviderAccountUsageRecordId;
  }> {
    const parsed = ProviderAccountUsageAdoptionV1Schema.parse(adoption);
    const existingRedirect = resolveRedirect(parsed.fromRecordId);
    if (existingRedirect !== parsed.fromRecordId) {
      if (existingRedirect === parsed.toRecordId) {
        return { status: 'already_adopted', fromRecordId: parsed.fromRecordId, toRecordId: parsed.toRecordId };
      }
      throw new Error(
        `Provider account usage record ${parsed.fromRecordId} is already adopted to ${existingRedirect}`,
      );
    }
    if (redirectChainContains(parsed.toRecordId, parsed.fromRecordId)) {
      throw new Error(`Provider account usage adoption would create a redirect cycle from ${parsed.fromRecordId} to ${parsed.toRecordId}`);
    }
    if (parsed.stableRecordKey.subjectKind === 'unknown') {
      throw new Error('Provider account usage adoption requires a stable target subject');
    }
    const fromSnapshot = snapshotsByRecordId.get(parsed.fromRecordId);
    if (fromSnapshot && fromSnapshot.accountSubject.kind !== 'provisionalLocalSubject') {
      throw new Error(`Provider account usage adoption source ${parsed.fromRecordId} is not provisional`);
    }
    redirectsByRecordId.set(parsed.fromRecordId, parsed.toRecordId);
    stableRecordKeysByRecordId.set(parsed.toRecordId, parsed.stableRecordKey);
    const toSnapshot = snapshotsByRecordId.get(parsed.toRecordId);
    const remappedFromAliases = fromSnapshot
      ? remapAliasesToSubject(fromSnapshot.aliases, parsed.stableRecordKey.accountSubjectId)
      : [];
    const adoptionAliases = mergeAliases(
      adoptionAliasesByRecordId.get(parsed.toRecordId) ?? [],
      mergeAliases(remappedFromAliases, parsed.aliases),
    );
    adoptionAliasesByRecordId.set(parsed.toRecordId, adoptionAliases);
    if (toSnapshot) {
      snapshotsByRecordId.set(parsed.toRecordId, {
        ...toSnapshot,
        aliases: [...mergeAliases(toSnapshot.aliases, adoptionAliases)],
      });
    } else if (fromSnapshot) {
      snapshotsByRecordId.set(parsed.toRecordId, ProviderAccountUsageSnapshotV1Schema.parse({
        ...fromSnapshot,
        recordId: parsed.toRecordId,
        recordKey: parsed.stableRecordKey,
        providerId: parsed.providerId,
        accountSubject: {
          kind: 'providerSubject',
          id: parsed.stableRecordKey.accountSubjectId,
        },
        aliases: [...adoptionAliases],
      }));
    }
    if (fromSnapshot) snapshotsByRecordId.delete(parsed.fromRecordId);
    return { status: 'adopted', fromRecordId: parsed.fromRecordId, toRecordId: parsed.toRecordId };
  }

  function resolveRecordId(recordId: string): ProviderAccountUsageSnapshotV1 | null {
    return snapshotsByRecordId.get(resolveRedirect(recordId)) ?? null;
  }

  function listSnapshots(): readonly ProviderAccountUsageSnapshotV1[] {
    return [...snapshotsByRecordId.entries()]
      .filter(([recordId]) => resolveRedirect(recordId) === recordId)
      .map(([, snapshot]) => snapshot)
      .sort((left, right) => left.recordId.localeCompare(right.recordId));
  }

  function resolveByAlias(alias: AliasLookup): ProviderAccountUsageSnapshotV1 | null {
    for (const snapshot of listSnapshots()) {
      if (snapshot.aliases.some((candidate) => aliasMatchesLookup(candidate, alias))) {
        return snapshot;
      }
    }
    return null;
  }

  return {
    recordSnapshot,
    resolveRecordId,
    resolveByAlias,
    listSnapshots,
    applyAdoption,
  };
}
