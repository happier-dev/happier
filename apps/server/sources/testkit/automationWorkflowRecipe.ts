import { AutomationStoredWorkflowDefinitionRecipeV2Schema, type WorkflowDefinitionV1 } from "@happier-dev/protocol";

/** Current Automation writes use Workflow custody; placement stays with the assignment fixture. */
export function createAutomationWorkflowRecipeFixture(params: Readonly<{
    templateVersion: number;
    directory: string;
    prompt: string;
    conversation?: WorkflowDefinitionV1["defaults"]["conversation"];
}>) {
    return AutomationStoredWorkflowDefinitionRecipeV2Schema.parse({
        v: 2,
        templateVersion: params.templateVersion,
        workflow: { t: "plain", v: {
            workspace: { directory: params.directory },
            executionTarget: { kind: "session" },
            inlineDefinition: { version: 1, inputs: [], defaults: {
                agentTarget: { kind: "agent", identity: { pluginId: "happier.agent.codex", localId: "codex" } },
                ...(params.conversation === undefined ? {} : { conversation: params.conversation }),
            }, blocks: [{ kind: "step", id: "step", document: {
                text: params.prompt, references: [], attachments: [],
            }, input: [], result: { kind: "text" } }] },
        } },
        triggerEvidence: null,
    });
}
