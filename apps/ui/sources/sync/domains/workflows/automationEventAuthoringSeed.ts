import type { PluginUiOpenAutomationEventRequestV1 } from '@happier-dev/protocol/plugins/ui';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { readWorkflowEditorDraftSeed, storeWorkflowEditorDraftSeed } from './workflowEditorDraftSeed';

const KIND = 'automation-event-authoring';

export type AutomationEventAuthoringSeed = PluginUiOpenAutomationEventRequestV1;

export function storeAutomationEventAuthoringSeed(seed: AutomationEventAuthoringSeed, lifetime: ServerAccountScopeLifetime): string {
    return storeWorkflowEditorDraftSeed(KIND, seed, lifetime);
}

export function readAutomationEventAuthoringSeed(id: string, scope?: ServerAccountScope | null): AutomationEventAuthoringSeed | null {
    return readWorkflowEditorDraftSeed(KIND, id, scope);
}
