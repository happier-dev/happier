import {
    AutomationStoredWorkflowDefinitionRecipeV2ReadSchema,
    AutomationStoredWorkflowDefinitionV2Schema,
    AutomationStoredWorkflowDefinitionV2ReadSchema,
} from '@happier-dev/protocol';

import { openAutomationRecipePayloadForAuthoring } from '@/sync/domains/automations/automationRecipeAuthoring';

/** The private trigger context opened through the canonical Account codec. */
export type OpenedAutomationWorkflowDefinition =
    ReturnType<typeof AutomationStoredWorkflowDefinitionV2Schema.parse>;

/**
 * Opens an Automation's private workflow trigger context for editing.
 *
 * This is the reader half of the writer below, and it deliberately uses the
 * same Account-mode envelope contract as the incumbent one-shot recipe reader
 * (`openAutomationRecipeForAuthoring`): a plain Account reads `{t:'plain'}`
 * directly, an E2EE Account decrypts through the caller's Account codec, and
 * unavailable material fails closed rather than presenting an empty editor that
 * would overwrite the stored definition on Save.
 */
export async function openAutomationWorkflowRecipeForAuthoring(params: Readonly<{
    recipe: unknown;
    decryptRaw?: (ciphertext: string) => Promise<unknown | null>;
    isCurrent?: () => boolean;
}>): Promise<OpenedAutomationWorkflowDefinition> {
    const recipe = AutomationStoredWorkflowDefinitionRecipeV2ReadSchema.parse(params.recipe);
    return openAutomationRecipePayloadForAuthoring({ ...params, envelope: recipe.workflow, schema: AutomationStoredWorkflowDefinitionV2ReadSchema });
}
