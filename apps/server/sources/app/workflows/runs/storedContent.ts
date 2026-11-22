import { validateWorkflowStoredEnvelopeOuterForModeV1, type WorkflowStoredContentBindingV1 } from '@happier-dev/protocol/workflows/workflowStoredContentV1';

export class WorkflowStoredContentError extends Error {
    readonly code: "content_unavailable" | "invalid_input";

    constructor(code: "content_unavailable" | "invalid_input") {
        super(code === "content_unavailable" ? "Workflow content is unavailable" : "Workflow content is invalid");
        this.name = "WorkflowStoredContentError";
        this.code = code;
    }
}

/** Ciphertext-blind Account-mode validation shared by parent and invocation bodies. */
export function assertWorkflowStoredEnvelopeOuterForMode(params: Readonly<{
    raw: string;
    mode: "plain" | "e2ee";
    binding: WorkflowStoredContentBindingV1;
}>): void {
    const result = validateWorkflowStoredEnvelopeOuterForModeV1({
        mode: params.mode, binding: params.binding, serializedEnvelope: params.raw,
    });
    if (result.kind === "available") return;
    throw new WorkflowStoredContentError(result.kind === "modeMismatch" ? "content_unavailable" : "invalid_input");
}
