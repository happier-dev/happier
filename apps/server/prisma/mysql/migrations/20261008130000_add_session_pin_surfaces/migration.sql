-- Retained pins are Session-list pins. Rail membership is always explicit.
ALTER TABLE `SessionPin`
    ADD COLUMN `listPinned` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `railPinned` BOOLEAN NOT NULL DEFAULT false;
