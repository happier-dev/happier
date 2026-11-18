import {
  ApprovalAutomaticChecksV1Schema,
  type ApprovalAutomaticChecksV1,
} from '@happier-dev/protocol/approvals/approvalAutomaticChecks';
import type { ApprovalRequestV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';

/**
 * Agent approval cards held by an Action's before checks, one per lab scene (`.happier/design-lab/workflow-events`
 * `consent-v-*`, `wait-v-a*`, `override-v-aoverride`). The data is the shape the server publishes on the approval;
 * the cards draw it through their real owners.
 */
export const APPROVAL_CHECKS_SCENES = [
  'aconsent',
  'achanged',
  'amatch',
  'approveHidden',
  'abot',
  'anomachine',
  'askipped',
  'achecking',
  'apassed',
  'arefused',
  'acouldnotrun',
  'anotify',
  'aoverride',
] as const;
export type ApprovalChecksScene = (typeof APPROVAL_CHECKS_SCENES)[number];

/** What each scene shows, in words, so a reviewer reads the specimen without the lab index. */
export const APPROVAL_CHECKS_SCENE_LABELS: Readonly<Record<ApprovalChecksScene, string>> = {
  aconsent: 'Consent asked · a shared check, first time',
  achanged: 'Re-ask · its steps changed (Review steps open, changed step tagged)',
  amatch: 'Re-ask · it now runs before more Actions',
  approveHidden: 'Consent asked on another Account’s request · Allow hidden',
  abot: 'Shared Bot · the Account holder has not allowed it (skip line)',
  anomachine: 'Skipped · it needs a Machine to run',
  askipped: 'You skipped it · the Action went on',
  achecking: 'Checking · step n of m and elapsed time',
  apassed: 'Passed · the Action runs',
  arefused: 'Refused · the check’s reason',
  acouldnotrun: 'Couldn’t run · its Machine is offline',
  anotify: 'Notify mode · nothing waits',
  aoverride: 'Failed · a person may approve anyway',
};

/**
 * A person's own deploy held by the same checks (lab `consent-v-pconsent`, `wait-v-p*`, `override-v-poverride`): the
 * request the person's app opens for review in place, with the Agent scene whose checks it carries.
 */
export const APPROVAL_CHECKS_PERSON_SCENES = {
  pconsent: 'aconsent',
  pchecking: 'achecking',
  prefused: 'arefused',
  pfailed: 'acouldnotrun',
  poverride: 'aoverride',
} as const satisfies Readonly<Record<string, ApprovalChecksScene>>;
export type ApprovalChecksPersonScene = keyof typeof APPROVAL_CHECKS_PERSON_SCENES;

const FREEZE = {
  automationId: 'automation-release-freeze',
  triggerId: 'trigger-release-freeze',
  triggerRevision: 2,
  // A built-in workflow, so Review steps opens real steps without a Home read.
  workflowId: 'builtin:open-a-pull-request',
  workflowRevision: 4,
  ownerAccountId: 'account-mara',
  actionIds: ['session.title.set'],
  phase: 'before' as const,
  mode: 'wait' as const,
  onFailure: 'ask' as const,
};
const PREDEPLOY = {
  ...FREEZE,
  automationId: 'automation-pre-deploy',
  triggerId: 'trigger-pre-deploy',
  workflowId: 'artifact-pre-deploy-checks',
};
const NOTIFY = {
  ...FREEZE,
  automationId: 'automation-tell-releases',
  triggerId: 'trigger-tell-releases',
  workflowId: 'artifact-tell-releases',
  mode: 'notify' as const,
};
const ref = (row: Readonly<{ automationId: string; triggerId: string }>) => ({
  automationId: row.automationId,
  triggerId: row.triggerId,
});

// What the check's workflow said when it failed: the card reads it as the check's reason.
const TESTS_FAILED = '3 release tests fail in billing: invoice rounding, proration on upgrade, and EU VAT on credit notes.';
const MACHINE_OFFLINE = 'nl-build-3 is offline, so the check couldn’t start.';

/** The running pre-deploy check's Run, so the card can read its step and start time. */
export const APPROVAL_CHECKS_RUN_ID = 'run-pre-deploy-214';

export type ApprovalChecksSceneFixture = Readonly<{
  approval: ApprovalRequestV2;
  /** The pre-deploy Run the scene shows, when it has one (its step progress comes from the Run). */
  runId: string | null;
}>;

/** One scene's approval, owned by `accountId` on `serverId`; `viewerMayAllow` false shows another Account's consent. */
export function createApprovalChecksSceneFixture(
  scene: ApprovalChecksScene,
  params: Readonly<{ serverId: string; accountId: string; nowMs: number; asker?: 'agent' | 'person' }>,
): ApprovalChecksSceneFixture {
  const person = params.asker === 'person';
  const own = { ...PREDEPLOY, ownerAccountId: params.accountId };
  const humanDecision = {
    kind: 'approve' as const,
    authority: 'present_user' as const,
    decidingAccountId: params.accountId,
    decidedAtMs: params.nowMs - 64_000,
  };
  const base = {
    humanApprovalRequired: false,
    subjects: [],
    selectionStatus: 'ready' as const,
    notices: [],
    consents: [],
    runs: [],
    results: [],
  };
  const consent = (
    review?: ApprovalAutomaticChecksV1['consents'][number]['review'],
  ) => ({
    ...base,
    phase: 'consent' as const,
    selected: [FREEZE],
    consents: [
      {
        ...ref(FREEZE),
        decision: 'pending' as const,
        ...(review ? { review } : {}),
      },
    ],
  });
  const run = { ...ref(own), runId: APPROVAL_CHECKS_RUN_ID };
  const checksByScene: Readonly<Record<ApprovalChecksScene, unknown>> = {
    aconsent: consent(),
    approveHidden: consent(),
    achanged: consent({
      reason: 'steps',
      changedSteps: [{ sourceKey: 'workflow', blockId: 'second-opinion' }],
    }),
    amatch: consent({ reason: 'match' }),
    abot: {
      ...base,
      phase: 'passed',
      selected: [FREEZE],
      notices: [
        {
          code: 'action_automation_skipped',
          reason: 'actorConsentUnavailableForRequester',
          ...ref(FREEZE),
          workflowId: FREEZE.workflowId,
        },
      ],
    },
    anomachine: {
      ...base,
      phase: 'passed',
      selected: [FREEZE],
      notices: [
        {
          code: 'action_automation_skipped',
          reason: 'machineRequired',
          ...ref(FREEZE),
          workflowId: FREEZE.workflowId,
        },
      ],
    },
    askipped: {
      ...base,
      phase: 'passed',
      selected: [own, FREEZE],
      consents: [{ ...ref(FREEZE), decision: 'skip' }],
      runs: [run],
      results: [{ ...run, outcome: 'passed' }],
    },
    achecking: {
      ...base,
      phase: 'checking',
      humanApprovalRequired: true,
      humanDecision,
      selected: [own],
      runs: [run],
    },
    apassed: {
      ...base,
      phase: 'passed',
      humanApprovalRequired: true,
      humanDecision,
      selected: [own],
      runs: [run],
      results: [{ ...run, outcome: 'passed' }],
    },
    arefused: {
      ...base,
      phase: 'refused',
      selected: [{ ...own, onFailure: 'refuse' }],
      runs: [run],
      results: [{ ...run, outcome: 'failed', reason: TESTS_FAILED }],
    },
    acouldnotrun: {
      ...base,
      phase: 'refused',
      selected: [{ ...own, onFailure: 'refuse' }],
      runs: [run],
      results: [{ ...run, outcome: 'unavailable', reason: MACHINE_OFFLINE }],
    },
    anotify: {
      ...base,
      phase: 'passed',
      selected: [{ ...NOTIFY, ownerAccountId: params.accountId }],
    },
    aoverride: {
      ...base,
      phase: 'override',
      selected: [own],
      runs: [run],
      results: [{ ...run, outcome: 'failed', reason: TESTS_FAILED }],
    },
  };
  const automaticChecks = ApprovalAutomaticChecksV1Schema.parse(
    checksByScene[scene],
  );
  const decided =
    automaticChecks.phase === 'passed' || automaticChecks.phase === 'checking';
  const approval: ApprovalRequestV2 = {
    v: 2,
    // A refusal settles the request without running it; a pass lets it run.
    status: automaticChecks.phase === 'refused' ? 'failed' : decided && scene !== 'achecking' ? 'executing' : 'open',
    ...(automaticChecks.phase === 'refused' ? {
      execution: { executedAtMs: params.nowMs - 30_000, ok: false, effectAttempted: false,
        errorCode: 'action_interception_rejected', error: 'action_interception_rejected',
        details: { message: automaticChecks.results.map((result) => result.reason).filter(Boolean).join('\n') } },
    } : {}),
    createdAtMs: params.nowMs - 90_000,
    updatedAtMs: params.nowMs - 60_000,
    createdBy: person ? { surface: 'system' } : { surface: 'agent', sessionId: 'dev-approval-checks' },
    requestedSurface: person ? 'ui' : 'agent',
    // An Account-placed Action, so the card can be approved here without a Machine's signed placement; the checks
    // around it are what the specimen shows.
    actionId: 'session.title.set',
    actionArgs: { sessionId: 'dev-approval-checks', title: 'Ship the billing fix' },
    summary: 'Rename the session to “Ship the billing fix”',
    executionOriginV1: person ? {
      v: 1,
      authority: 'present_user',
      surface: 'ui',
      caller: { kind: 'host' },
      accountId: params.accountId,
      serverId: params.serverId,
      // The in-place review addresses this Home by its portable identity, so the request names it too; without it
      // the review fails closed ("Failed to load approval").
      serverIdentityId: params.serverId,
      actionId: 'session.title.set',
      requestId: `dev-approval-checks-person-${scene}`,
    } : {
      v: 1,
      authority: 'account_automation',
      surface: 'agent',
      caller: {
        kind: 'session',
        sessionId: 'dev-approval-checks',
        starterDepth: 0,
        turnDepth: 0,
      },
      // The viewer may allow a shared check only on its own Account's request.
      accountId: scene === 'approveHidden' ? 'account-ade' : params.accountId,
      serverId: params.serverId,
      sessionId: 'dev-approval-checks',
      actionId: 'session.title.set',
      requestId: `dev-approval-checks-${scene}`,
    },
    automaticChecks,
  } as ApprovalRequestV2;
  return {
    approval,
    runId: automaticChecks.runs.length > 0 ? APPROVAL_CHECKS_RUN_ID : null,
  };
}
