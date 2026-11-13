-- Workflow Run row display summary: the listed facts sealed beside the accepted
-- snapshot under the same Run key. Existing Runs stay NULL and list from their snapshot.
ALTER TABLE "AutomationRun" ADD COLUMN "workflowDisplaySummaryEnvelope" TEXT;
