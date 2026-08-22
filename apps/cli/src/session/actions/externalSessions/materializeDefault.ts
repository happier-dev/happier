import { createHash } from 'node:crypto';

import {
  EXTERNAL_SESSION_REQUIRED_ITEM_DIAGNOSTIC_CAP_V1,
  readLinkedExternalSessionV1FromMetadata,
  type ExternalSessionOperationRecordV1,
  type ExternalSessionOperationSocketCommandV1,
  type ExternalSessionOperationSocketResponseV1,
  type ExternalSessionRequiredItemDiagnosticV1,
  type ExternalSessionRequiredItemFailuresV1,
  type ExternalSessionTranscriptRawMessageV1,
} from '@happier-dev/protocol';

import {
  ExternalSessionHistoricalImportRequiredItemError,
  prepareExternalSessionHistoricalImportItem,
  readExternalSessionHistoricalImportStagedItem,
  stageExternalSessionHistoricalImportItem,
  validateExternalSessionHistoricalImportStagedItem,
} from '@/api/session/external/import/importExternalSessionTranscript';
import {
  loadLinkedExternalSession,
  type LoadedLinkedExternalSession,
} from '@/api/session/external/takeover/loadLinkedExternalSession';
import { readStoredCredentials } from '@/persistence';
import type { ExternalSessionOperationExclusion } from '@/session/external/operationExclusion';
import type {
  ExternalSessionTranscriptReadAfter,
  ExternalSessionTranscriptPage,
} from '@/session/external/providerOps';
import {
  createExternalSessionOperationPrivateStagingStore,
} from '@/session/external/staging/operationPrivateStaging';
import { garbageCollectUncommittedSessionMedia } from '@/session/media/garbageCollect';
import { resolveSessionStoredContentEncryptionMode } from '@/session/transport/encryption/sessionEncryptionContext';

import {
  createExternalSessionMaterializeActionExecutor,
  ExternalSessionMaterializeSourceInterruptionError,
  type ExternalSessionMaterializeActionExecutor,
} from './materializeAction';
import {
  assertExternalSessionOperationProgressCanBeSelected,
  convergeExternalSessionOperationProgressProjection,
  publishExternalSessionOperationProgress,
  settlePriorTerminalExternalSessionOperationProgressProjections,
} from './operationProgressPublisher';
import { readExternalSessionOperationRecord } from './operationRecordStore';
import { resolveGenerationBoundExternalSessionFollowSurface } from './providerOpsResolution';
import { preservesExternalSessionSourceIdentity } from '@/session/external/sourceIdentity';

const MAX_CAPTURE_PAGES = 10_000;
const CAPTURE_MAX_ITEMS = 200;
const CAPTURE_MAX_BYTES = 512 * 1024;

type MaterializeRequest =
  | Extract<ExternalSessionOperationRecordV1['request'], { plan: 'materialize' }>
  | (
    Extract<ExternalSessionOperationRecordV1['request'], { plan: 'takeover' }>
    & Readonly<{ targetStorageMode: 'persisted' }>
  );
type MaterializeCredentials =
  NonNullable<Awaited<ReturnType<typeof readStoredCredentials>>>;

function resolveHistoricalImportWorkingDirectory(input: Readonly<{
  request: MaterializeRequest;
  linked: LoadedLinkedExternalSession;
  persistedTakeoverWorkingDirectory?: string;
}>): string | null {
  return input.request.plan === 'takeover'
    ? input.persistedTakeoverWorkingDirectory ?? null
    : input.linked.sessionPath;
}

function sourceIdentity(linked: LoadedLinkedExternalSession): string {
  return JSON.stringify({
    agentId: linked.agentId,
    remoteSessionId: linked.remoteSessionId,
    source: linked.source,
  });
}

async function resolveMaterializeSourceReadRoots(input: Readonly<{
  linked: LoadedLinkedExternalSession;
  providerOps: Awaited<
    ReturnType<typeof resolveGenerationBoundExternalSessionFollowSurface>
  >['providerOps'];
}>): Promise<readonly string[]> {
  if (!input.providerOps.validateSource) return [];
  const validated = await input.providerOps.validateSource({
    source: input.linked.source,
    env: process.env,
  });
  if (!validated.ok) {
    throw new ExternalSessionMaterializeSourceInterruptionError(
      'source_unavailable',
      'External session source cannot provide current transcript-media evidence.',
    );
  }
  if (
    !preservesExternalSessionSourceIdentity(input.linked.source, validated.source)
    || !preservesExternalSessionSourceIdentity(validated.source, input.linked.source)
  ) {
    throw new ExternalSessionMaterializeSourceInterruptionError(
      'source_changed',
      'External session source changed while resolving transcript-media evidence.',
    );
  }
  return validated.transcriptMediaReadRoots ?? [];
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}

function credentialsMatch(
  left: MaterializeCredentials,
  right: MaterializeCredentials,
): boolean {
  if (left.token !== right.token) return false;
  if (left.encryption === null || right.encryption === null) {
    return left.encryption === right.encryption;
  }
  if (left.encryption.type !== right.encryption.type) return false;
  if (left.encryption.type === 'legacy' && right.encryption.type === 'legacy') {
    return bytesEqual(left.encryption.secret, right.encryption.secret);
  }
  if (left.encryption.type === 'dataKey' && right.encryption.type === 'dataKey') {
    return bytesEqual(left.encryption.publicKey, right.encryption.publicKey)
      && bytesEqual(left.encryption.machineKey, right.encryption.machineKey);
  }
  return false;
}

function preparationAuthorityMatches(
  snapshot: Readonly<{
    credentials: MaterializeCredentials;
    linked: LoadedLinkedExternalSession;
  }>,
  current: Readonly<{
    credentials: MaterializeCredentials;
    linked: LoadedLinkedExternalSession;
  }>,
): boolean {
  const snapshotDataEncryptionKey =
    typeof snapshot.linked.rawSession.dataEncryptionKey === 'string'
      ? snapshot.linked.rawSession.dataEncryptionKey.trim() || null
      : null;
  const currentDataEncryptionKey =
    typeof current.linked.rawSession.dataEncryptionKey === 'string'
      ? current.linked.rawSession.dataEncryptionKey.trim() || null
      : null;
  return credentialsMatch(snapshot.credentials, current.credentials)
    && sourceIdentity(snapshot.linked) === sourceIdentity(current.linked)
    && snapshot.linked.sessionPath === current.linked.sessionPath
    && resolveSessionStoredContentEncryptionMode(snapshot.linked.rawSession)
      === resolveSessionStoredContentEncryptionMode(current.linked.rawSession)
    && snapshotDataEncryptionKey === currentDataEncryptionKey;
}

async function loadCurrentLinked(request: MaterializeRequest): Promise<Readonly<{
  credentials: MaterializeCredentials;
  linked: LoadedLinkedExternalSession;
}>> {
  const credentials = await readStoredCredentials();
  if (!credentials) {
    throw new ExternalSessionMaterializeSourceInterruptionError(
      'source_unavailable',
      'External session credentials are unavailable.',
    );
  }
  const loaded = await loadLinkedExternalSession({
    credentials,
    sessionId: request.sessionId,
    machineId: request.source.machineId,
  }).catch(() => null);
  if (!loaded?.ok) {
    throw new ExternalSessionMaterializeSourceInterruptionError(
      'source_unavailable',
      'External session source is unavailable.',
    );
  }
  const persisted = readLinkedExternalSessionV1FromMetadata(loaded.session.metadata);
  if (
    !persisted
    || loaded.session.remoteSessionId !== request.source.remoteSessionId
    || loaded.session.linkGeneration !== request.source.linkGeneration
    || JSON.stringify(persisted.qualifiedIdentity) !== JSON.stringify(request.source.qualifiedIdentity)
  ) {
    throw new ExternalSessionMaterializeSourceInterruptionError(
      'source_changed',
      'External session source identity changed during materialization.',
    );
  }
  return { credentials, linked: loaded.session };
}

async function readTranscriptPage(
  read: () => Promise<ExternalSessionTranscriptPage>,
): Promise<ExternalSessionTranscriptPage> {
  try {
    return await read();
  } catch {
    throw new ExternalSessionMaterializeSourceInterruptionError(
      'source_unavailable',
      'External session transcript source could not be read.',
    );
  }
}

function groupId(pageIndex: number, cursor: string | undefined): string {
  const cursorKey = createHash('sha256')
    .update(cursor ?? 'initial', 'utf8')
    .digest('hex')
    .slice(0, 16);
  return `historical-page:${pageIndex}:${cursorKey}`;
}

function captureKey(request: MaterializeRequest): string {
  return JSON.stringify({
    sessionId: request.sessionId,
    idempotencyKey: request.idempotencyKey,
  });
}

function revisionForTail(identity: string, tailCursor: string | null): string {
  return tailCursor ?? `empty:${createHash('sha256').update(identity, 'utf8').digest('hex')}`;
}

function requireContinuousReadAfter(
  result: ExternalSessionTranscriptReadAfter,
  currentCursor: string,
): Readonly<{
  items: readonly ExternalSessionTranscriptRawMessageV1[];
  nextCursor: string;
  diagnostics: readonly Readonly<{
    code: string;
    count: number;
    positions: readonly number[];
  }>[];
}> {
  switch (result.outcome) {
    case 'advanced':
      return {
        items: result.items,
        nextCursor: result.nextCursor,
        diagnostics: result.diagnostics ?? [],
      };
    case 'already_current':
      return {
        items: [],
        nextCursor: currentCursor,
        diagnostics: [],
      };
    case 'gap_or_cursor_expired':
    case 'source_replaced':
      throw new ExternalSessionMaterializeSourceInterruptionError(
        'source_changed',
        'External session transcript continuity was replaced during materialization.',
      );
    case 'source_unavailable':
    case 'read_failed':
      throw new ExternalSessionMaterializeSourceInterruptionError(
        'source_unavailable',
        'External session transcript source could not be read during materialization.',
      );
  }
}

function requiredItemFailuresFromReadAfterDiagnostics(input: Readonly<{
  diagnostics: readonly Readonly<{
    code: string;
    count: number;
    positions: readonly number[];
  }>[];
  sourceGeneration: string;
  sourcePageIndex: number;
}>): ExternalSessionRequiredItemFailuresV1 {
  let total = 0;
  let diagnosticsTruncated = false;
  const diagnostics: ExternalSessionRequiredItemDiagnosticV1[] = [];
  for (const diagnostic of input.diagnostics) {
    if (diagnostic.code === 'non_transcript_record_skipped') continue;
    total += diagnostic.count;
    diagnosticsTruncated ||= diagnostic.positions.length < diagnostic.count;
    for (const position of diagnostic.positions) {
      if (diagnostics.length < EXTERNAL_SESSION_REQUIRED_ITEM_DIAGNOSTIC_CAP_V1) {
        diagnostics.push({
          category: 'record',
          sourceGeneration: input.sourceGeneration,
          sourcePageIndex: input.sourcePageIndex,
          sourceItemIndex: position,
        });
      } else {
        diagnosticsTruncated = true;
      }
    }
  }
  return {
    total,
    record: total,
    media: 0,
    conversion: 0,
    diagnosticsTruncated,
    diagnostics,
  };
}

function mergeRequiredItemFailures(
  first: ExternalSessionRequiredItemFailuresV1,
  second: ExternalSessionRequiredItemFailuresV1,
): ExternalSessionRequiredItemFailuresV1 {
  const diagnostics = [
    ...(first.diagnostics ?? []),
    ...(second.diagnostics ?? []),
  ];
  return {
    total: first.total + second.total,
    record: first.record + second.record,
    media: first.media + second.media,
    conversion: first.conversion + second.conversion,
    diagnosticsTruncated:
      first.diagnosticsTruncated
      || second.diagnosticsTruncated
      || diagnostics.length > EXTERNAL_SESSION_REQUIRED_ITEM_DIAGNOSTIC_CAP_V1,
    diagnostics: diagnostics.slice(0, EXTERNAL_SESSION_REQUIRED_ITEM_DIAGNOSTIC_CAP_V1),
  };
}

type MaterializeCaptureStart = Readonly<{
  linked: LoadedLinkedExternalSession;
  resolved: Awaited<ReturnType<typeof resolveGenerationBoundExternalSessionFollowSurface>>;
  sourceReadRoots: readonly string[];
  firstPage: ExternalSessionTranscriptPage;
  sourceIdentity: string;
  capturedTailCursor: string | null;
}>;

async function stageRequiredHistoricalItems(input: Readonly<{
  transcriptItems: readonly ExternalSessionTranscriptRawMessageV1[];
  workingDirectory: string | null;
  sourceReadRoots: readonly string[];
  sourceGeneration: string;
  sourcePageIndex: number;
}>): Promise<Readonly<{
  items: readonly unknown[];
  requiredItemFailures: ExternalSessionRequiredItemFailuresV1;
}>> {
  const items: unknown[] = [];
  const requiredItemFailures = {
    total: 0,
    record: 0,
    media: 0,
    conversion: 0,
    diagnosticsTruncated: false,
    diagnostics: [] as ExternalSessionRequiredItemDiagnosticV1[],
  };
  for (const [sourceItemIndex, transcriptItem] of input.transcriptItems.entries()) {
    try {
      items.push(await stageExternalSessionHistoricalImportItem({
        item: transcriptItem,
        workingDirectory: input.workingDirectory,
        sourceReadRoots: input.sourceReadRoots,
      }));
    } catch (error) {
      if (!(error instanceof ExternalSessionHistoricalImportRequiredItemError)) throw error;
      requiredItemFailures.total += 1;
      requiredItemFailures[error.category] += 1;
      if (
        requiredItemFailures.diagnostics
        && requiredItemFailures.diagnostics.length
          < EXTERNAL_SESSION_REQUIRED_ITEM_DIAGNOSTIC_CAP_V1
      ) {
        requiredItemFailures.diagnostics.push({
          category: error.category,
          sourceGeneration: input.sourceGeneration,
          sourcePageIndex: input.sourcePageIndex,
          sourceItemIndex,
        });
      } else {
        requiredItemFailures.diagnosticsTruncated = true;
      }
    }
  }
  return {
    items,
    requiredItemFailures,
  };
}

export function createDefaultExternalSessionMaterializeActionExecutor(input: Readonly<{
  activeServerDir: string;
  operationExclusion: ExternalSessionOperationExclusion;
  sendHistoricalCommand(
    command: ExternalSessionOperationSocketCommandV1,
  ): Promise<ExternalSessionOperationSocketResponseV1>;
  publishProgress?: NonNullable<
    Parameters<typeof createExternalSessionMaterializeActionExecutor>[0]['publishProgress']
  >;
  validateProgressSelection?: NonNullable<
    Parameters<typeof createExternalSessionMaterializeActionExecutor>[0]['validateProgressSelection']
  >;
  preparePersistedTakeover?: NonNullable<
    Parameters<
      typeof createExternalSessionMaterializeActionExecutor
    >[0]['preparePersistedTakeover']
  >;
}>): ExternalSessionMaterializeActionExecutor {
  const staging = createExternalSessionOperationPrivateStagingStore({
    activeServerDir: input.activeServerDir,
    limits: {
      perOperation: {
        maxItems: 100_000,
        maxBytes: 512 * 1024 * 1024,
      },
      aggregate: {
        maxItems: 500_000,
        maxBytes: 2 * 1024 * 1024 * 1024,
      },
    },
  });
  const captureStarts = new Map<string, MaterializeCaptureStart>();

  return createExternalSessionMaterializeActionExecutor({
    activeServerDir: input.activeServerDir,
    operationExclusion: input.operationExclusion,
    staging,
    createStagedItemPreparationPhase: async (
      request,
      mode,
      persistedTakeoverWorkingDirectory,
      operationId,
    ) => {
      const phaseSnapshot = await loadCurrentLinked(request);
      return Object.freeze({
        prepareStagedItem: async (value: unknown) => {
          const staged = readExternalSessionHistoricalImportStagedItem(value);
          if (!staged) return { ok: false as const, category: 'record' as const };
          const createdWorkspaceMediaPaths: string[] = [];
          const persistedWorkspaceMediaPaths: string[] = [];
          let ownershipRecorded = false;
          const workingDirectory = request.plan === 'takeover'
            ? persistedTakeoverWorkingDirectory ?? null
            : staged.mediaWorkingDirectory ?? phaseSnapshot.linked.sessionPath;
          try {
            if (mode === 'validate') {
              return {
                ok: true as const,
                item: await validateExternalSessionHistoricalImportStagedItem({
                  staged,
                  linked: phaseSnapshot.linked,
                  credentials: phaseSnapshot.credentials,
                  sessionId: request.sessionId,
                }),
              };
            }
            const item = await prepareExternalSessionHistoricalImportItem({
              item: staged.item,
              linked: phaseSnapshot.linked,
              credentials: phaseSnapshot.credentials,
              sessionId: request.sessionId,
              workingDirectory,
              sourceReadRoots: [],
              createdWorkspaceMediaPaths,
              persistedWorkspaceMediaPaths,
            });
            const ownedWorkspaceMedia = workingDirectory
              ? createdWorkspaceMediaPaths.map((candidateWorkspaceRelativePath) => ({
                workingDirectory,
                candidateWorkspaceRelativePath,
              }))
              : [];
            const workspaceMedia = workingDirectory
              ? [...new Set(persistedWorkspaceMediaPaths)].map(
                (candidateWorkspaceRelativePath) => ({
                  workingDirectory,
                  candidateWorkspaceRelativePath,
                }),
              )
              : [];
            if (ownedWorkspaceMedia.length > 0) {
              await staging.recordCreatedWorkspaceMedia({
                operationId,
                media: ownedWorkspaceMedia,
              });
              ownershipRecorded = true;
            }
            return {
              ok: true as const,
              item,
              ...(workspaceMedia.length > 0 ? { workspaceMedia } : {}),
              ...(workspaceMedia.length > 0
                ? {
                  cleanup: async () => {
                    const owned = await staging.readCreatedWorkspaceMediaForCleanup({
                      operationId,
                      media: workspaceMedia,
                    });
                    if (owned.length === 0) return;
                    const cleaned = await garbageCollectUncommittedSessionMedia({
                      workingDirectory: owned[0]!.workingDirectory,
                      candidateWorkspaceRelativePaths: owned.map(
                        (entry) => entry.candidateWorkspaceRelativePath,
                      ),
                      reason: 'interrupted_ingestion',
                    });
                    if (cleaned === null) {
                      throw new Error('historical_import_staged_media_cleanup_failed');
                    }
                    await staging.acknowledgeCreatedWorkspaceMediaCleanup({
                      operationId,
                      media: owned,
                    });
                  },
                }
                : {}),
            };
          } catch (error) {
            if (
              !ownershipRecorded
              && workingDirectory
              && createdWorkspaceMediaPaths.length > 0
            ) {
              const cleaned = await garbageCollectUncommittedSessionMedia({
                workingDirectory,
                candidateWorkspaceRelativePaths: createdWorkspaceMediaPaths,
                reason: 'interrupted_ingestion',
              });
              if (cleaned === null) {
                throw new Error('historical_import_staged_media_cleanup_failed');
              }
            }
            if (error instanceof ExternalSessionHistoricalImportRequiredItemError) {
              return { ok: false as const, category: error.category };
            }
            throw error;
          }
        },
        ...(mode === 'publish'
          ? {
            revalidateBeforeBatchEffect: async () => {
              const current = await loadCurrentLinked(request);
              if (!preparationAuthorityMatches(phaseSnapshot, current)) {
                throw new ExternalSessionMaterializeSourceInterruptionError(
                  'source_changed',
                  'External session link or encryption authority changed before historical publication.',
                );
              }
            },
          }
          : {}),
      });
    },
    publishProgress: input.publishProgress ?? ((publishInput) =>
      publishExternalSessionOperationProgress({
        ...publishInput,
        activeServerDir: input.activeServerDir,
      })),
    convergeProgress: async (record) => {
      await convergeExternalSessionOperationProgressProjection(
        input.activeServerDir,
        record,
        {
          allowSettledTerminalPredecessorReplacement: true,
        },
      );
      const converged = await readExternalSessionOperationRecord(
        input.activeServerDir,
        record.operationId,
      );
      if (!converged) {
        throw new Error(
          'external_session_operation_progress_convergence_record_missing',
        );
      }
      return converged;
    },
    validateProgressSelection: input.validateProgressSelection
      ?? (input.publishProgress
        ? async () => undefined
        : assertExternalSessionOperationProgressCanBeSelected),
    settlePriorTerminalProgressProjection: async (priorTerminalRecords) => {
      await settlePriorTerminalExternalSessionOperationProgressProjections(
        input.activeServerDir,
        priorTerminalRecords,
        {
          sessionAdmissionLockHeld: true,
          publish: async (publishInput) =>
            await publishExternalSessionOperationProgress({
              ...publishInput,
              sessionAdmissionLockHeld: true,
            }),
        },
      );
    },
    ...(input.preparePersistedTakeover
      ? { preparePersistedTakeover: input.preparePersistedTakeover }
      : {}),
    describeSource: async (request) => {
      const { linked } = await loadCurrentLinked(request);
      const resolved = await resolveGenerationBoundExternalSessionFollowSurface(
        linked.agentId,
        request.source.linkGeneration,
      );
      if (resolved.resource.pluginGeneration !== request.source.contributionGeneration) {
        throw new Error('external_session_contribution_generation_replaced');
      }
      if (!resolved.providerOps.pageTranscript) {
        throw new Error('external_session_transcript_page_unavailable');
      }
      const sourceReadRoots = await resolveMaterializeSourceReadRoots({
        linked,
        providerOps: resolved.providerOps,
      });
      const firstPage = await readTranscriptPage(() => resolved.providerOps.pageTranscript!({
        source: linked.source,
        remoteSessionId: linked.remoteSessionId,
        direction: 'older',
        maxBytes: CAPTURE_MAX_BYTES,
        maxItems: CAPTURE_MAX_ITEMS,
      }));
      if (firstPage.truncated) {
        throw new Error('external_session_transcript_capture_truncated');
      }
      const identity = sourceIdentity(linked);
      captureStarts.set(captureKey(request), {
        linked,
        resolved,
        sourceReadRoots,
        firstPage,
        sourceIdentity: identity,
        capturedTailCursor: firstPage.tailCursor,
      });
      const session = linked.rawSession as Readonly<Record<string, unknown>>;
      return {
        capturedSource: {
          sourceIdentity: identity,
          sourceGeneration: request.source.sourceGeneration,
          revision: revisionForTail(identity, firstPage.tailCursor),
          boundary: firstPage.tailCursor ?? 'empty',
        },
        linkedSessionRevision: Number.isSafeInteger(session.metadataVersion)
          ? Number(session.metadataVersion)
          : 0,
      };
    },
    releaseSourceCapture: (request) => {
      captureStarts.delete(captureKey(request));
    },
    revalidateSource: async (request, capturedSource, sourceSnapshotEvidenceRef) => {
      const current = await loadCurrentLinked(request);
      const identity = sourceIdentity(current.linked);
      if (
        identity !== capturedSource.sourceIdentity
        || capturedSource.sourceGeneration !== request.source.sourceGeneration
      ) {
        throw new ExternalSessionMaterializeSourceInterruptionError(
          'source_changed',
          'External session source identity changed before explicit continuation.',
        );
      }
      const resolved = await resolveGenerationBoundExternalSessionFollowSurface(
        current.linked.agentId,
        request.source.linkGeneration,
      );
      if (
        resolved.resource.pluginGeneration !== request.source.contributionGeneration
        || Boolean(resolved.resource.retirementSignal?.aborted)
      ) {
        throw new ExternalSessionMaterializeSourceInterruptionError(
          'source_changed',
          'External session contribution generation changed before explicit continuation.',
        );
      }
      if (!resolved.providerOps.pageTranscript || !resolved.providerOps.readAfterTranscript) {
        throw new ExternalSessionMaterializeSourceInterruptionError(
          'source_unavailable',
          'External session transcript source cannot be revalidated before continuation.',
        );
      }

      if (sourceSnapshotEvidenceRef.startsWith('empty:')) {
        const currentPage = await readTranscriptPage(() => resolved.providerOps.pageTranscript!({
          source: current.linked.source,
          remoteSessionId: current.linked.remoteSessionId,
          direction: 'older',
          maxBytes: CAPTURE_MAX_BYTES,
          maxItems: 1,
        }));
        if (currentPage.truncated) {
          throw new ExternalSessionMaterializeSourceInterruptionError(
            'source_changed',
            'External session transcript continuity cannot be verified before continuation.',
          );
        }
        return;
      }

      let readAfter: ExternalSessionTranscriptReadAfter;
      try {
        readAfter = await resolved.providerOps.readAfterTranscript({
          source: current.linked.source,
          remoteSessionId: current.linked.remoteSessionId,
          cursor: sourceSnapshotEvidenceRef,
          maxBytes: CAPTURE_MAX_BYTES,
          maxItems: 1,
        });
      } catch {
        throw new ExternalSessionMaterializeSourceInterruptionError(
          'source_unavailable',
          'External session transcript source could not be revalidated before continuation.',
        );
      }
      requireContinuousReadAfter(readAfter, sourceSnapshotEvidenceRef);
    },
    readNewestFirstPages: async function* (
      request,
      persistedTakeoverWorkingDirectory,
    ) {
      const key = captureKey(request);
      const capture = captureStarts.get(key);
      if (!capture) throw new Error('external_session_capture_boundary_unavailable');
      const { linked, resolved, sourceReadRoots } = capture;
      const workingDirectory = resolveHistoricalImportWorkingDirectory({
        request,
        linked,
        persistedTakeoverWorkingDirectory,
      });
      if (!resolved.providerOps.pageTranscript || !resolved.providerOps.readAfterTranscript) {
        throw new Error('external_session_transcript_capture_unavailable');
      }
      let cursor: string | undefined;
      const seenCursors = new Set<string>();
      let page = capture.firstPage;
      let pageIndex = 0;
      try {
        for (; pageIndex < MAX_CAPTURE_PAGES; pageIndex += 1) {
          const current = await loadCurrentLinked(request);
          const stillCurrent = sourceIdentity(current.linked) === capture.sourceIdentity
            && !page.truncated
            && page.tailCursor === capture.capturedTailCursor;
          const prepared = await stageRequiredHistoricalItems({
            transcriptItems: page.items,
            workingDirectory,
            sourceReadRoots,
            sourceGeneration: request.source.sourceGeneration,
            sourcePageIndex: pageIndex,
          });
          yield {
            groupId: groupId(pageIndex, cursor),
            items: prepared.items,
            requiredItemFailures: prepared.requiredItemFailures,
            sourceRead: {
              availability: 'reachable' as const,
              sourceIdentity: stillCurrent
                ? capture.sourceIdentity
                : sourceIdentity(current.linked),
              sourceGeneration: request.source.sourceGeneration,
              revision: revisionForTail(capture.sourceIdentity, capture.capturedTailCursor),
              relationshipToCapture: stillCurrent ? 'same' as const : 'rewritten' as const,
              eof: false,
            },
          };
          if (!stillCurrent) return;
          if (!page.hasMore) break;
          if (!page.nextCursor || seenCursors.has(page.nextCursor)) {
            throw new Error('external_session_transcript_cursor_cycle');
          }
          seenCursors.add(page.nextCursor);
          cursor = page.nextCursor;
          page = await readTranscriptPage(() => resolved.providerOps.pageTranscript!({
            source: linked.source,
            remoteSessionId: linked.remoteSessionId,
            direction: 'older',
            cursor,
            maxBytes: CAPTURE_MAX_BYTES,
            maxItems: CAPTURE_MAX_ITEMS,
          }));
        }
        if (pageIndex >= MAX_CAPTURE_PAGES) {
          throw new Error('external_session_transcript_page_limit');
        }

        let catchUpCursor = capture.capturedTailCursor;
        let catchUpIndex = 0;
        if (catchUpCursor !== null) {
          for (; catchUpIndex < MAX_CAPTURE_PAGES; catchUpIndex += 1) {
            const readAfterCursor: string = catchUpCursor;
            const current = await loadCurrentLinked(request);
            if (sourceIdentity(current.linked) !== capture.sourceIdentity) {
              yield {
                groupId: `final-source-replaced:${catchUpIndex}`,
                replayOrder: -1 - catchUpIndex,
                items: [],
                sourceRead: {
                  availability: 'reachable' as const,
                  sourceIdentity: sourceIdentity(current.linked),
                  sourceGeneration: request.source.sourceGeneration,
                  revision: revisionForTail(capture.sourceIdentity, catchUpCursor),
                  relationshipToCapture: 'rewritten' as const,
                  eof: false,
                },
              };
              return;
            }
            let readAfter: ExternalSessionTranscriptReadAfter;
            try {
              readAfter = await resolved.providerOps.readAfterTranscript!({
                source: linked.source,
                remoteSessionId: linked.remoteSessionId,
                cursor: readAfterCursor,
                maxBytes: CAPTURE_MAX_BYTES,
                maxItems: CAPTURE_MAX_ITEMS,
              });
            } catch {
              throw new ExternalSessionMaterializeSourceInterruptionError(
                'source_unavailable',
                'External session transcript source could not be read during catch-up.',
              );
            }
            const appended = requireContinuousReadAfter(readAfter, readAfterCursor);
            const nextCursor: string | null = appended.nextCursor;
            if (!nextCursor || nextCursor === readAfterCursor) {
              if (appended.items.length === 0 && appended.diagnostics.length === 0) break;
              throw new Error('external_session_transcript_catch_up_cursor_stalled');
            }
            const diagnosticFailures = requiredItemFailuresFromReadAfterDiagnostics({
              diagnostics: appended.diagnostics,
              sourceGeneration: request.source.sourceGeneration,
              sourcePageIndex: pageIndex + catchUpIndex + 1,
            });
            if (appended.items.length === 0 && diagnosticFailures.total === 0) {
              catchUpCursor = nextCursor;
              continue;
            }
            const prepared = await stageRequiredHistoricalItems({
              transcriptItems: appended.items,
              workingDirectory,
              sourceReadRoots,
              sourceGeneration: request.source.sourceGeneration,
              sourcePageIndex: pageIndex + catchUpIndex + 1,
            });
            yield {
              groupId: `historical-catch-up:${catchUpIndex}:${createHash('sha256')
                .update(readAfterCursor, 'utf8')
                .digest('hex')
                .slice(0, 16)}`,
              replayOrder: -1 - catchUpIndex,
              items: prepared.items,
              requiredItemFailures: mergeRequiredItemFailures(
                diagnosticFailures,
                prepared.requiredItemFailures,
              ),
              sourceRead: {
                availability: 'reachable' as const,
                sourceIdentity: capture.sourceIdentity,
                sourceGeneration: request.source.sourceGeneration,
                revision: revisionForTail(capture.sourceIdentity, nextCursor),
                relationshipToCapture: 'appended' as const,
                eof: false,
              },
            };
            catchUpCursor = nextCursor;
          }
          if (catchUpIndex >= MAX_CAPTURE_PAGES) {
            throw new Error('external_session_transcript_catch_up_limit');
          }
        }

        const finalCurrent = await loadCurrentLinked(request);
        const finalPage = await readTranscriptPage(() => resolved.providerOps.pageTranscript!({
          source: linked.source,
          remoteSessionId: linked.remoteSessionId,
          direction: 'older',
          maxBytes: CAPTURE_MAX_BYTES,
          maxItems: 1,
        }));
        const finalTail = finalPage.tailCursor;
        const finalMatches = sourceIdentity(finalCurrent.linked) === capture.sourceIdentity
          && finalTail === catchUpCursor;
        yield {
          groupId: `historical-final-validation:${catchUpIndex}`,
          replayOrder: -1 - catchUpIndex,
          items: [],
          sourceRead: {
            availability: 'reachable' as const,
            sourceIdentity: sourceIdentity(finalCurrent.linked),
            sourceGeneration: request.source.sourceGeneration,
            revision: revisionForTail(capture.sourceIdentity, finalTail),
            relationshipToCapture: finalMatches
              ? finalTail === capture.capturedTailCursor ? 'same' as const : 'appended' as const
              : 'rewritten' as const,
            eof: finalMatches,
          },
        };
      } finally {
        captureStarts.delete(key);
      }
    },
    readFinalCatchUpPages: async function* (
      request,
      sourceSnapshotEvidenceRef,
      persistedTakeoverWorkingDirectory,
    ) {
      const current = await loadCurrentLinked(request);
      const workingDirectory = resolveHistoricalImportWorkingDirectory({
        request,
        linked: current.linked,
        persistedTakeoverWorkingDirectory,
      });
      const identity = sourceIdentity(current.linked);
      const resolved = await resolveGenerationBoundExternalSessionFollowSurface(
        current.linked.agentId,
        request.source.linkGeneration,
      );
      if (
        resolved.resource.pluginGeneration !== request.source.contributionGeneration
        || Boolean(resolved.resource.retirementSignal?.aborted)
      ) {
        throw new ExternalSessionMaterializeSourceInterruptionError(
          'source_changed',
          'External session contribution generation changed before finalization.',
        );
      }
      if (!resolved.providerOps.pageTranscript || !resolved.providerOps.readAfterTranscript) {
        throw new ExternalSessionMaterializeSourceInterruptionError(
          'source_unavailable',
          'External session transcript source cannot be revalidated before finalization.',
        );
      }
      const sourceReadRoots = await resolveMaterializeSourceReadRoots({
        linked: current.linked,
        providerOps: resolved.providerOps,
      });

      if (sourceSnapshotEvidenceRef.startsWith('empty:')) {
        let cursor: string | undefined;
        let page = await readTranscriptPage(() => resolved.providerOps.pageTranscript!({
          source: current.linked.source,
          remoteSessionId: current.linked.remoteSessionId,
          direction: 'older',
          maxBytes: CAPTURE_MAX_BYTES,
          maxItems: CAPTURE_MAX_ITEMS,
        }));
        const finalTail = page.tailCursor;
        if (finalTail === null) return;
        const seenCursors = new Set<string>();
        for (let pageIndex = 0; pageIndex < MAX_CAPTURE_PAGES; pageIndex += 1) {
          const stillCurrent = await loadCurrentLinked(request);
          if (
            sourceIdentity(stillCurrent.linked) !== identity
            || Boolean(resolved.resource.retirementSignal?.aborted)
            || page.truncated
            || page.tailCursor !== finalTail
          ) {
            throw new ExternalSessionMaterializeSourceInterruptionError(
              'source_changed',
              'External session source changed during final catch-up.',
            );
          }
          const prepared = await stageRequiredHistoricalItems({
            transcriptItems: page.items,
            workingDirectory,
            sourceReadRoots,
            sourceGeneration: request.source.sourceGeneration,
            sourcePageIndex: pageIndex,
          });
          // The source walks newest-to-oldest here. Reserve an order below the
          // acknowledged empty capture, with later (older) pages ordered first,
          // so the staging owner can stream each page immediately and replay
          // the extension chronologically without a whole-corpus reversal.
          yield {
            groupId: `final-empty-catch-up:${pageIndex}:${createHash('sha256')
              .update(cursor ?? 'initial', 'utf8')
              .digest('hex')
              .slice(0, 16)}`,
            replayOrder: -MAX_CAPTURE_PAGES + pageIndex,
            items: prepared.items,
            requiredItemFailures: prepared.requiredItemFailures,
            sourceRead: {
              availability: 'reachable',
              sourceIdentity: identity,
              sourceGeneration: request.source.sourceGeneration,
              revision: revisionForTail(identity, finalTail),
              relationshipToCapture: 'appended',
              eof: false,
            },
          };
          if (!page.hasMore) break;
          if (!page.nextCursor || seenCursors.has(page.nextCursor)) {
            throw new ExternalSessionMaterializeSourceInterruptionError(
              'source_changed',
              'External session final catch-up cursor became invalid.',
            );
          }
          seenCursors.add(page.nextCursor);
          cursor = page.nextCursor;
          page = await readTranscriptPage(() => resolved.providerOps.pageTranscript!({
            source: current.linked.source,
            remoteSessionId: current.linked.remoteSessionId,
            direction: 'older',
            cursor,
            maxBytes: CAPTURE_MAX_BYTES,
            maxItems: CAPTURE_MAX_ITEMS,
          }));
          if (pageIndex === MAX_CAPTURE_PAGES - 1) {
            throw new ExternalSessionMaterializeSourceInterruptionError(
              'source_unavailable',
              'External session final catch-up exceeded its bounded page limit.',
            );
          }
        }
        const finalCurrent = await loadCurrentLinked(request);
        const finalPage = await readTranscriptPage(() => resolved.providerOps.pageTranscript!({
          source: current.linked.source,
          remoteSessionId: current.linked.remoteSessionId,
          direction: 'older',
          maxBytes: CAPTURE_MAX_BYTES,
          maxItems: 1,
        }));
        if (
          sourceIdentity(finalCurrent.linked) !== identity
          || finalPage.tailCursor !== finalTail
          || finalPage.truncated
        ) {
          throw new ExternalSessionMaterializeSourceInterruptionError(
            'source_changed',
            'External session source changed during final catch-up validation.',
          );
        }
        yield {
          groupId: `final-empty-validation:${createHash('sha256')
            .update(finalTail, 'utf8')
            .digest('hex')
            .slice(0, 16)}`,
          items: [],
          sourceRead: {
            availability: 'reachable',
            sourceIdentity: identity,
            sourceGeneration: request.source.sourceGeneration,
            revision: revisionForTail(identity, finalTail),
            relationshipToCapture: 'appended',
            eof: true,
          },
        };
        return;
      }

      let cursor = sourceSnapshotEvidenceRef;
      let appendedPageCount = 0;
      for (; appendedPageCount < MAX_CAPTURE_PAGES; appendedPageCount += 1) {
        const stillCurrent = await loadCurrentLinked(request);
        if (
          sourceIdentity(stillCurrent.linked) !== identity
          || Boolean(resolved.resource.retirementSignal?.aborted)
        ) {
          throw new ExternalSessionMaterializeSourceInterruptionError(
            'source_changed',
            'External session source changed during final catch-up.',
          );
        }
        let readAfter: ExternalSessionTranscriptReadAfter;
        try {
          readAfter = await resolved.providerOps.readAfterTranscript({
            source: current.linked.source,
            remoteSessionId: current.linked.remoteSessionId,
            cursor,
            maxBytes: CAPTURE_MAX_BYTES,
            maxItems: CAPTURE_MAX_ITEMS,
          });
        } catch {
          throw new ExternalSessionMaterializeSourceInterruptionError(
            'source_unavailable',
            'External session transcript source could not be read during final catch-up.',
          );
        }
        const appended = requireContinuousReadAfter(readAfter, cursor);
        const nextCursor = appended.nextCursor;
        if (!nextCursor || nextCursor === cursor) {
          if (appended.items.length === 0 && appended.diagnostics.length === 0) break;
          throw new ExternalSessionMaterializeSourceInterruptionError(
            'source_changed',
            'External session final catch-up cursor did not advance.',
          );
        }
        const diagnosticFailures = requiredItemFailuresFromReadAfterDiagnostics({
          diagnostics: appended.diagnostics,
          sourceGeneration: request.source.sourceGeneration,
          sourcePageIndex: appendedPageCount,
        });
        if (appended.items.length === 0 && diagnosticFailures.total === 0) {
          cursor = nextCursor;
          continue;
        }
        const prepared = await stageRequiredHistoricalItems({
          transcriptItems: appended.items,
          workingDirectory,
          sourceReadRoots,
          sourceGeneration: request.source.sourceGeneration,
          sourcePageIndex: appendedPageCount,
        });
        yield {
          groupId: `final-catch-up:${createHash('sha256')
            .update(cursor, 'utf8')
            .digest('hex')
            .slice(0, 16)}`,
          items: prepared.items,
          requiredItemFailures: mergeRequiredItemFailures(
            diagnosticFailures,
            prepared.requiredItemFailures,
          ),
          sourceRead: {
            availability: 'reachable',
            sourceIdentity: identity,
            sourceGeneration: request.source.sourceGeneration,
            revision: revisionForTail(identity, nextCursor),
            relationshipToCapture: 'appended',
            eof: false,
          },
        };
        cursor = nextCursor;
      }
      if (appendedPageCount >= MAX_CAPTURE_PAGES) {
        throw new ExternalSessionMaterializeSourceInterruptionError(
          'source_unavailable',
          'External session final catch-up exceeded its bounded page limit.',
        );
      }
      const finalCurrent = await loadCurrentLinked(request);
      const finalResolved = await resolveGenerationBoundExternalSessionFollowSurface(
        finalCurrent.linked.agentId,
        request.source.linkGeneration,
      );
      if (
        sourceIdentity(finalCurrent.linked) !== identity
        || finalResolved.resource.pluginGeneration !== request.source.contributionGeneration
        || Boolean(finalResolved.resource.retirementSignal?.aborted)
        || !finalResolved.providerOps.pageTranscript
      ) {
        throw new ExternalSessionMaterializeSourceInterruptionError(
          'source_changed',
          'External session source changed before finalization.',
        );
      }
      const finalPage = await readTranscriptPage(() => finalResolved.providerOps.pageTranscript!({
        source: finalCurrent.linked.source,
        remoteSessionId: finalCurrent.linked.remoteSessionId,
        direction: 'older',
        maxBytes: CAPTURE_MAX_BYTES,
        maxItems: 1,
      }));
      if (finalPage.truncated || finalPage.tailCursor !== cursor) {
        throw new ExternalSessionMaterializeSourceInterruptionError(
          'source_changed',
          'External session source was rewritten before finalization.',
        );
      }
      if (appendedPageCount === 0) return;
      yield {
        groupId: `final-catch-up-validation:${createHash('sha256')
          .update(cursor, 'utf8')
          .digest('hex')
          .slice(0, 16)}`,
        items: [],
        sourceRead: {
          availability: 'reachable',
          sourceIdentity: identity,
          sourceGeneration: request.source.sourceGeneration,
          revision: revisionForTail(identity, cursor),
          relationshipToCapture: 'appended',
          eof: true,
        },
      };
    },
    sendHistoricalCommand: input.sendHistoricalCommand,
  });
}
