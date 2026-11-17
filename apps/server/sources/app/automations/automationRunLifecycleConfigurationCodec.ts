import { AutomationRunLifecycleTriggerSchema, type AutomationRunLifecycleTrigger } from '@happier-dev/protocol/automations/automationRunLifecycle';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { AutomationValidationError } from "./automationValidation";

const storedRunLifecycleTriggerSchema = createStoredReadSchema(AutomationRunLifecycleTriggerSchema);

export function decodeAutomationRunLifecycleConfiguration(row: Readonly<{ runLifecycleConfigurationJson?: string | null }>): AutomationRunLifecycleTrigger {
    if (!row.runLifecycleConfigurationJson) throw new AutomationValidationError("source_unavailable");
    return storedRunLifecycleTriggerSchema.parse(JSON.parse(row.runLifecycleConfigurationJson));
}
