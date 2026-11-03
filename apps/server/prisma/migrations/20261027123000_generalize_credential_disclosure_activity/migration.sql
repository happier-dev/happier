ALTER TABLE "TeamCredentialActivityEvent"
    ALTER COLUMN "teamId" DROP NOT NULL,
    ADD COLUMN "subjectKind" TEXT NOT NULL DEFAULT 'team_credential',
    ADD COLUMN "ownerAccountId" TEXT,
    ADD COLUMN "resourceRevision" INTEGER,
    ADD COLUMN "deviceId" TEXT,
    ADD COLUMN "outcome" TEXT,
    ADD COLUMN "copyOutcome" TEXT,
    ADD COLUMN "copyRequestedAt" TIMESTAMP(3);

ALTER TABLE "TeamCredentialActivityEvent" ADD CONSTRAINT "TeamCredentialActivityEvent_ownerAccountId_fkey"
    FOREIGN KEY ("ownerAccountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "CredentialActivity_owner_resource_cursor_idx"
    ON "TeamCredentialActivityEvent"("ownerAccountId", "resourceId", "createdAt", "id");
