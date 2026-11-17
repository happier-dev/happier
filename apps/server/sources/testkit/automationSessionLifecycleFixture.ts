import { randomUUID } from 'node:crypto';
import type { AutomationSessionLifecycleEvent, AutomationSessionLifecyclePolicy } from '@happier-dev/protocol/automations/automationSessionLifecycle';
import { projectAutomationSessionLifecycleStructuralTrigger, type AutomationSessionLifecycleTrigger } from '@happier-dev/protocol/automations/automationTriggerDefinition';
import { sealAutomationTriggerDefinitionStoredEnvelopeV1 } from '@happier-dev/protocol/automations/automationTriggerDefinitionStoredContent';
import { encodeAutomationSessionLifecycleConfiguration } from '@/app/automations/automationSessionLifecycleConfigurationCodec';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';

/** Raw DB fixtures retain real current headers and private definitions together. */
export async function createAutomationSessionLifecycleFixtureFields(params: Readonly<{
    automationId: string;
    kind: 'sessionLifecycle';
    sourceSessionId: string;
    events: AutomationSessionLifecycleEvent[];
    policy: AutomationSessionLifecyclePolicy;
    triggerId?: string;
    revision?: number;
}>) {
    const id = params.triggerId ?? randomUUID();
    const revision = params.revision ?? 1;
    const definition: AutomationSessionLifecycleTrigger = {
        kind: params.kind,
        subject: { kind: 'session', serverId: await getOrCreateServerIdentityId(), sessionId: params.sourceSessionId },
        events: params.events,
        policy: params.policy,
    };
    return {
        id, revision,
        ...encodeAutomationSessionLifecycleConfiguration(projectAutomationSessionLifecycleStructuralTrigger(definition)),
        definitionEnvelope: JSON.stringify(sealAutomationTriggerDefinitionStoredEnvelopeV1({
            mode: 'plain', binding: { v: 1, automationId: params.automationId, triggerId: id, triggerRevision: revision, triggerKind: 'sessionLifecycle' },
            definition,
        })),
    };
}
