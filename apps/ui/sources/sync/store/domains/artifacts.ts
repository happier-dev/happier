import { settleMountedWidgetAreaLayoutDeletion } from '../../domains/widgets/widgetAreaLayoutSelection';
import type { DecryptedArtifact } from '../../domains/artifacts/artifactTypes';
import type { ArtifactInventoryPublication, ArtifactInventorySelection } from '../../domains/artifacts/artifactInventory';
import { doesArtifactInventoryViewMatchRow, readArtifactBrowserMembership, isApprovalSessionInventorySelection, isApprovalStateInventorySelection } from '../../domains/artifacts/artifactInventory';
import { patchInboxArtifactOrder, readInboxArtifactEntry, type InboxArtifactEntry, type InboxArtifactOrderChange } from '../../domains/artifacts/inboxArtifacts';
import type { ListedOpenApproval, OpenApprovalInboxEntry } from '../../domains/artifacts/approvalArtifactAdmission';
import { APPROVAL_ARTIFACT_KINDS_V1 } from '@happier-dev/protocol/approvals/approvalArtifactKindV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { StoreGet, StoreSet } from './_shared';
import type { ServerAccountScope } from '../../domains/scope/serverAccountScope';
import { reconcileFailedApprovalDismissals, retireFailedApprovalDismissals } from '../../domains/state/failedApprovalUiState';
import { readApprovalArtifactHeaderSessionIds, readDiscussionRequesterApprovalFact,
  readWorkflowPublicationApprovalRunId } from '../../domains/artifacts/approvalArtifactAdmission';
import { projectArtifactInventoryIndex, selectArtifactInventoryRows, type ArtifactInventoryIndex } from './artifactInventoryIndex';
import { projectWidgetAreaLayoutPublications, type WidgetAreaLayoutPublications } from './widgetAreaLayoutPublications';
import { patchEnvironmentHealthNotices, type EnvironmentHealthNotices } from '../../domains/artifacts/healthNoticeEnvironments';

type ApprovalArtifactGroups = Record<string, Record<string, DecryptedArtifact>>;

/** Patch only the relationships of the admitted changed row. Home matching remains live at read time. */
function patchApprovalArtifactGroups(
  groups: ApprovalArtifactGroups,
  baseline: ApprovalArtifactGroups,
  id: string,
  previousKeys: readonly string[],
  nextKeys: readonly string[],
  artifact: DecryptedArtifact | null,
  projection: 'session' | 'discussion' | 'workflow',
  removedGroups: Set<string>,
): ApprovalArtifactGroups {
  for (const key of new Set([...previousKeys, ...nextKeys])) {
    const current = groups[key];
    const next = artifact && nextKeys.includes(key) ? artifact : null;
    if (next ? current?.[id] === next : !current?.[id]) continue;
    const previous = current?.[id];
    // Session readers consume the admitted request/relationship, not freshness or
    // grant-enrichment carriers. Decisions still read the current Artifact by id.
    // Discussion receipts consume the full revision record and never use this projection.
    if (projection !== 'discussion' && previous && next && previous.header === next.header && previous.body === next.body
      && previous.sessions === next.sessions && previous.sourceServerId === next.sourceServerId
      && previous.draft === next.draft && previous.isDecrypted === next.isDecrypted) continue;
    if (groups === baseline) groups = { ...groups };
    const rows = !current || current === baseline[key] ? { ...current } : current;
    if (next) rows[id] = next;
    else {
      delete rows[id];
      removedGroups.add(key);
    }
    groups[key] = rows;
  }
  return groups;
}

function retainArtifactSlices(previous: DecryptedArtifact | undefined, incoming: DecryptedArtifact): DecryptedArtifact {
  if (!previous?.isDecrypted || !incoming.isDecrypted) return incoming;
  const before = previous;
  let retained = incoming;
  function retainField<Key extends 'header' | 'rawHeader' | 'sessions' | 'body' | 'provenance' | 'storageIdentity'>(key: Key): void {
    const value = before[key];
    if (value === incoming[key] || value === null || typeof value !== 'object'
      || !sameStrictJsonValue(value, incoming[key])) return;
    if (retained === incoming) retained = { ...incoming };
    retained[key] = value;
  }
  for (const key of ['header', 'rawHeader', 'sessions', 'body', 'provenance', 'storageIdentity'] as const) retainField(key);
  return retained;
}

function retainOpenedContent(previous: DecryptedArtifact | undefined, incoming: DecryptedArtifact): DecryptedArtifact {
  if (!previous?.isDecrypted || !incoming.isDecrypted
    || incoming.bodyVersion === undefined || incoming.bodyVersion !== previous.bodyVersion
    || incoming.headerVersion !== previous.headerVersion || incoming.storageMode !== previous.storageMode
    || incoming.access === undefined || (previous.access !== undefined && incoming.access !== previous.access)
    || !incoming.ownerAccountId || (previous.ownerAccountId !== undefined && incoming.ownerAccountId !== previous.ownerAccountId)
    || !sameStrictJsonValue(incoming.rawHeader, previous.rawHeader)) return incoming;

  const sameCustody = incoming.storageMode === 'plain' || (incoming.storageMode === 'e2ee'
    && incoming.storageIdentity !== undefined && previous.storageIdentity !== undefined
    && incoming.storageIdentity.contentKeyEnvelope === previous.storageIdentity.contentKeyEnvelope
    && incoming.storageIdentity.provenanceKeyEnvelope === previous.storageIdentity.provenanceKeyEnvelope);
  if (!sameCustody) return incoming;
  // Omitted attribution was not demanded by this background index. An explicit
  // undefined from a reader that opened it still clears removed private metadata.
  const retainBody = incoming.body === undefined && previous.body !== undefined;
  // First HTTP grant enrichment confirms body access, not omitted private attribution.
  // Known grant changes still invalidate all retained content above.
  const retainProvenance = incoming.access === previous.access && incoming.ownerAccountId === previous.ownerAccountId
    && !Object.hasOwn(incoming, 'provenance') && Object.hasOwn(previous, 'provenance');
  if (!retainBody && !retainProvenance) return incoming;
  return { ...incoming, ...(retainBody ? { body: previous.body } : {}),
    ...(retainProvenance ? { provenance: previous.provenance } : {}) };
}

function reconcileArtifacts(
  previous: Record<string, DecryptedArtifact>,
  incoming: readonly DecryptedArtifact[],
): Readonly<{ artifacts: Record<string, DecryptedArtifact>; storageChanged: boolean; changedIds: readonly string[] }> {
  let next = previous;
  let storageChanged = false;
  const changedIds = new Set<string>();
  for (const incomingArtifact of incoming) {
    const before = next[incomingArtifact.id];
    // HTTP body/list reads can finish after a newer socket settlement. Admit
    // revisions here for every writer, so an older snapshot cannot reopen it.
    if (before && (incomingArtifact.headerVersion < before.headerVersion
      || (incomingArtifact.bodyVersion !== undefined && before.bodyVersion !== undefined
        && incomingArtifact.bodyVersion < before.bodyVersion))) continue;
    // Content-only socket events have no grant projection. Only HTTP/grant
    // producers can replace known access; content must neither erase nor grant it.
    const missingKnownAccess = before && (
      (incomingArtifact.access === undefined && before.access !== undefined)
      || (incomingArtifact.ownerAccountId === undefined && before.ownerAccountId !== undefined)
      || (incomingArtifact.sourceServerId === undefined && before.sourceServerId !== undefined)
    );
    const withKnownAccess = missingKnownAccess ? {
      ...incomingArtifact,
      ...(before.access !== undefined ? { access: incomingArtifact.access ?? before.access } : {}),
      ...(before.ownerAccountId !== undefined ? { ownerAccountId: incomingArtifact.ownerAccountId ?? before.ownerAccountId } : {}),
      ...(before.sourceServerId !== undefined ? { sourceServerId: incomingArtifact.sourceServerId ?? before.sourceServerId } : {}),
    } : incomingArtifact;
    const artifact = retainArtifactSlices(before, retainOpenedContent(before, withKnownAccess));
    if (sameStrictJsonValue(before, artifact)) continue;
    if (!before || before.headerVersion !== artifact.headerVersion || before.bodyVersion !== artifact.bodyVersion
      || before.storageMode !== artifact.storageMode) storageChanged = true;
    if (next === previous) next = { ...previous };
    next[artifact.id] = artifact;
    changedIds.add(artifact.id);
  }
  return { artifacts: next, storageChanged, changedIds: [...changedIds] };
}

function skillRevision(artifact: DecryptedArtifact | undefined): string | undefined {
  return artifact && !artifact.draft && artifact.header?.kind === 'prompt_bundle.v2'
    && artifact.header.bundleSchemaId === 'skills.skill_md_v1'
    ? `${artifact.id}@${artifact.headerVersion}:${artifact.bodyVersion ?? 0}` : undefined;
}

function inventoryUnready(artifact: DecryptedArtifact | undefined): boolean {
  if (!artifact || artifact.draft) return false;
  const kind = artifact.rawHeader?.kind ?? artifact.header?.kind ?? artifact.kindHint;
  // A known other kind cannot change Skills membership. Unknown opaque rows
  // may be bundles and keep the library's currentness check conservative.
  return (typeof kind !== 'string' || kind === 'prompt_bundle.v2')
    && (!artifact.isDecrypted || !artifact.rawHeader || artifact.access === undefined);
}

function browserUnready(artifact: DecryptedArtifact | undefined): boolean {
  return artifact !== undefined && readArtifactBrowserMembership(artifact) !== false
    && (!artifact.isDecrypted || !artifact.rawHeader);
}

function approvalArtifactCandidate(artifact: DecryptedArtifact | undefined): DecryptedArtifact | null {
  return artifact && !artifact.draft
    && Object.values(APPROVAL_ARTIFACT_KINDS_V1).some(kind => kind === artifact.header?.kind) ? artifact : null;
}

/** Publish narrow inventory inputs at the same ingress as the admitted Artifact rows. */
function projectArtifactInventory(state: ArtifactsDomain, artifacts: Record<string, DecryptedArtifact>, changedIds: Iterable<string>) {
  let revisions = state.artifactSkillRevisions;
  let unreadyCount = state.artifactInventoryUnreadyCount;
  let browserLoaded = state.artifactBrowserLoaded;
  let workflowApprovals = state.artifactWorkflowPublicationArtifactsByRunId;
  let unclassifiedWorkflowApprovals = state.artifactUnclassifiedWorkflowPublicationArtifacts;
  const removedWorkflowGroups = new Set<string>();
  let inbox = state.artifactInboxEntries;
  const inboxOrderChanges: InboxArtifactOrderChange[] = [];
  let environmentHealth = state.artifactHealthNoticesByEnvironmentId;
  let openApprovals = state.artifactOpenApprovalEntries;
  let listedApprovals = state.artifactListedOpenApprovals;
  let discussionAttention = state.artifactDiscussionAttentionEntries;
  let incompleteInbox = state.artifactIncompleteInboxArtifacts;
  let browser = state.artifactBrowserArtifacts;
  let prompts = state.artifactPromptLibraryArtifacts;
  let sessionApprovals = state.artifactApprovalArtifactsBySessionId;
  let discussionApprovals = state.artifactApprovalArtifactsByDiscussionId;
  const removedSessionGroups = new Set<string>();
  const removedDiscussionGroups = new Set<string>();
  for (const id of changedIds) {
    const artifact = artifacts[id];
    const beforeApproval = approvalArtifactCandidate(state.artifacts[id]);
    const approval = approvalArtifactCandidate(artifact);
    if (approval || beforeApproval) {
      sessionApprovals = patchApprovalArtifactGroups(sessionApprovals, state.artifactApprovalArtifactsBySessionId, id,
        beforeApproval ? readApprovalArtifactHeaderSessionIds(beforeApproval) : [],
        approval ? readApprovalArtifactHeaderSessionIds(approval) : [], approval, 'session', removedSessionGroups);
      const beforeDiscussion = beforeApproval ? readDiscussionRequesterApprovalFact(beforeApproval)?.discussion.discussionId : undefined;
      const discussion = approval ? readDiscussionRequesterApprovalFact(approval)?.discussion.discussionId : undefined;
      discussionApprovals = patchApprovalArtifactGroups(discussionApprovals, state.artifactApprovalArtifactsByDiscussionId, id,
        beforeDiscussion ? [beforeDiscussion] : [], discussion ? [discussion] : [], approval, 'discussion', removedDiscussionGroups);
    }
    const inboxEntry = artifact ? readInboxArtifactEntry(artifact) : null;
    environmentHealth = patchEnvironmentHealthNotices(environmentHealth, state.artifactHealthNoticesByEnvironmentId,
      id, state.artifactInboxEntries[id], inboxEntry);
    const openApproval = inboxEntry?.openApproval ?? null;
    if (openApproval || openApprovals[id]) {
      if (openApprovals === state.artifactOpenApprovalEntries) openApprovals = { ...openApprovals };
      if (openApproval) openApprovals[id] = openApproval; else delete openApprovals[id];
    }
    const listed = inboxEntry?.listedApproval ?? null;
    if (listed || listedApprovals[id]) {
      if (listedApprovals === state.artifactListedOpenApprovals) listedApprovals = { ...listedApprovals };
      if (listed) listedApprovals[id] = listed; else delete listedApprovals[id];
    }
    const attention = listed?.discussionAttention ? listed : null;
    if (attention || discussionAttention[id]) {
      if (discussionAttention === state.artifactDiscussionAttentionEntries) discussionAttention = { ...discussionAttention };
      if (attention) discussionAttention[id] = attention; else delete discussionAttention[id];
    }
    const incomplete = inboxEntry && !inboxEntry.complete ? artifact : null;
    if (incomplete || incompleteInbox[id]) {
      if (incompleteInbox === state.artifactIncompleteInboxArtifacts) incompleteInbox = { ...incompleteInbox };
      if (incomplete) incompleteInbox[id] = incomplete; else delete incompleteInbox[id];
    }
    if (inboxEntry || inbox[id]) {
      if (inbox === state.artifactInboxEntries) inbox = { ...inbox };
      inboxOrderChanges.push({ previous: state.artifactInboxEntries[id], next: inboxEntry ?? undefined });
      if (inboxEntry) inbox[id] = inboxEntry; else delete inbox[id];
    }
    const browserRow = artifact && doesArtifactInventoryViewMatchRow('browserListed', artifact) ? artifact : null;
    if (browserRow || browser[id]) {
      if (browser === state.artifactBrowserArtifacts) browser = { ...browser };
      if (browserRow) browser[id] = browserRow; else delete browser[id];
    }
    const promptRow = artifact && doesArtifactInventoryViewMatchRow('promptLibrary', artifact) ? artifact : null;
    if (promptRow || prompts[id]) {
      if (prompts === state.artifactPromptLibraryArtifacts) prompts = { ...prompts };
      if (promptRow) prompts[id] = promptRow; else delete prompts[id];
    }
    const beforeRunId = readWorkflowPublicationApprovalRunId(state.artifacts[id]);
    const runId = readWorkflowPublicationApprovalRunId(artifact);
    workflowApprovals = patchApprovalArtifactGroups(workflowApprovals, state.artifactWorkflowPublicationArtifactsByRunId, id,
      typeof beforeRunId === 'string' ? [beforeRunId] : [], typeof runId === 'string' ? [runId] : [],
      artifact ?? null, 'workflow', removedWorkflowGroups);
    const unclassified = runId === undefined ? artifact : undefined;
    if (unclassifiedWorkflowApprovals[id] !== unclassified) {
      if (unclassifiedWorkflowApprovals === state.artifactUnclassifiedWorkflowPublicationArtifacts) {
        unclassifiedWorkflowApprovals = { ...unclassifiedWorkflowApprovals };
      }
      if (unclassified) unclassifiedWorkflowApprovals[id] = unclassified;
      else delete unclassifiedWorkflowApprovals[id];
    }
    const revision = skillRevision(artifacts[id]);
    if (revision !== revisions[id]) {
      if (revisions === state.artifactSkillRevisions) revisions = { ...revisions };
      if (revision === undefined) delete revisions[id]; else revisions[id] = revision;
    }
    unreadyCount += Number(inventoryUnready(artifacts[id])) - Number(inventoryUnready(state.artifacts[id]));
    if (browserLoaded && browserUnready(artifacts[id])) browserLoaded = false;
  }
  // Relationship removals share this synchronous publication. Retire each
  // touched bucket only after its complete changed-id batch has applied.
  for (const [groups, removedGroups] of [[sessionApprovals, removedSessionGroups], [discussionApprovals, removedDiscussionGroups],
    [workflowApprovals, removedWorkflowGroups]] as const) {
    for (const key of removedGroups) if (Object.keys(groups[key]!).length === 0) delete groups[key];
  }
  return { artifactSkillRevisions: revisions, artifactInventoryUnreadyCount: unreadyCount, artifactBrowserLoaded: browserLoaded,
    artifactInventoryIndex: projectArtifactInventoryIndex(state.artifactInventoryIndex, state.artifacts, artifacts, changedIds),
    artifactWidgetAreaLayoutPublications: projectWidgetAreaLayoutPublications(state.artifactWidgetAreaLayoutPublications, state.artifacts, artifacts, changedIds),
    artifactApprovalArtifactsBySessionId: sessionApprovals,
    artifactApprovalArtifactsByDiscussionId: discussionApprovals,
    artifactHealthNoticesByEnvironmentId: environmentHealth,
    artifactInboxEntries: inbox, artifactInboxOrder: patchInboxArtifactOrder(state.artifactInboxOrder, inboxOrderChanges),
    artifactOpenApprovalEntries: openApprovals,
    artifactListedOpenApprovals: listedApprovals,
    artifactDiscussionAttentionEntries: discussionAttention, artifactIncompleteInboxArtifacts: incompleteInbox,
    artifactBrowserArtifacts: browser, artifactPromptLibraryArtifacts: prompts,
    artifactWorkflowPublicationArtifactsByRunId: workflowApprovals,
    artifactUnclassifiedWorkflowPublicationArtifacts: unclassifiedWorkflowApprovals };
}

export type ArtifactsDomain = {
  artifacts: Record<string, DecryptedArtifact>;
  /** Changed-id query membership; selected refreshes never enumerate the retained Account map. */
  artifactInventoryIndex: ArtifactInventoryIndex;
  artifactWidgetAreaLayoutPublications: WidgetAreaLayoutPublications;
  /** Raw approval relationship buckets, maintained from changed ids by the Artifact owner. */
  artifactApprovalArtifactsBySessionId: ApprovalArtifactGroups;
  artifactApprovalArtifactsByDiscussionId: ApprovalArtifactGroups;
  /** Selection membership is projected once at admission, never by whole-inventory subscribers. */
  artifactBrowserArtifacts: Record<string, DecryptedArtifact>;
  artifactPromptLibraryArtifacts: Record<string, DecryptedArtifact>;
  artifactInboxEntries: Record<string, InboxArtifactEntry>;
  /** The same entries newest first, merged per applied page; retained entries are never re-sorted. */
  artifactInboxOrder: readonly InboxArtifactEntry[];
  /** Private C1 health relationships, keyed by authenticated Home/Account/Environment. */
  artifactHealthNoticesByEnvironmentId: EnvironmentHealthNotices;
  /** Strictly admitted open requests; notices and settled receipt changes retain this identity. */
  artifactOpenApprovalEntries: Record<string, OpenApprovalInboxEntry>;
  /** Listed open requests (header facts; body admission once read): the Inbox list's approval rows. */
  artifactListedOpenApprovals: Record<string, ListedOpenApproval>;
  /** Actual Discussion links only (header list facts); unrelated open requests retain this input identity. */
  artifactDiscussionAttentionEntries: Record<string, ListedOpenApproval>;
  /** Incomplete admissions only; completed open requests never restart body selection. */
  artifactIncompleteInboxArtifacts: Record<string, DecryptedArtifact>;
  /** Header-selected Run relationships; strict body admission remains at the approval owner. */
  artifactWorkflowPublicationArtifactsByRunId: ApprovalArtifactGroups;
  /** Only legacy headers without a classified Run relation still need discovery bodies. */
  artifactUnclassifiedWorkflowPublicationArtifacts: Record<string, DecryptedArtifact>;
  /** Content revisions only; unrelated Artifacts and body hydration retain this identity. */
  artifactSkillRevisions: Record<string, string>;
  /** Potential Skill bundles (including unknown rows) whose membership/access is not yet readable. */
  artifactInventoryUnreadyCount: number;
  /** A complete Account inventory was published; targeted body reads do not set this. */
  artifactsLoaded: boolean;
  /** Exhausted readable browser membership; never certifies private kinds or full Account membership. */
  artifactBrowserLoaded: boolean;
  /** Open approval membership and notice membership; never certifies settled approvals. */
  artifactInboxLoaded: boolean;
  artifactInboxPartial: boolean;
  /** Exact header memberships completed by the same inventory owner; never implies full membership. */
  artifactInventoryKindsLoaded: readonly string[];
  /** Exhausted scoped reads with locked structural rows: renderable, never complete classification. */
  artifactInventoryKindsPartial: readonly string[];
  /** Invalidates the storage projection, not local hydration or grant-only changes. */
  artifactsStorageRevision: number;
  applyArtifacts: (artifacts: DecryptedArtifact[], inventoryReadStartedWith?: Readonly<Record<string, DecryptedArtifact>>,
    inventorySelection?: ArtifactInventorySelection, publication?: ArtifactInventoryPublication) => void;
  addArtifact: (artifact: DecryptedArtifact) => void;
  updateArtifact: (artifact: DecryptedArtifact) => void;
  deleteArtifact: (artifactId: string, reason?: 'deleted' | 'unavailable') => void;
};

export function createArtifactsDomain<S extends ArtifactsDomain & { profileScope?: ServerAccountScope | null }>({
  set,
  get,
}: {
  set: StoreSet<S>;
  get: StoreGet<S>;
}): ArtifactsDomain {
  return {
    artifacts: {},
    artifactInventoryIndex: new Map(),
    artifactWidgetAreaLayoutPublications: { byArtifactId: new Map(), bySurface: new Map() },
    artifactApprovalArtifactsBySessionId: {},
    artifactApprovalArtifactsByDiscussionId: {},
    artifactBrowserArtifacts: {},
    artifactPromptLibraryArtifacts: {},
    artifactInboxEntries: {},
    artifactInboxOrder: [],
    artifactHealthNoticesByEnvironmentId: {},
    artifactOpenApprovalEntries: {},
    artifactListedOpenApprovals: {},
    artifactDiscussionAttentionEntries: {},
    artifactIncompleteInboxArtifacts: {},
    artifactWorkflowPublicationArtifactsByRunId: {},
    artifactUnclassifiedWorkflowPublicationArtifacts: {},
    artifactSkillRevisions: {},
    artifactInventoryUnreadyCount: 0,
    artifactsLoaded: false,
    artifactBrowserLoaded: false,
    artifactInboxLoaded: false,
    artifactInboxPartial: false,
    artifactInventoryKindsLoaded: [],
    artifactInventoryKindsPartial: [],
    artifactsStorageRevision: 0,
    applyArtifacts: (artifacts, inventoryReadStartedWith, inventorySelection, publication = 'inventory') =>
      set((state) => {
        const inventoryKinds = typeof inventorySelection === 'string' || isApprovalSessionInventorySelection(inventorySelection)
          || isApprovalStateInventorySelection(inventorySelection) ? undefined : inventorySelection;
        // The immutable map captured before the read distinguishes a missing
        // inventory member from a socket/create/update that raced that read.
        const admitted = inventoryReadStartedWith ? artifacts.filter(artifact =>
          !(inventoryReadStartedWith[artifact.id] && !state.artifacts[artifact.id])) : artifacts;
        const merged = reconcileArtifacts(state.artifacts, admitted);
        let reconciled = merged.artifacts;
        let removed = false;
        const retiredIds: string[] = [];
        const changedIds = new Set(merged.changedIds);
        const complete = inventoryReadStartedWith !== undefined && publication === 'inventory';
        const exhausted = inventoryReadStartedWith !== undefined && publication !== 'partial';
        const members = inventoryReadStartedWith && exhausted ? new Set(artifacts.map(artifact => artifact.id)) : null;
        const observesBrowser = inventorySelection === undefined || inventorySelection === 'browserListed';
        let browserOpaqueSurvivor = false;
        if (inventoryReadStartedWith && members) {
          for (const [id, artifact] of Object.entries(selectArtifactInventoryRows(state, inventorySelection))) {
            if (!members.has(id) && artifact === inventoryReadStartedWith[id]) {
              if (reconciled === state.artifacts) reconciled = { ...reconciled };
              delete reconciled[id];
              retiredIds.push(id);
              changedIds.add(id);
              removed = true;
            }
          }
          // Unknown retained rows may be browser members without being selected
          // for absence reconciliation. Private approval history is not a browser input.
          if (observesBrowser) browserOpaqueSurvivor = Object.keys(state.artifactBrowserArtifacts)
            .some(id => browserUnready(reconciled[id]));
        }
        if (complete && members && inventorySelection === undefined) {
          reconcileFailedApprovalDismissals(state.profileScope, id => members.has(id) || Object.hasOwn(reconciled, id));
        } else if (complete && retiredIds.length > 0) retireFailedApprovalDismissals(state.profileScope, retiredIds);
        const loaded = state.artifactsLoaded || (complete && inventorySelection === undefined);
        const inboxLoaded = inventorySelection === 'inboxOpen' && exhausted
          ? complete : state.artifactInboxLoaded;
        const inboxPartial = inventorySelection === 'inboxOpen' && exhausted
          ? !complete : state.artifactInboxPartial;
        const projected = projectArtifactInventory(state, reconciled, changedIds);
        let browserLoaded = projected.artifactBrowserLoaded;
        if (inventoryReadStartedWith && observesBrowser) {
          if (publication === 'unreadable') browserLoaded = false;
          else if (complete) browserLoaded = artifacts.every(artifact => artifact.isDecrypted && artifact.rawHeader)
            && !browserOpaqueSurvivor;
        }
        const previousKinds = state.artifactInventoryKindsLoaded;
        const opaqueKinds = inventoryReadStartedWith !== undefined && publication === 'unreadable' ? inventoryKinds : undefined;
        const loadedKinds = complete && inventoryKinds?.some(kind => !previousKinds.includes(kind))
          ? [...new Set([...previousKinds, ...inventoryKinds])].sort() : previousKinds;
        const classifiedKinds = opaqueKinds && previousKinds.some(kind => opaqueKinds.includes(kind))
          ? loadedKinds.filter(kind => !opaqueKinds.includes(kind)) : loadedKinds;
        const previousPartial = state.artifactInventoryKindsPartial;
        const partialKinds = opaqueKinds && opaqueKinds.some(kind => !previousPartial.includes(kind))
          ? [...new Set([...previousPartial, ...opaqueKinds])].sort()
          : complete && inventoryKinds && previousPartial.some(kind => inventoryKinds.includes(kind))
            ? previousPartial.filter(kind => !inventoryKinds.includes(kind)) : previousPartial;
        if (reconciled === state.artifacts && loaded === state.artifactsLoaded && browserLoaded === state.artifactBrowserLoaded
          && inboxLoaded === state.artifactInboxLoaded && inboxPartial === state.artifactInboxPartial && classifiedKinds === previousKinds
          && partialKinds === previousPartial) return state;
        return {
          ...state,
          artifacts: reconciled,
          ...projected,
          artifactsLoaded: loaded,
          artifactBrowserLoaded: browserLoaded,
          artifactInboxLoaded: inboxLoaded,
          artifactInboxPartial: inboxPartial,
          artifactInventoryKindsLoaded: classifiedKinds,
          artifactInventoryKindsPartial: partialKinds,
          artifactsStorageRevision: state.artifactsStorageRevision + Number(merged.storageChanged || removed),
        };
      }),
    addArtifact: (artifact) =>
      set((state) => {
        const updated = reconcileArtifacts(state.artifacts, [artifact]);
        if (updated.artifacts === state.artifacts) return state;
        return {
          ...state,
          artifacts: updated.artifacts,
          ...projectArtifactInventory(state, updated.artifacts, updated.changedIds),
          artifactsStorageRevision: state.artifactsStorageRevision + Number(updated.storageChanged),
        };
      }),
    updateArtifact: (artifact) =>
      set((state) => {
        const updated = reconcileArtifacts(state.artifacts, [artifact]);
        if (updated.artifacts === state.artifacts) return state;
        return {
          ...state,
          artifacts: updated.artifacts,
          ...projectArtifactInventory(state, updated.artifacts, updated.changedIds),
          artifactsStorageRevision: state.artifactsStorageRevision + Number(updated.storageChanged),
        };
      }),
    deleteArtifact: (artifactId, reason = 'deleted') => {
      const current = get();
      retireFailedApprovalDismissals(current.profileScope, [artifactId]);
      if (!Object.prototype.hasOwnProperty.call(current.artifacts, artifactId)) return;
      // A failed read retires a local row without changing the person's selected layout.
      if (reason === 'deleted') settleMountedWidgetAreaLayoutDeletion(artifactId);
      set((state) => {
        const { [artifactId]: _, ...remainingArtifacts } = state.artifacts;

        return {
          ...state,
          artifacts: remainingArtifacts,
          ...projectArtifactInventory(state, remainingArtifacts, [artifactId]),
          artifactsStorageRevision: state.artifactsStorageRevision + 1,
        };
      });
    },
  };
}
