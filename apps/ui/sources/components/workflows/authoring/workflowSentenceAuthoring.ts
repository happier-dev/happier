import { WorkflowDefinitionV1Schema, type WorkflowActionLeafV1 } from '@happier-dev/protocol/workflows/workflowV1';

import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { storeWorkflowDefinitionDraftSeed, type WorkflowDefinitionDraftSeed } from '@/sync/domains/workflows/workflowDefinitionDraftSeed';
import type { AutomationSessionLifecycleSubjectV1 } from '@happier-dev/protocol/automations/automationSessionLifecycle';
import type { ExactTurnAutomationPrefill } from '@/components/automations/sessionLifecycle/exactTurnAutomationPrefill';
import { resolvePortableServerIdentityForRoutingId } from '@/sync/domains/server/resolvePortableServerIdentityForRoutingId';
import { buildTriggerDefinition } from '../triggers/sessionTriggerForm';
import type { WorkflowTriggerStartContext } from '../triggers/workflowTriggerStarts';

export type WorkflowSentenceEditorIntent = Readonly<Pick<WorkflowDefinitionDraftSeed,
    'name' | 'description' | 'definition' | 'trigger' | 'payloadSchema' | 'eventSeed' | 'nativeEvent' | 'project' | 'lifetimeSession' | 'startContext' | 'executionTarget'> & {
    step?: WorkflowActionLeafV1;
}>;

export type SessionWorkflowSentenceOptions = Readonly<{
    /** Presence with undefined means deliberate Any; absence means this Session. */
    subject?: AutomationSessionLifecycleSubjectV1;
    exactTurnPrefill?: ExactTurnAutomationPrefill;
}>;

/** One Session intake for Work +, Info and exact-turn routes, consumed by the ordinary sentence draft. */
export function createSessionWorkflowSentenceIntent(input: Readonly<{
    name: string;
    session: NonNullable<WorkflowTriggerStartContext['session']>;
    project?: WorkflowDefinitionDraftSeed['project'];
}>, options?: SessionWorkflowSentenceOptions): WorkflowSentenceEditorIntent | null {
    const { session } = input;
    const exact = options?.exactTurnPrefill;
    const subject = options && Object.hasOwn(options, 'subject') ? options.subject : session.subject;
    if (exact && (exact.sourceSessionId !== session.subject.sessionId
        || (exact.sourceServerId !== session.subject.serverId
            && resolvePortableServerIdentityForRoutingId(exact.sourceServerId) !== session.subject.serverId)
        || subject?.kind !== 'session' || subject.sessionId !== exact.sourceSessionId
        || subject.serverId !== session.subject.serverId)) return null;
    const trigger = buildTriggerDefinition({ sessionId: session.subject.sessionId, enabled: true,
        when: { kind: 'turnEnds', ...(subject === undefined ? {} : { subject }),
            ...(exact === undefined ? {} : { sourceTurnId: exact.sourceTurnId, events: exact.events }) } });
    if (trigger === null) return null;
    return { name: input.name, ...(input.project === undefined ? {} : { project: input.project }), trigger,
        lifetimeSession: { sessionId: session.subject.sessionId }, startContext: { session } };
}

/** All verbs keep their ordinary Action and field bindings; the mounted editor owns Save and its retry identity. */
export function prepareWorkflowSentenceEditorEntry(intent: WorkflowSentenceEditorIntent, accountLifetime: ServerAccountScopeLifetime,
    mounted?: Pick<WorkflowDefinitionDraftSeed, 'draft' | 'triggers' | 'incompleteTriggers'>) {
    if (!accountLifetime.isCurrent()) return null;
    const { step, ...seed } = intent;
    const definition = step === undefined ? seed.definition : WorkflowDefinitionV1Schema.parse({ version: 1, blocks: [step] });
    const definitionDraftSeedId = storeWorkflowDefinitionDraftSeed({ ...seed, ...(definition === undefined ? {} : { definition }), ...mounted, initialView: 'sentence' }, accountLifetime);
    return { pathname: '/workflows/[id]' as const, params: { id: 'new', definitionDraftSeedId, serverId: accountLifetime.scope.serverId } };
}
