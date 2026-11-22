-- Preserve the accepted terminal producer fact on its existing turn.
ALTER TABLE `SessionTurn` ADD COLUMN `automationLifecycleFactsJson` LONGTEXT NULL;
