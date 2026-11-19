CREATE TABLE "OrganizationFolderAssignment" (
    "accountId" TEXT NOT NULL,
    "entityKind" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "folderId" TEXT NOT NULL,
    CONSTRAINT "OrganizationFolderAssignment_pkey" PRIMARY KEY ("accountId", "entityKind", "entityId"),
    CONSTRAINT "OrganizationFolderAssignment_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OrganizationFolderAssignment_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "SessionOrganizationFolder" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "OrganizationFolderAssignment_accountId_folderId_idx" ON "OrganizationFolderAssignment" ("accountId", "folderId");
CREATE INDEX "OrganizationFolderAssignment_folderId_idx" ON "OrganizationFolderAssignment" ("folderId");
