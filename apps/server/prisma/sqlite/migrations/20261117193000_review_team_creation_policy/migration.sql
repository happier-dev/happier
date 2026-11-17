ALTER TABLE "Team" ADD COLUMN "reviewCreationPolicy" TEXT NOT NULL DEFAULT 'private_default';
ALTER TABLE "ArtifactGrant" ADD COLUMN "requiredByTeamPolicy" BOOLEAN NOT NULL DEFAULT false;
