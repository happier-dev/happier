-- Remember that an Account besides the owner wrote this Artifact; grant changes never clear it.
ALTER TABLE `Artifact` ADD COLUMN `writtenByOthers` BOOLEAN NOT NULL DEFAULT false;
