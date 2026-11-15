-- The Session presence deadline reads only live Sessions: the next due
-- (active, oldest lastActiveAt) and the expired ones (active, lastActiveAt at
-- or before the cutoff). The (active, lastActiveAt) key serves both, including
-- under a generic prepared plan; without it both walked the whole Session
-- history of every Account.

-- CreateIndex
CREATE INDEX `Session_active_lastActiveAt_idx` ON `Session`(`active`, `lastActiveAt`);
