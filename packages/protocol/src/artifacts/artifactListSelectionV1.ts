import { deriveArtifactCoarseKindV1, deriveArtifactKindV1, type ArtifactCoarseKindV1, type ArtifactKindCoverageV1 } from './artifactKindV1.js';
import { deriveApprovalArtifactQueryHintsV1, isApprovalArtifactKindV1, type ApprovalArtifactStateV1 } from '../approvals/approvalArtifactKindV1.js';
import { throwIfAborted } from '../abortSignal.js';
import { getArtifactKindPolicyV1 } from './artifactSharingV1.js';

/** Existing structural /v1/artifacts transport page, shared by dependent page reads. */
export const ARTIFACT_LIST_PAGE_MAX_ITEMS_V1 = 500;

export type ArtifactListSelectionOptionsV1 = Readonly<{
  limit?: number; cursor?: string; search?: string; kind?: string;
  kinds?: readonly string[];
  approvalStates?: readonly ApprovalArtifactStateV1[];
  approvalSessionIds?: readonly string[];
  /** Canonical kind-policy complement, including unknown and untyped ordinary documents. */
  browserListed?: true;
  /** Server-visible exact index hints; private-header matching remains owned by `kinds`/`headerFilter`. */
  indexedKinds?: readonly string[];
  coarseKind?: ArtifactCoarseKindV1;
  ownerAccountId?: string;
  /** Keyholding host selection over admitted private headers; never a wire filter. */
  headerFilter?: (header: Readonly<Record<string, unknown>>) => boolean;
  /** Async host authority checked before paging/body demand and on fresh headers; never sent over transport. */
  headerAdmission?: (header: Readonly<Record<string, unknown>>) => Promise<boolean>;
  sort?: 'updated_desc' | 'created_desc' | 'title_asc'; includeBody?: boolean; signal?: AbortSignal;
}>;

export type ArtifactListPageOptionsV1 = Readonly<Pick<ArtifactListSelectionOptionsV1,
  'limit' | 'cursor' | 'includeBody' | 'coarseKind' | 'kinds' | 'approvalStates' | 'approvalSessionIds' | 'browserListed' | 'indexedKinds' | 'ownerAccountId' | 'signal'> & { unclassified?: boolean | 'coarse' | 'approval' }>;

type ArtifactListHeader = Readonly<{
  artifactId: string; header: Readonly<Record<string, unknown>>; createdAt: number; updatedAt: number;
}>;
type ArtifactListPage<T> = Readonly<{ items: readonly T[]; nextCursor?: string; coverage?: 'complete' | 'partial';
  kindCoverage?: ArtifactKindCoverageV1; hasUnclassified?: boolean }>;

/** Exact membership requires the current typed witness; a Boolean cannot certify absence. */
export function requireArtifactKindCoverageV1(coverage: ArtifactKindCoverageV1 | undefined): ArtifactKindCoverageV1 {
  if (coverage === undefined) throw Object.assign(new Error('Artifact header membership is unavailable'),
    { code: 'artifact_content_unavailable', retryable: false });
  return coverage;
}

function artifactHeaderSelection(options: ArtifactListSelectionOptionsV1 = {}) {
  if (options.browserListed && (options.kind !== undefined || options.kinds !== undefined
    || options.indexedKinds !== undefined || options.coarseKind !== undefined)) {
    throw new TypeError('Browser selection cannot be combined with other kind selectors');
  }
  const requestedKinds = options.kinds ?? (options.kind ? [options.kind] : undefined);
  const kinds = requestedKinds === undefined ? undefined
    : [...new Set(requestedKinds.filter(kind => !options.kind || kind === options.kind))].sort();
  const kindSet = kinds === undefined ? undefined : new Set(kinds);
  const search = options.search?.trim().toLocaleLowerCase();
  const title = (item: ArtifactListHeader) => typeof item.header.title === 'string' ? item.header.title : '';
  const updatedOrder = options.sort === undefined || options.sort === 'updated_desc';
  const approvalSelection = options.approvalStates !== undefined || options.approvalSessionIds !== undefined;
  const sessionIds = options.approvalSessionIds === undefined ? undefined : new Set(options.approvalSessionIds);
  const indexedKinds = approvalSelection && options.indexedKinds !== undefined ? new Set(options.indexedKinds) : undefined;
  const matchesApproval = (header: ArtifactListHeader['header'], includeUnknownState: boolean) => {
    if (!approvalSelection) return true;
    const hints = deriveApprovalArtifactQueryHintsV1(header);
    return (sessionIds === undefined || (hints.approvalSessionId !== null && sessionIds.has(hints.approvalSessionId)))
      && (options.approvalStates === undefined || !isApprovalArtifactKindV1(header.kind)
        || (hints.approvalState === null ? includeUnknownState : options.approvalStates.includes(hints.approvalState)));
  };
  const matchesSelection = (item: ArtifactListHeader, includeUnknownState: boolean) => (!options.kind || item.header.kind === options.kind)
    && (!kindSet || (typeof item.header.kind === 'string' && kindSet.has(item.header.kind))
      || kindSet.has(deriveArtifactKindV1(item.header).kindHint ?? ''))
    && (!indexedKinds || (typeof item.header.kind === 'string' && indexedKinds.has(item.header.kind))
      || indexedKinds.has(deriveArtifactKindV1(item.header).kindHint ?? ''))
    && matchesApproval(item.header, includeUnknownState)
    && (!options.browserListed || getArtifactKindPolicyV1(item.header.kind).browserListed)
    && (!options.headerFilter || options.headerFilter(item.header))
    && (!options.coarseKind || deriveArtifactCoarseKindV1(item.header) === options.coarseKind)
    && (!search || title(item).toLocaleLowerCase().includes(search));
  const matches = (item: ArtifactListHeader) => matchesSelection(item, false);
  const unknownApprovalStateMatches = (item: ArtifactListHeader) => approvalSelection
    && isApprovalArtifactKindV1(item.header.kind) && deriveApprovalArtifactQueryHintsV1(item.header).approvalState === null
    && matchesSelection(item, true);
  const compare = (left: ArtifactListHeader, right: ArtifactListHeader) => {
    const primary = options.sort === 'title_asc' ? title(left).localeCompare(title(right))
      : options.sort === 'created_desc' ? right.createdAt - left.createdAt : right.updatedAt - left.updatedAt;
    return primary || (updatedOrder ? right.artifactId.localeCompare(left.artifactId) : left.artifactId.localeCompare(right.artifactId));
  };
  return { kinds, updatedOrder, matches, compare, approvalSelection, unknownApprovalStateMatches };
}

type ArtifactHeaderPageInput<T> = Readonly<{
  items: readonly T[]; options?: Omit<ArtifactListSelectionOptionsV1, 'headerAdmission'>; encodeCursor: (item: T) => string;
  hasMorePhysicalRows?: boolean;
}>;

function pageSelectedArtifactHeaders<T>(params: ArtifactHeaderPageInput<T>): Readonly<{ items: readonly T[]; nextCursor?: string }> {
  const all = params.items;
  const index = params.options?.cursor ? all.findIndex(item => params.encodeCursor(item) === params.options?.cursor) : -1;
  if (params.options?.cursor && index < 0) throw Object.assign(new Error('artifact_list_cursor_invalid'), { code: 'invalid_cursor' });
  const items = params.options?.limit === undefined ? all.slice(index + 1) : all.slice(index + 1, index + 1 + params.options.limit);
  const last = items.at(-1);
  return { items, ...(last && (params.hasMorePhysicalRows || index + 1 + items.length < all.length)
    ? { nextCursor: params.encodeCursor(last) } : {}) };
}

/** Pure paging of an already-admitted projection; never acquires or certifies inventory membership. */
export function selectArtifactHeaderPageV1<T extends ArtifactListHeader>(params: ArtifactHeaderPageInput<T>): Readonly<{ items: readonly T[]; nextCursor?: string }> {
  throwIfAborted(params.options?.signal);
  const { matches, compare } = artifactHeaderSelection(params.options);
  return pageSelectedArtifactHeaders({ ...params, items: params.items.filter(matches).sort(compare) });
}

/** Decrypted selection shared by keyholding hosts; transport pages retain their own codecs and custody. */
export async function listArtifactHeadersV1<T extends ArtifactListHeader>(params: Readonly<{
  options?: ArtifactListSelectionOptionsV1;
  /** Apply indexed selectors before paging; report readable legacy membership. */
  readPage: (options?: ArtifactListPageOptionsV1) => Promise<ArtifactListPage<T>>;
  readBodies?: (items: readonly T[]) => Promise<readonly T[]>;
  encodeCursor: (item: T) => string;
}>): Promise<Readonly<{ items: readonly T[]; nextCursor?: string; coverage: 'complete' | 'partial'; kindCoverage?: ArtifactKindCoverageV1 }>> {
  const options = params.options;
  throwIfAborted(options?.signal);
  if (options?.headerAdmission && options.includeBody && !params.readBodies) {
    throw new TypeError('Header admission requires separate body reads');
  }
  const { kinds, updatedOrder, matches, compare, approvalSelection, unknownApprovalStateMatches } = artifactHeaderSelection(options);
  const coarseSelection = options?.coarseKind !== undefined && kinds === undefined
    && options.indexedKinds === undefined && !approvalSelection;
  if (kinds?.length === 0 || options?.approvalSessionIds?.length === 0) return { items: [], coverage: 'complete' };
  // The incumbent /v1/artifacts route admits at most 500 structural rows per request.
  if (!options || (options.limit !== undefined && options.limit <= ARTIFACT_LIST_PAGE_MAX_ITEMS_V1
    && options.search === undefined && options.kind === undefined && kinds === undefined && options.indexedKinds === undefined
    && options.browserListed === undefined && options.coarseKind === undefined && !options.headerFilter && !options.headerAdmission && !approvalSelection
    && (options.sort === undefined || options.sort === 'updated_desc'))) {
    const page = await params.readPage(options);
    throwIfAborted(options?.signal);
    return { ...page, coverage: page.coverage ?? 'complete' };
  }
  const admittedHeaders = async (items: readonly T[]): Promise<T[]> => {
    const selected = items.filter(matches);
    if (!options.headerAdmission) return selected;
    const admitted: T[] = [];
    for (const item of selected) {
      throwIfAborted(options.signal);
      if (await options.headerAdmission(item.header)) admitted.push(item);
    }
    throwIfAborted(options.signal);
    return admitted;
  };
  const all: T[] = [];
  let coverage: 'complete' | 'partial' = 'complete';
  let kindCoverage: ArtifactKindCoverageV1 | undefined;
  let hasUnclassifiedCoarseRows = false;
  // The transport keyset is updatedAt-desc / id-desc. Only other orderings
  // need a complete header view before applying their logical cursor.
  let cursor = updatedOrder ? options.cursor : undefined;
  let hasMorePhysicalRows = false;
  do {
    const page = await params.readPage({ limit: ARTIFACT_LIST_PAGE_MAX_ITEMS_V1, ...(cursor ? { cursor } : {}),
      ...(options.browserListed ? { browserListed: true as const } : options.indexedKinds !== undefined ? { indexedKinds: options.indexedKinds }
        : kinds !== undefined ? { kinds } : options.coarseKind ? { coarseKind: options.coarseKind } : {}),
      ...(options.ownerAccountId !== undefined ? { ownerAccountId: options.ownerAccountId } : {}),
      ...(options.approvalStates !== undefined ? { approvalStates: options.approvalStates } : {}),
      ...(options.approvalSessionIds !== undefined ? { approvalSessionIds: options.approvalSessionIds } : {}),
      ...(options.includeBody && !params.readBodies ? { includeBody: true } : {}), ...(options.signal ? { signal: options.signal } : {}) });
    throwIfAborted(options.signal);
    if (kinds !== undefined || options.indexedKinds !== undefined || options.browserListed || approvalSelection) requireArtifactKindCoverageV1(page.kindCoverage);
    // Indexed classification lag is resolved by the legacy header pass below;
    // classification lag is not itself unreadable content.
    if (coarseSelection && (page.hasUnclassified === true || page.kindCoverage?.status === 'partial')) hasUnclassifiedCoarseRows = true;
    if (page.hasUnclassified === true && !options.browserListed && !coarseSelection
      && ((kinds === undefined && !approvalSelection) || !page.kindCoverage)) coverage = 'partial';
    if (page.coverage === 'partial') coverage = 'partial';
    if (page.items.some(unknownApprovalStateMatches)) coverage = 'partial';
    if (page.kindCoverage) {
      kindCoverage = page.kindCoverage;
      if (kindCoverage.status === 'partial' && kinds === undefined && !options.browserListed && !approvalSelection && !coarseSelection) coverage = 'partial';
    }
    all.push(...await admittedHeaders(page.items));
    cursor = page.nextCursor;
    hasMorePhysicalRows = cursor !== undefined;
    if (updatedOrder && options.limit !== undefined && all.length >= options.limit) break;
    if (!cursor) break;
  } while (true);
  // Legacy membership is resolved only under the server's current typed witness.
  // This same header reader never repairs hints or opens unrelated bodies.
  if ((kinds !== undefined || approvalSelection || coarseSelection) && (options.indexedKinds === undefined || approvalSelection)
    && (kindCoverage?.status === 'partial' || hasUnclassifiedCoarseRows)) {
    let legacyCursor = updatedOrder ? options.cursor : undefined;
    const selectedIds = new Set(all.map(item => item.artifactId));
    do {
      const page = await params.readPage({ limit: ARTIFACT_LIST_PAGE_MAX_ITEMS_V1,
        unclassified: approvalSelection ? 'approval' : coarseSelection ? 'coarse' : true,
        ...(legacyCursor ? { cursor: legacyCursor } : {}),
        ...(options.ownerAccountId !== undefined ? { ownerAccountId: options.ownerAccountId } : {}),
        ...(options.signal ? { signal: options.signal } : {}) });
      throwIfAborted(options.signal);
      // Coarse list responses carry a Boolean; the existing unclassified route
      // supplies the typed witness before readable headers certify membership.
      if (coarseSelection) kindCoverage = requireArtifactKindCoverageV1(page.kindCoverage);
      if (page.coverage === 'partial') coverage = 'partial';
      if (page.items.some(unknownApprovalStateMatches)) coverage = 'partial';
      for (const item of await admittedHeaders(page.items.filter(item => !selectedIds.has(item.artifactId)))) {
        all.push(item);
        selectedIds.add(item.artifactId);
      }
      legacyCursor = page.nextCursor;
    } while (legacyCursor);
  }
  all.sort(compare);
  const page = pageSelectedArtifactHeaders({ items: all, options: updatedOrder ? { ...options, cursor: undefined } : options,
    encodeCursor: params.encodeCursor, hasMorePhysicalRows });
  const pageItems = page.items;
  // Only this page needs content. Recheck fresh returned headers rather than
  // attaching a new body to the earlier header/revision or disclosing a kind
  // that changed during the read. Continuation uses the structural frontier.
  const selected = options.includeBody && params.readBodies && pageItems.length > 0 ? await params.readBodies(pageItems) : pageItems;
  throwIfAborted(options.signal);
  if (selected.some(unknownApprovalStateMatches)) coverage = 'partial';
  const items = (await admittedHeaders(selected)).sort(compare);
  return { items, coverage, ...(kindCoverage ? { kindCoverage } : {}), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
}
