import { describe, expect, it, vi } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps, type ActionExecutorContext } from './actionExecutor.js';
import { BugReportSubmitInputSchema, type BugReportSubmitInput } from './specs/bugReport.js';
import { getActionSpec } from './actionSpecs.js';
import { createBlockingApprovalCoordinator } from './blockingApprovalCoordinator.js';
import type { ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { describeApprovalActionFields } from './actionApprovalPresentation.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';

const draft = {
  title: 'Report title', summary: 'Report summary', reproductionStepsText: '', whatChangedRecently: '',
  environment: { appVersion: '0.3', platform: 'web', deploymentType: 'self-hosted' },
  includeDiagnostics: false, acceptedPrivacyNotice: false,
} satisfies BugReportSubmitInput['draft'];
const input: BugReportSubmitInput = { draft,
  destination: { providerUrl: 'https://reports.example.test', issueOwner: 'happier-dev', issueRepo: 'happier' } };

describe('bug report Submit Action admission', () => {
  it.each(['ui', 'agent', 'mcp'] as const)('requires approval before a %s submission without an approval host', async surface => {
    const executor = createActionExecutor({} as ActionExecutorDeps);
    // A new public intent must be admitted before any answering-client effect.
    const result = await executor.execute('bugreport.submit', input,
      { surface, authority: surface === 'ui' ? 'present_user' : 'account_automation' });
    expect(result).toMatchObject({ ok: false, errorCode: surface === 'ui'
      ? 'action_interactive_review_required' : 'approvals_not_supported' });
  });

  it('rejects caller-authored authority, destination credentials and extra diagnostic content envelopes', () => {
    expect(BugReportSubmitInputSchema.safeParse({ ...input, authority: 'present_user' }).success).toBe(false);
    expect(BugReportSubmitInputSchema.safeParse({ ...input, destination: { ...input.destination,
      providerUrl: 'https://user:secret@reports.example.test' } }).success).toBe(false);
    expect(BugReportSubmitInputSchema.safeParse({ ...input, draft: { ...draft, artifacts: [] } }).success).toBe(false);
    expect(BugReportSubmitInputSchema.safeParse({ ...input, destination: { ...input.destination, issueOwner: 'another-owner' } }).success).toBe(false);
  });

  it.each(['approve', 'reject', 'canceled'] as const)('keeps private input live while %s settles the real blocking approval', async decision => {
    const coordinator = createBlockingApprovalCoordinator();
    let stored: ApprovalRequest | null = null;
    const delivered: BugReportSubmitInput[] = [];
    const observations: Parameters<NonNullable<ActionExecutorDeps['observeActionExecution']>>[0][] = [];
    // Approval persistence and the answering app are genuine system boundaries.
    const deps = {
      approvalsCreate: async ({ request }: { request: ApprovalRequest }) => { stored = request; return { artifactId: 'submit-approval' }; },
      approvalsUpdate: async ({ request }: { request: ApprovalRequest }) => { stored = request; return { ok: true as const }; },
      approvalsGet: async () => stored,
      approvalsWaitForDecision: coordinator.waitForDecision,
      isApprovalExecutionOriginCurrent: async () => true,
      // Plugin before/after hooks are external boundaries. Installing both
      // exercises the real host observation lifecycle instead of bypassing it.
      interceptActionExecution: async ({ input: admittedInput }: Parameters<NonNullable<ActionExecutorDeps['interceptActionExecution']>>[0]) =>
        ({ status: 'continue' as const, input: admittedInput }),
      observeActionExecution: (observation: Parameters<NonNullable<ActionExecutorDeps['observeActionExecution']>>[0]) => {
        observations.push(observation);
      },
      bugReportSubmit: async (raw: BugReportSubmitInput) => { delivered.push(raw); return { mode: 'submitted' as const,
        reportId: 'report-1', issueNumber: 1, issueUrl: 'https://github.com/happier-dev/happier/issues/1', artifactCount: 0 }; },
    } as unknown as ActionExecutorDeps;
    const executor = createActionExecutor(deps);
    const privateInput = { ...input, pastedCliDoctorSnapshotJson: 'private diagnostic text',
      draft: { ...draft, includeDiagnostics: true, diagnosticsKinds: ['daemon'], acceptedPrivacyNotice: true,
        title: 'Confidential customer acquisition', summary: 'Unannounced contractual terms',
        currentBehavior: 'private form detail' } };
    const pending = executor.execute('bugreport.submit', privateInput, { surface: 'agent', authority: 'account_automation',
      actionCaller: { kind: 'host' }, serverId: 'home', defaultSessionMachineId: 'originating-agent-machine',
      actionRequestId: 'submit-attempt' });
    await vi.waitFor(() => expect(coordinator.getLiveWaiterCount('submit-approval')).toBe(1));
    expect(delivered).toEqual([]);
    const request = stored as ApprovalRequest | null;
    if (!request) throw new Error('Expected the stored approval');
    const review = describeApprovalActionFields({ actionId: request.actionId, actionArgs: request.actionArgs, preview: request.preview });
    expect(review.unrepresentable).toBeNull();
    expect(request.actionArgs).toMatchObject({ destination: input.destination, draft: {
      acceptedPrivacyNotice: true, diagnosticsKinds: ['daemon'] }, pastedCliDoctorSnapshotJson: '[supplied privately]' });
    if (decision === 'canceled') await coordinator.resolveBlockingDecision({ artifactId: 'submit-approval',
      request: { ...request, status: 'canceled' }, decision: 'reject' });
    else await coordinator.resolveBlockingDecision({ artifactId: 'submit-approval', request,
      decision, decisionAuthority: 'present_user' });
    const result = await pending;
    coordinator.dispose();
    for (const privateText of ['private diagnostic text', 'private form detail', privateInput.draft.title, privateInput.draft.summary]) {
      expect.soft(JSON.stringify(request)).not.toContain(privateText);
      expect.soft(JSON.stringify(observations)).not.toContain(privateText);
    }
    expect(observations).toHaveLength(1);
    if (decision === 'approve') {
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { mode: 'submitted', reportId: 'report-1' } });
      expect(delivered).toEqual([privateInput]);
    } else {
      expect(result).toMatchObject({ ok: false });
      expect(delivered).toEqual([]);
    }
  });

  it('declares external danger, client placement, unchanged automation authority and live-only input', () => {
    expect(getActionSpec('bugreport.submit')).toMatchObject({ safety: 'danger', sideEffectClass: 'external',
      executionPlacement: 'client', requiredAuthority: 'account_automation', approvalInputCustody: 'live_only' });
  });
  it('retains an explicitly configured user waiver without converting automation into a present user', async () => {
    let deliveredAuthority: unknown;
    const settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'bugreport.submit': ['agent'] } });
    const executor = createActionExecutor({ bugReportSubmit: async (_input: BugReportSubmitInput, context: ActionExecutorContext) => {
      deliveredAuthority = context.authority;
      return { mode: 'submitted', reportId: 'waived-report', issueNumber: 2,
        issueUrl: 'https://github.com/happier-dev/happier/issues/2', artifactCount: 0 };
    }, isActionApprovalRequired: (actionId: Parameters<typeof isApprovalRequiredByActionsSettings>[0], context: ActionExecutorContext, admittedInput: unknown) =>
      isApprovalRequiredByActionsSettings(actionId, settings, context, undefined, undefined, admittedInput),
    } as unknown as ActionExecutorDeps);
    expect(await executor.execute('bugreport.submit', input,
      { surface: 'agent', authority: 'account_automation', actionsSettings: settings }))
      .toMatchObject({ ok: true, result: { reportId: 'waived-report' } });
    expect(deliveredAuthority).toBe('account_automation');
  });
});
