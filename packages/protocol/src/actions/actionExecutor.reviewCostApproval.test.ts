import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorContext } from './actionExecutor.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { createInMemoryReviewRecordPortV1 } from '../reviews/reviewArtifactV1.testkit.js';
import { DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1 } from '../account/settings/sessionAgentSpawnPolicyV1.js';
import { buildReviewStepsWorkflowV1 } from '../workflows/builtins/reviewAndConverge.js';
import { ReviewStartInputSchema } from '../reviews/reviewStart.js';
import { resolveWorkflowActionFieldBinding } from '../../../../apps/cli/src/daemon/workflows/input.js';
import { readWorkflowActionFieldTextEncodingV1 } from '../workflows/workflowActionTextV1.js';
import { buildWorkflowActionContext } from '../../../../apps/cli/src/daemon/workflows/workflowActionContext.js';
import { normalizeExecutionBackendOptionValue } from './executor/executionRuns.js';

describe('paid Review admission', () => {
  it('asks at the saved Hunt native leaf using its selected paid profile and Machine', async () => {
    const reviewRound = { reviewId: 'saved-hunt-review', roundOrdinal: 1 };
    const built = buildReviewStepsWorkflowV1(ReviewStartInputSchema.parse({ sessionId: 'source-session', scope: 'repository',
      instructions: 'Review repository slices.', profileId: 'paid-profile',
      profileSourceCustody: { kind: 'development', registeredRootId: 'paid-root' },
      reviewers: [{ kind: 'engine', engineId: 'codex', options: { acceptCharge: true } }] }), reviewRound);
    const stage = built.definition.blocks.find(block => block.kind === 'parallel');
    const leaf = stage?.kind === 'parallel' ? stage.branches[0]?.blocks[0] : undefined;
    if (leaf?.kind !== 'action') throw new Error('Expected the saved Hunt native reviewer');
    const input = Object.fromEntries(await Promise.all(Object.entries(leaf.input ?? {}).map(async ([key, binding]) =>
      [key, await resolveWorkflowActionFieldBinding(binding, { inputs: built.inputs,
        resolveResult: async () => ({ reviewRound, newRoundCostConsent: true }),
        resolveWorkspace: async () => { throw new Error('Repository review has no workspace binding'); },
      }, undefined, readWorkflowActionFieldTextEncodingV1(null, key))])));
    let inventoryReads = 0;
    let starts = 0;
    const executor = createActionExecutor({
      executionRunCheckProtocolV2: async () => ({ ok: true, exactMachineId: 'hunt-machine' }),
      reviewEnginesList: async request => {
        inventoryReads++;
        expect(request).toMatchObject({ sessionId: null, machineId: 'hunt-machine', scope: 'repository',
          profileSelections: [{ engineId: normalizeExecutionBackendOptionValue('codex'), profileId: 'paid-profile',
            profileSourceCustody: { kind: 'development', registeredRootId: 'paid-root' } }] });
        return { items: [], selectionItems: [{ engineId: 'codex', value: 'codex', label: 'Paid', enabled: true,
          profileId: 'paid-profile', costConsent: { optionKey: 'acceptCharge', title: 'Accept charges' } }] };
      },
      executionRunStart: async () => { starts++; return { runId: 'hunt-reviewer', callId: 'call', sidechainId: 'call' }; },
    });
    const context: ActionExecutorContext = { ...buildWorkflowActionContext({ runId: 'saved-hunt',
      authorization: { admittedPermissionCeiling: 'read-only', principal: { kind: 'host' } },
      workspace: { machineId: 'hunt-machine' } }),
      externalActionTarget: { kind: 'machine', machineId: 'hunt-machine', project: { machineId: 'hunt-machine', directory: '/repo' } },
      sessionAgentSpawnPolicyV1: DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
      agentStartContext: { caller: { kind: 'originless', runId: 'saved-hunt', runDepth: 0 },
        baseline: { machineId: 'hunt-machine', directory: '/repo' }, roles: {}, ledSubtreeSessionIds: [],
        callerPermissionCeiling: 'read-only', workDepthLimit: 4 },
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1 }) };
    expect(await executor.execute('review.start', input, context)).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect(starts).toBe(0);
    expect(inventoryReads).toBe(1);
  });
  it.each(['review.new_round', 'execution.run.action'] as const)('requires approval before paid native rerounds through %s', async actionId => {
    let starts = 0;
    const executor = createActionExecutor({ executionRunAction: async () => { starts++; return { ok: true, result: {
      runId: 'next-run', callId: 'next-call', sidechainId: 'next-call', reviewRound: { reviewId: 'review', roundOrdinal: 2 } } }; } });
    const input = actionId === 'review.new_round'
      ? { sessionId: 'review-session', runId: 'previous-run', costConsent: true }
      : { sessionId: 'review-session', runId: 'previous-run', actionId: 'review.new_round', input: { costConsent: true } };
    const context: ActionExecutorContext = { surface: 'mcp', authority: 'account_automation',
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1 }) };
    expect(await executor.execute(actionId, input, context)).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect(starts).toBe(0);
    expect(await executor.execute(actionId, input, { ...context, actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
      approvalWaivedSurfaces: { 'review.new_round': ['mcp'] } }) })).toMatchObject({ ok: true });
    expect(starts).toBe(1);
  });
  it('keeps generic rerounds under the caller credential and validates their native operands', async () => {
    let starts = 0;
    const executor = createActionExecutor({ executionRunAction: async () => { starts++; return {}; } });
    const input = { sessionId: 'review-session', runId: 'previous-run', actionId: 'review.new_round', input: { costConsent: true } };
    const restricted: ActionExecutorContext = { surface: 'mcp', authority: 'account_automation',
      externalActionCredential: { accountId: 'account', principalId: 'principal', credentialId: 'credential', grant: {
        v: 1, actions: { families: [], ids: ['execution.run.action'] }, targets: null,
        approve: false, origins: [], models: null, permissionModes: null, create: null,
      } } };
    expect(await executor.execute('execution.run.action', input, restricted))
      .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(await executor.execute('execution.run.action', { ...input, input: { costConsent: true, unknownOperand: true } },
      { surface: 'mcp', authority: 'account_automation' })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(starts).toBe(0);
  });
  it.each(['agent', 'mcp'] as const)('requires configurable approval on %s even when the caller acknowledges charges', async surface => {
    let starts = 0;
    let inventoryReads = 0;
    let paid = true;
    let available = true;
    const records = createInMemoryReviewRecordPortV1();
    const engineId = 'agent:happier.review.deepsec/deepsec';
    const executor = createActionExecutor({ reviewRecords: () => records,
      reviewEnginesList: async () => { inventoryReads++; return { items: [{ engineId, value: engineId,
        label: 'Paid reviewer', enabled: true, capabilities: { structuredNarration: true },
        ...(paid ? { costConsent: { optionKey: 'acceptCharge', title: 'Accept charges' } } : {}) }],
        selectionItems: [{ engineId, value: engineId, profileId: 'selected-profile', label: 'Selected reviewer',
          enabled: available, capabilities: { structuredNarration: true },
          ...(!available ? { unavailableCode: 'review_scope_unsupported' } : {}),
          ...(!paid ? { costConsent: { optionKey: 'acceptCharge', title: 'Accept charges' } } : {}) }] }; },
      executionRunStart: async () => { starts++; return { runId: 'paid-run', callId: 'call', sidechainId: 'call' }; },
    });
    const input = { sessionId: 'review-session', scope: 'repository', instructions: 'Review repository slices.',
      reviewers: [{ kind: 'engine', engineId, options: { acceptCharge: true } }] };
    const context: ActionExecutorContext = { surface, authority: 'account_automation', defaultSessionId: 'review-session',
      callerPermissionMode: 'read-only', sessionAgentSpawnPolicyV1: DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
      agentStartContext: { caller: { kind: 'session', sessionId: 'review-session', starterDepth: 0, turnDepth: 0 },
        baseline: { machineId: 'machine', directory: '/repo', configuration: { agentTarget: {
          kind: 'agent', identity: { pluginId: 'happier.review.deepsec', localId: 'deepsec' } } } },
        roles: {}, ledSubtreeSessionIds: [], workDepthLimit: 4, callerPermissionCeiling: 'read-only' },
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1 }) };
    expect(await executor.execute('review.start', input, context)).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect(starts).toBe(0);
    expect(inventoryReads).toBe(1);
    const waived = { ...context, actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
      approvalWaivedSurfaces: { 'review.start': [surface] } }) };
    const prepared = await executor.prepare('review.start', input, waived);
    expect(prepared.kind).toBe('ready');
    if (prepared.kind !== 'ready') throw new Error('Saved waiver should admit the selected paid profile');
    expect(inventoryReads).toBe(2);
    expect(await prepared.invocation.run()).toMatchObject({ ok: true });
    expect(starts).toBe(1);
    expect(inventoryReads).toBe(2);
    paid = false;
    expect(await executor.execute('review.start', input, context)).toMatchObject({ ok: true });
    expect(starts).toBe(2);
    expect(inventoryReads).toBe(3);
    paid = true;
    expect(await executor.execute('review.start', input, { surface: 'ui' })).toMatchObject({ ok: true });
    expect(starts).toBe(3);
    expect(inventoryReads).toBe(4);
    // The explicit profile, rather than the engine's default profile, owns both
    // admission and execution. Paid defaults cannot taint a selected free profile.
    const explicitProfileInput = { ...input, profileId: 'selected-profile',
      profileSourceCustody: { kind: 'development', registeredRootId: 'paid-root' } };
    expect(await executor.execute('review.start', explicitProfileInput, context)).toMatchObject({ ok: true });
    expect(starts).toBe(4);
    paid = false;
    expect(await executor.execute('review.start', explicitProfileInput, context))
      .toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect(starts).toBe(4);
    expect(inventoryReads).toBe(6);
    available = false;
    expect(await executor.execute('review.start', explicitProfileInput, context)).toMatchObject({ ok: true, result: {
      results: [{ ok: false, errorCode: 'review_scope_unsupported', error: 'review_scope_unsupported' }],
    } });
    expect(starts).toBe(4);
    expect(inventoryReads).toBe(7);
  });
});
