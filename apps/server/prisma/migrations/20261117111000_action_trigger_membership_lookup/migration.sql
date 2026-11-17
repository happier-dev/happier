-- Action-detail reads match the complete structural selector, including multi-Action rows.
-- Literal phase predicates let PostgreSQL select the corresponding live GIN index.
CREATE INDEX "AutomationTrigger_action_before_lookup_idx"
ON "AutomationTrigger" USING GIN (("actionIdsJson"::jsonb) jsonb_path_ops)
WHERE "kind" = 'action' AND "deletedAt" IS NULL AND "consentForAutomationId" IS NULL AND "phase" = 'before';

CREATE INDEX "AutomationTrigger_action_after_lookup_idx"
ON "AutomationTrigger" USING GIN (("actionIdsJson"::jsonb) jsonb_path_ops)
WHERE "kind" = 'action' AND "deletedAt" IS NULL AND "consentForAutomationId" IS NULL AND "phase" = 'after';
