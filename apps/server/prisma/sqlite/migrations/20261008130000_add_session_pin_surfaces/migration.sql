-- Preserve every retained pin's identity, timestamp and shared order.
ALTER TABLE "SessionPin" ADD COLUMN "listPinned" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "SessionPin" ADD COLUMN "railPinned" BOOLEAN NOT NULL DEFAULT false;
