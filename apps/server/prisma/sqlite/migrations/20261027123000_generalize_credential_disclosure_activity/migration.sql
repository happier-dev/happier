-- Preserve every retained Team event while allowing Account-scoped subjects.
CREATE TABLE "new_TeamCredentialActivityEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "teamId" TEXT,
    "subjectKind" TEXT NOT NULL DEFAULT 'team_credential',
    "ownerAccountId" TEXT,
    "resourceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "actorAccountId" TEXT,
    "subjectDisplayName" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resourceRevision" INTEGER,
    "deviceId" TEXT,
    "outcome" TEXT,
    "copyOutcome" TEXT,
    "copyRequestedAt" DATETIME,
    CONSTRAINT "TeamCredentialActivityEvent_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TeamCredentialActivityEvent_actorAccountId_fkey" FOREIGN KEY ("actorAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "TeamCredentialActivityEvent_ownerAccountId_fkey" FOREIGN KEY ("ownerAccountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_TeamCredentialActivityEvent" ("id", "teamId", "resourceId", "kind", "actorAccountId", "subjectDisplayName", "createdAt")
    SELECT "id", "teamId", "resourceId", "kind", "actorAccountId", "subjectDisplayName", "createdAt" FROM "TeamCredentialActivityEvent";
DROP TABLE "TeamCredentialActivityEvent";
ALTER TABLE "new_TeamCredentialActivityEvent" RENAME TO "TeamCredentialActivityEvent";
CREATE INDEX "TeamCredentialActivityEvent_teamId_resourceId_createdAt_idx" ON "TeamCredentialActivityEvent"("teamId", "resourceId", "createdAt");
CREATE INDEX "TeamCredentialActivityEvent_actorAccountId_idx" ON "TeamCredentialActivityEvent"("actorAccountId");
CREATE INDEX "CredentialActivity_owner_resource_cursor_idx" ON "TeamCredentialActivityEvent"("ownerAccountId", "resourceId", "createdAt", "id");
