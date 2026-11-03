ALTER TABLE "ProjectSource" ADD COLUMN "owner" JSONB;
UPDATE "ProjectSource"
SET "owner" = jsonb_build_object('kind', 'account', 'accountId', "createdByAccountId");
