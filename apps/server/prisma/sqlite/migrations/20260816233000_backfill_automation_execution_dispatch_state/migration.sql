-- Repair only source-canonical strict executionRun rows that have never
-- crossed the detached-execution dispatch boundary. Legacy, non-execution,
-- noncanonical, terminal, and ambiguous rows deliberately remain untouched.
UPDATE "AutomationRun"
SET
    "executionDispatchState" = 'notStarted',
    "revision" = "revision" + 1,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "executionInputEnvelope" IS NOT NULL
  AND "executionDispatchState" IS NULL
  AND "executionAttempt" = 0
  AND "state" IN ('queued', 'claimed')
  AND "startedAt" IS NULL
  AND "finishedAt" IS NULL
  AND "executionDispatchCommittedAt" IS NULL
  AND "executionDispatchDueAt" IS NULL
  AND "executionNativeRunId" IS NULL
  AND "executionNativeCallId" IS NULL
  AND "executionNativeSidechainId" IS NULL
  AND "resultEnvelope" IS NULL
  AND "summaryCiphertext" IS NULL
  AND "errorCode" IS NULL
  AND "errorMessage" IS NULL
  AND "producedSessionId" IS NULL
  AND "executionInputEnvelope" GLOB '{"target":{"kind":"executionRun","request":*},"template":*,"templateVersion":*,"triggerEvidence":*,"v":1}';
