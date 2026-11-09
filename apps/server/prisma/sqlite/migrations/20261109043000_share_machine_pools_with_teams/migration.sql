ALTER TABLE "MachinePool" ADD COLUMN "teamId" TEXT REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "MachinePool_teamId_id_idx" ON "MachinePool"("teamId", "id");
