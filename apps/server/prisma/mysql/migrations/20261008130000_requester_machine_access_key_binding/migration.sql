-- Install the new constraint before removing the predecessor constraint: both
-- accept every same-owner row, and failed DDL never leaves Machine custody free.
ALTER TABLE `AccessKey` ADD CONSTRAINT `AccessKey_machineId_fkey`
    FOREIGN KEY (`machineId`) REFERENCES `Machine`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `AccessKey` DROP FOREIGN KEY `AccessKey_accountId_machineId_fkey`;
