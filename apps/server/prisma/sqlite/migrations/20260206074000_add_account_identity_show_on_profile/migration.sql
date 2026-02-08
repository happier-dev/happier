-- Add per-provider visibility toggle for public profile badges.
ALTER TABLE "AccountIdentity" ADD COLUMN "showOnProfile" BOOLEAN NOT NULL DEFAULT 1;

