ALTER TABLE "MachinePool" ADD COLUMN "teamId" TEXT;
CREATE INDEX "MachinePool_teamId_id_idx" ON "MachinePool"("teamId", "id");
ALTER TABLE "MachinePool" ADD CONSTRAINT "MachinePool_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;
