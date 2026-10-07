import type { WorkflowDefinitionV1, WorkflowActionLeafV1 } from '../workflowV1.js';
import type { WorkflowValueReference } from '../workflowReferenceV1.js';
import { REVIEW_FINDINGS_VERIFY_AND_FIX_INSTRUCTIONS_V1,
  REVIEW_FINDINGS_VERIFY_ONLY_INSTRUCTIONS_V1 } from '../../reviews/reviewFindingsApplyInputV1.js';
import { agent, input, literal, result } from './definitionParts.js';

const item = (name: string): WorkflowValueReference => ({ kind: 'item', field: 'value', path: [name] });

// The Judge copies these fields from the canonical comment read. The Action
// owner validates scope and CAS; a transient verdict never resolves a comment.
function verdictAction(id: string, dismiss: boolean, project: boolean, evidence = false): WorkflowActionLeafV1 {
  return { kind: 'action', id, name: dismiss ? 'Dismiss the finding' : 'Uphold the finding',
    actionId: dismiss ? 'reviews.comments.transition' : 'reviews.comments.setDisposition',
    input: {
      commentId: item('commentId'), expectedServerRevision: item('expectedServerRevision'),
      clientMutationId: item('clientMutationId'),
      ...(project ? { projectId: item('projectId') } : { workspace: item('workspace') }),
      ...(dismiss ? { toState: literal('dismissed'), expectedState: item('expectedState'), reason: item('reason') }
        : { disposition: literal('blocking') }),
      ...(evidence ? { evidence: item('evidence') } : {}),
    },
  };
}

export const REVIEW_AND_CONVERGE_WORKFLOW_V1: WorkflowDefinitionV1 = {
  version: 1, defaults: {},
  inputs: [
    { name: 'engines', valueType: 'json', required: true, optionsSourceId: 'review.engines.available' },
    { name: 'maxRounds', valueType: 'number', required: false, default: 3 },
    { name: 'apply', valueType: 'string', required: false, default: 'fix', enum: ['fix', 'report'] },
    { name: 'useJudge', valueType: 'boolean', required: false, default: false },
    { name: 'focus', valueType: 'string', required: false, default: 'Review the changes made in this session.' },
    { name: 'diffFingerprint', valueType: 'string', required: false },
  ],
  blocks: [
    { kind: 'loop', id: 'rounds', name: 'Review until it converges',
      repetition: { kind: 'until', maxIterations: { kind: 'input', name: 'maxRounds' },
        stopWhen: { kind: 'any', conditions: [
          { kind: 'compare', operator: 'eq', left: result('check', ['verdict']), right: literal('converged') },
          { kind: 'compare', operator: 'eq', left: input('apply'), right: literal('report') },
        ] } },
      body: [
        { kind: 'step', id: 'verify', name: 'Verify and fix the findings', document: { text: REVIEW_FINDINGS_VERIFY_AND_FIX_INSTRUCTIONS_V1, references: [], attachments: [] },
          execution: { conversation: { kind: 'origin_session' } },
          onlyWhen: { kind: 'compare', operator: 'gt', left: { kind: 'iteration', field: 'index' }, right: literal(0) },
          input: [result('panel', [], { kind: 'previous_iteration', loopBlockId: 'rounds' }),
            { ...result('judge', [], { kind: 'previous_iteration', loopBlockId: 'rounds' }), optional: true }], result: { kind: 'text' } },
        { kind: 'loop', id: 'panel', name: 'Review with a panel', repetition: { kind: 'items', items: input('engines'),
          execution: 'parallel', failurePolicy: 'collect_outcomes' },
          body: [{ kind: 'action', id: 'review', name: 'Review the changes', actionId: 'review.start', input: {
            sessionId: { kind: 'origin_session_id' }, engineIds: { kind: 'list', items: [{ kind: 'item', field: 'value' }] },
            instructions: input('focus'), reviewCommentAuthorIntent: literal('open'),
          } }],
        },
        { kind: 'action', id: 'disputes', name: 'Read the disputed findings', actionId: 'reviews.comments.list', input: { sessionId: { kind: 'origin_session_id' }, allPages: literal(true) } },
        { ...agent('judge', 'Resolve the disputes', 'judge',
          'Rule only on disputed ReviewComments whose commentIds appear in this panel. Return uphold or dismiss with reason and optional canonical ReviewComment evidence array. Copy each comment\'s serverRevision as expectedServerRevision, state as expectedState, and its projectId or workspace unchanged. Set clientMutationId uniquely for this comment revision and verdict. Never invent a comment, scope, or revision. Missing comments or incomplete pages supply no verdict.',
          [result('panel'), result('disputes')], true),
          onlyWhen: { kind: 'compare', operator: 'eq', left: input('useJudge'), right: literal(true) },
          execution: { engine: { role: 'judge' }, executionTarget: { kind: 'detached_run' }, conversation: { kind: 'fresh' }, permissionMode: 'read-only' },
          result: { kind: 'json', schema: { type: 'object', required: ['verdicts'], additionalProperties: false,
            properties: { verdicts: { type: 'array', items: { type: 'object', additionalProperties: false,
              required: ['commentId', 'verdict', 'reason', 'expectedServerRevision', 'expectedState', 'clientMutationId'],
              properties: {
                commentId: { type: 'string' }, verdict: { type: 'string', enum: ['uphold', 'dismiss'] }, reason: { type: 'string' },
                evidence: { type: 'array', items: { type: 'object' } }, expectedServerRevision: { type: 'integer', minimum: 1 },
                expectedState: { type: 'string', enum: ['proposed', 'open', 'delegated', 'pending_review', 'resolved', 'dismissed'] },
                clientMutationId: { type: 'string' }, projectId: { type: 'string' },
                workspace: { type: 'object', required: ['machineId', 'path'], additionalProperties: false,
                  properties: { machineId: { type: 'string' }, path: { type: 'string' } } },
              },
            } } } } },
        },
        { kind: 'loop', id: 'apply-verdicts', name: 'Apply each verdict',
          onlyWhen: { kind: 'compare', operator: 'eq', left: input('useJudge'), right: literal(true) },
          repetition: { kind: 'items', items: result('judge', ['verdicts']), execution: 'sequential', failurePolicy: 'collect_outcomes' },
          body: [{ kind: 'if', id: 'dismiss-or-uphold', name: 'Dismiss or uphold the finding',
            when: { kind: 'compare', operator: 'eq', left: item('verdict'), right: literal('dismiss') },
            then: [{ kind: 'if', id: 'dismiss-scope', name: 'Dismiss in the finding’s scope', when: { kind: 'exists', value: item('projectId') },
              then: [{ kind: 'if', id: 'dismiss-project-evidence', name: 'Include project evidence when available', when: { kind: 'exists', value: item('evidence') },
                then: [verdictAction('dismiss-project-with-evidence', true, true, true)],
                otherwise: [verdictAction('dismiss-project', true, true)] }],
              otherwise: [{ kind: 'if', id: 'dismiss-workspace-evidence', name: 'Include workspace evidence when available', when: { kind: 'exists', value: item('evidence') },
                then: [verdictAction('dismiss-workspace-with-evidence', true, false, true)],
                otherwise: [verdictAction('dismiss-workspace', true, false)] }],
            }],
            otherwise: [{ kind: 'if', id: 'uphold-scope', name: 'Uphold in the finding’s scope', when: { kind: 'exists', value: item('projectId') },
              then: [verdictAction('uphold-project', false, true)], otherwise: [verdictAction('uphold-workspace', false, false)] }],
          }],
        },
        { kind: 'action', id: 'comments', name: 'Read the current findings', actionId: 'reviews.comments.list', input: { sessionId: { kind: 'origin_session_id' }, allPages: literal(true) } },
        { ...agent('check', 'Check convergence', 'judge',
          'Check convergence using only this panel\'s commentIds and the persisted ReviewComments supplied here. Return converged only if every panel engine completed and materialized its findings, every referenced comment is present, and none remains unresolved at or above the review threshold. Disputed comments need a canonical transition. Transient Judge verdicts are not resolutions. Failed, missing, or incomplete coverage means continue, never converged.',
          [result('panel'), result('comments')], true),
          execution: { engine: { role: 'judge' }, executionTarget: { kind: 'detached_run' }, conversation: { kind: 'fresh' }, permissionMode: 'read-only' },
          result: { kind: 'json', schema: { type: 'object', required: ['verdict'], additionalProperties: false,
            properties: { verdict: { type: 'string', enum: ['continue', 'converged'] }, reason: { type: 'string' } } } },
        },
        { kind: 'step', id: 'report', name: 'Verify and report the findings', document: { text: REVIEW_FINDINGS_VERIFY_ONLY_INSTRUCTIONS_V1, references: [], attachments: [] },
          execution: { conversation: { kind: 'origin_session' } },
          onlyWhen: { kind: 'all', conditions: [
            { kind: 'compare', operator: 'eq', left: input('apply'), right: literal('report') },
            { kind: 'compare', operator: 'eq', left: result('check', ['verdict']), right: literal('continue') },
          ] },
          input: [result('panel'), { ...result('judge'), optional: true }], result: { kind: 'text' } },
      ],
    },
    { kind: 'if', id: 'not-converged', name: 'If the review did not converge',
      when: { kind: 'compare', operator: 'eq', left: result('rounds', ['outcome', 'kind']), right: literal('exhausted') },
      then: [{ kind: 'action', id: 'notify', name: 'Tell me about it', actionId: 'notifications.notify_me', input: {
        title: literal("Review didn't converge"), message: literal('The last round still has open findings. Open the run to see them.'),
      } }], otherwise: [],
    },
  ],
  finalOutput: result('rounds', ['outcome']),
};
