import type { TriageActionSubjectV1 } from './identity.js';

/**
 * The one registration path for configured agent action records a subject owner ships (owner ruling 2026-11-07
 * "Agent actions: one shared flow"; Coordination 2026-11-07 15:55Z).
 *
 * A subject owner (Deployments for receipts and Environments, a plugin for its own records) declares its default
 * records here instead of Triage editing its own seed. The catalog owner (`happier.triage` `settings/actions.ts`)
 * projects each declaration into an ordinary action record and merges it exactly like a missing built-in: offered
 * until a person edits it, stored on first write, kept disabled when deleted. After that it is the person's record,
 * edited in Settings like any other.
 *
 * A declaration names no Launch Profile: Profiles are per Account, so the person picks one when editing the action,
 * and placement and checkout come from that Profile plus `workspaceMode`. `pull_request` materialization and the
 * `reviewStart` arm stay Triage-owned. `instruction` is the shipped task text used while the record names no Prompt
 * Library invocation.
 */
export type TriageSubjectActionDeclarationV1 = Readonly<{
    /** Stable for the life of the record and owner-prefixed so it never collides (`deployments.fix-deploy`). */
    actionId: string;
    /** The button's words, in the person's language once they rename it. */
    label: string;
    /** Non-empty; usually the owner's own native subject. */
    appliesTo: readonly TriageActionSubjectV1[];
    workspaceMode: 'reference_only' | 'repository';
    /** `start` runs in the background; `review` opens the prefilled composer. */
    launchMode: 'start' | 'review';
    instruction: string;
}>;

export const DEPLOYMENT_FIX_DEPLOY_ACTION_ID_V1 = 'deployments.fix-deploy';
export const DEPLOYMENT_SET_UP_ACTION_ID_V1 = 'deployments.set-up';

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
] as const satisfies readonly TriageSubjectActionDeclarationV1[]);
