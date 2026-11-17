ALTER TABLE "Team" ADD COLUMN "reviewCreationPolicy" "TeamSessionCreationPolicy" NOT NULL DEFAULT 'private_default';
ALTER TABLE "ArtifactGrant" ADD COLUMN "requiredByTeamPolicy" BOOLEAN NOT NULL DEFAULT false;
