import {
    defineContributionPoint,
    defineContributionProtocol,
} from '@happier-dev/plugin-sdk/contributions';
import {
    defineProtocolArray,
    defineProtocolLiteral,
    defineProtocolObject,
    defineProtocolString,
    defineProtocolUnion,
    type ProtocolSchemaOutput,
} from '@happier-dev/plugin-sdk/protocol';

import {
    MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
    TRIAGE_ACTION_SUBJECTS_V1,
    TRIAGE_AGENT_ACTIONS_CONTRIBUTION_PROTOCOL_ID_V1,
    TRIAGE_AGENT_ACTIONS_CONTRIBUTION_PROTOCOL_VERSION_V1,
} from './bounds.js';
import { TriageActionSubjectV1Schema, type TriageActionSubjectV1 } from './identity.js';
import { defineTriageSingleLineStringV1 } from './strings.js';

/**
 * The one registration path for configured agent action records a subject owner ships (owner ruling 2026-11-07
 * "Agent actions: one shared flow"; Coordination 2026-11-07 15:55Z).
 *
 * A subject owner shipped with Happier (Deployments for receipts and Environments) declares its default records
 * here; a plugin declares the same shape through the `agent-actions` contribution below. Triage never edits its own
 * seed for them. The catalog owner (`happier.triage` `settings/actions.ts`) projects each declaration into an ordinary
 * action record and merges it exactly like a missing built-in: offered until a person edits it, kept disabled when
 * deleted. After that it is the person's record, edited in Settings like any other. A plugin's untouched record is
 * never stored, so it leaves with its plugin; an edited one stays and reads as unavailable while the plugin is gone.
 *
 * A declaration names no Launch Profile: Profiles are per Account, so the person picks one when editing the action,
 * and placement and checkout come from that Profile plus `workspaceMode`. `pull_request` materialization and the
 * `reviewStart` arm stay Triage-owned. `instruction` is the shipped task text used while the record names no Prompt
 * Library invocation.
 */
export const TriageAgentActionDeclarationV1Schema = defineProtocolObject({
    /** The button's words, in the person's language once they rename it. */
    label: defineTriageSingleLineStringV1(MAX_TRIAGE_TEXT_UTF8_BYTES_V1),
    /** Non-empty and limited to the action-subject vocabulary; usually the owner's own native subject. */
    appliesTo: defineProtocolArray(TriageActionSubjectV1Schema, { minItems: 1, maxItems: TRIAGE_ACTION_SUBJECTS_V1.length }),
    workspaceMode: defineProtocolUnion([defineProtocolLiteral('reference_only'), defineProtocolLiteral('repository')]),
    /** `start` runs in the background; `review` opens the prefilled composer. */
    launchMode: defineProtocolUnion([defineProtocolLiteral('start'), defineProtocolLiteral('review')]),
    instruction: defineProtocolString({ minLength: 1 }),
}, { policy: 'closed' });

/** One declaration: the schema's members plus the owner-prefixed id (`deployments.fix-deploy`, `example.plugin/triage-issue`). */
export type TriageSubjectActionDeclarationV1 = Readonly<
    { actionId: string; appliesTo: readonly TriageActionSubjectV1[] }
    & Omit<ProtocolSchemaOutput<typeof TriageAgentActionDeclarationV1Schema>, 'appliesTo'>
>;

export const DEPLOYMENT_FIX_DEPLOY_ACTION_ID_V1 = 'deployments.fix-deploy';
export const DEPLOYMENT_SET_UP_ACTION_ID_V1 = 'deployments.set-up';
export const WORKFLOW_INVESTIGATE_RUN_ACTION_ID_V1 = 'workflows.investigate-run';

/** Subject owners append their records; order is the default display order after Triage's built-ins. */
export const TRIAGE_SUBJECT_ACTION_DECLARATIONS_V1: readonly TriageSubjectActionDeclarationV1[] = Object.freeze([
    {
        actionId: DEPLOYMENT_FIX_DEPLOY_ACTION_ID_V1,
        label: 'Fix this deploy',
        appliesTo: ['deploymentReceipt'],
        workspaceMode: 'repository',
        launchMode: 'review',
        instruction: 'Fix this failed deployment. Investigate the cause, make the changes needed in this project, and show me the proposed fix before deploying it.',
    },
    {
        actionId: DEPLOYMENT_SET_UP_ACTION_ID_V1,
        label: 'Set it up',
        appliesTo: ['deploymentEnvironment'],
        workspaceMode: 'repository',
        launchMode: 'review',
        instruction: 'Set up this environment for this project. Work out what it needs to run, prepare the deployment configuration, and show me what is ready and what still needs my input before deploying.',
    },
    {
        actionId: WORKFLOW_INVESTIGATE_RUN_ACTION_ID_V1,
        label: 'Investigate this Run',
        appliesTo: ['workflowRun'],
        workspaceMode: 'reference_only',
        launchMode: 'review',
        instruction: 'Investigate this failed Workflow Run. Read the Run and its failed steps, explain what caused the failure, and propose the next step.',
    },
] as const satisfies readonly TriageSubjectActionDeclarationV1[]);

/**
 * The plugin path to the same registration (owner ruling 2026-11-08 "List icons and plugin agent actions").
 *
 * A plugin contributes `contributesTo['happier.triage']['agent-actions'][localId] = protocol.contribute({ descriptor })`
 * with the declaration schema above. The catalog owner qualifies the id as `<pluginId>/<localId>` and merges it exactly
 * like a static declaration; nothing is invoked, so the protocol has no operations or surfaces.
 */
export const TriageAgentActionsContributionProtocolV1 = defineContributionProtocol({
    id: TRIAGE_AGENT_ACTIONS_CONTRIBUTION_PROTOCOL_ID_V1,
    version: TRIAGE_AGENT_ACTIONS_CONTRIBUTION_PROTOCOL_VERSION_V1,
    descriptor: TriageAgentActionDeclarationV1Schema,
    operations: {},
});

export const TriageAgentActionsContributionPointV1 = defineContributionPoint([TriageAgentActionsContributionProtocolV1]);
