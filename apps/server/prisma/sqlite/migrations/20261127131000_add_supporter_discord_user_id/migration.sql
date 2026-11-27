ALTER TABLE "SupporterRecord" ADD COLUMN "discordUserId" TEXT;
CREATE UNIQUE INDEX "SupporterRecord_discordUserId_key" ON "SupporterRecord"("discordUserId");
