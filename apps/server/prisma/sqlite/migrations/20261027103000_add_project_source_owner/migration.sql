ALTER TABLE "ProjectSource" ADD COLUMN "owner" JSONB;
UPDATE "ProjectSource"
SET "owner" = json_object('kind', 'account', 'accountId', "createdByAccountId");
