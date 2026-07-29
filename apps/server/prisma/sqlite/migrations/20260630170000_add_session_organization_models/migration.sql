CREATE TABLE "SessionPin" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "sortKey" TEXT,
    "pinnedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,

    CONSTRAINT "SessionPin_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SessionPin_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "SessionOrganizationFolder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "folderKey" TEXT NOT NULL,
    "folderHash" TEXT NOT NULL,
    "parentKey" TEXT,
    "parentHash" TEXT,
    "sortKey" TEXT,
    "displayDbValue" TEXT,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,

    CONSTRAINT "SessionOrganizationFolder_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "SessionOrganizationTag" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "tagKey" TEXT NOT NULL,
    "tagHash" TEXT NOT NULL,
    "sortKey" TEXT,
    "displayDbValue" TEXT,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,

    CONSTRAINT "SessionOrganizationTag_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "SessionTagAssignment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,

    CONSTRAINT "SessionTagAssignment_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SessionTagAssignment_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SessionTagAssignment_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "SessionOrganizationTag" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "SessionOrganizationOrderEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "scopeKind" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "scopeHash" TEXT NOT NULL,
    "itemKind" TEXT NOT NULL,
    "itemKey" TEXT NOT NULL,
    "itemHash" TEXT NOT NULL,
    "sortKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,

    CONSTRAINT "SessionOrganizationOrderEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "SessionOrganizationLabel" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "labelKind" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "scopeHash" TEXT NOT NULL,
    "displayDbValue" TEXT,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,

    CONSTRAINT "SessionOrganizationLabel_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "SessionOrganizationCheckpoint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,

    CONSTRAINT "SessionOrganizationCheckpoint_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "SessionPin_accountId_sessionId_key" ON "SessionPin"("accountId", "sessionId");
CREATE INDEX "SessionPin_accountId_sortKey_idx" ON "SessionPin"("accountId", "sortKey");
CREATE INDEX "SessionPin_sessionId_idx" ON "SessionPin"("sessionId");

CREATE UNIQUE INDEX "SessionOrganizationFolder_accountId_folderHash_key" ON "SessionOrganizationFolder"("accountId", "folderHash");
CREATE INDEX "SessionOrganizationFolder_accountId_parentHash_sortKey_idx" ON "SessionOrganizationFolder"("accountId", "parentHash", "sortKey");
CREATE INDEX "SessionOrganizationFolder_accountId_archivedAt_idx" ON "SessionOrganizationFolder"("accountId", "archivedAt");

CREATE UNIQUE INDEX "SessionOrganizationTag_accountId_tagHash_key" ON "SessionOrganizationTag"("accountId", "tagHash");
CREATE INDEX "SessionOrganizationTag_accountId_sortKey_idx" ON "SessionOrganizationTag"("accountId", "sortKey");
CREATE INDEX "SessionOrganizationTag_accountId_archivedAt_idx" ON "SessionOrganizationTag"("accountId", "archivedAt");

CREATE UNIQUE INDEX "SessionTagAssignment_accountId_sessionId_tagId_key" ON "SessionTagAssignment"("accountId", "sessionId", "tagId");
CREATE INDEX "SessionTagAssignment_accountId_tagId_idx" ON "SessionTagAssignment"("accountId", "tagId");
CREATE INDEX "SessionTagAssignment_sessionId_idx" ON "SessionTagAssignment"("sessionId");
CREATE INDEX "SessionTagAssignment_tagId_idx" ON "SessionTagAssignment"("tagId");

CREATE UNIQUE INDEX "SessionOrgOrderEntry_scope_item_key" ON "SessionOrganizationOrderEntry"("accountId", "scopeKind", "scopeHash", "itemKind", "itemHash");
CREATE INDEX "SessionOrgOrderEntry_scope_sort_idx" ON "SessionOrganizationOrderEntry"("accountId", "scopeKind", "scopeHash", "sortKey");

CREATE UNIQUE INDEX "SessionOrganizationLabel_accountId_labelKind_scopeHash_key" ON "SessionOrganizationLabel"("accountId", "labelKind", "scopeHash");
CREATE INDEX "SessionOrganizationLabel_accountId_labelKind_archivedAt_idx" ON "SessionOrganizationLabel"("accountId", "labelKind", "archivedAt");

CREATE UNIQUE INDEX "SessionOrganizationCheckpoint_accountId_key" ON "SessionOrganizationCheckpoint"("accountId");
CREATE INDEX "SessionOrganizationCheckpoint_accountId_version_idx" ON "SessionOrganizationCheckpoint"("accountId", "version");
