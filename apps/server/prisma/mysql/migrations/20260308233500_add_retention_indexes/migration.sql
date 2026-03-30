-- CreateIndex
CREATE INDEX `VoiceSessionLease_expiresAt_idx` ON `VoiceSessionLease`(`expiresAt`);

-- CreateIndex
CREATE INDEX `AccountChange_changedAt_accountId_cursor_idx` ON `AccountChange`(`changedAt`, `accountId`, `cursor`);

-- CreateIndex
CREATE INDEX `TerminalAuthRequest_updatedAt_idx` ON `TerminalAuthRequest`(`updatedAt`);

-- CreateIndex
CREATE INDEX `AccountAuthRequest_updatedAt_idx` ON `AccountAuthRequest`(`updatedAt`);

-- CreateIndex
CREATE INDEX `Session_lastActiveAt_updatedAt_idx` ON `Session`(`lastActiveAt`, `updatedAt`);

-- CreateIndex
CREATE INDEX `GlobalLock_expiresAt_idx` ON `GlobalLock`(`expiresAt`);

-- CreateIndex
CREATE INDEX `RepeatKey_expiresAt_idx` ON `RepeatKey`(`expiresAt`);

-- CreateIndex
CREATE INDEX `AutomationRun_state_finishedAt_idx` ON `AutomationRun`(`state`, `finishedAt`);

-- CreateIndex
CREATE INDEX `AutomationRunEvent_ts_idx` ON `AutomationRunEvent`(`ts`);

-- CreateIndex
CREATE INDEX `UserFeedItem_createdAt_idx` ON `UserFeedItem`(`createdAt`);
