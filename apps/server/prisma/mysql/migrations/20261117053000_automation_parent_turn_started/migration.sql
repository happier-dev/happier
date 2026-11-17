-- Append to preserve the numeric identity of every incumbent enum value.
ALTER TABLE `AutomationRun` MODIFY COLUMN `causeSessionLifecycleEvent` ENUM('parentTurnCompleted', 'parentTurnFailed', 'parentTurnCancelled', 'userActionRequired', 'sessionStarted', 'sessionArchived', 'parentTurnStarted') NULL;
