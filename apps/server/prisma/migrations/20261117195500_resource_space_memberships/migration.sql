CREATE TABLE "ResourceSpaceMembership" (
    "accountId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "resourceKind" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    CONSTRAINT "ResourceSpaceMembership_pkey" PRIMARY KEY ("accountId", "spaceId", "resourceKind", "resourceId"),
    CONSTRAINT "ResourceSpaceMembership_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ResourceSpaceMembership_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Artifact" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ResourceSpaceMembership_accountId_resourceKind_resourceId_idx" ON "ResourceSpaceMembership" ("accountId", "resourceKind", "resourceId");
CREATE INDEX "ResourceSpaceMembership_resourceId_idx" ON "ResourceSpaceMembership" ("resourceId");
