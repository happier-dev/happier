-- AccessKey.accountId remains the requester; Machine.id names its custodian's
-- resource independently. Existing tuples and encrypted data are unchanged.
ALTER TABLE "AccessKey" DROP CONSTRAINT "AccessKey_accountId_machineId_fkey";
ALTER TABLE "AccessKey" ADD CONSTRAINT "AccessKey_machineId_fkey"
    FOREIGN KEY ("machineId") REFERENCES "Machine"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
