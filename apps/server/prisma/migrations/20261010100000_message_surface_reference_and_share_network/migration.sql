ALTER TABLE "SessionMessage" ADD COLUMN "surfaceItemReference" JSONB;
ALTER TABLE "PublicSessionShare" ADD COLUMN "networkOff" BOOLEAN NOT NULL DEFAULT false;
