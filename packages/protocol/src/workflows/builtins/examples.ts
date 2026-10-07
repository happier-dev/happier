import type { WorkflowDefinitionV1 } from '../workflowV1.js';
import { agent, input, literal, result } from './definitionParts.js';

export const WORKFLOW_STARTER_EXAMPLE_KEYS_V1 = [
  'ask-once', 'review-pull-request', 'work-through-each-file', 'repair-until-it-passes',
  'triage-an-issue', 'morning-digest',
] as const;
export type WorkflowStarterExampleKeyV1 = (typeof WORKFLOW_STARTER_EXAMPLE_KEYS_V1)[number];
export type WorkflowStarterExampleV1 = Readonly<{
  key: WorkflowStarterExampleKeyV1;
  titleKey: string;
  descriptionKey: string;
  definition: WorkflowDefinitionV1;
}>;

const askOnce: WorkflowDefinitionV1 = {
  version: 1, defaults: {}, inputs: [{ name: 'request', valueType: 'string', required: true }],
  blocks: [agent('ask', 'Answer the request', 'builder', 'Answer the supplied request.', [input('request')])],
  finalOutput: result('ask'),
};

const reviewPullRequest: WorkflowDefinitionV1 = {
  version: 1, defaults: {}, inputs: [{ name: 'pullRequest', valueType: 'string', required: true }],
  blocks: [
    {
      kind: 'parallel', id: 'reviews', name: 'Side by side', failurePolicy: 'collect_outcomes',
      branches: [
        { id: 'correctness', blocks: [agent('review-correctness', 'Review correctness', 'reviewer',
          'Review the supplied pull request for correctness. Report every finding with evidence and location.', [input('pullRequest')], true)] },
        { id: 'tests', blocks: [agent('review-tests', 'Review tests and edge cases', 'reviewer',
          'Review the supplied pull request for tests and edge cases. Report every finding with evidence and location.', [input('pullRequest')], true)] },
      ],
    },
    agent('summarize', 'Summarize the reviews', 'builder',
      'Summarize both reviews, retaining every finding and any failed or missing review coverage. Do not apply changes.', [result('reviews')]),
  ],
  finalOutput: result('summarize'),
};

const workThroughEachFile: WorkflowDefinitionV1 = {
  version: 1, defaults: {}, inputs: [{ name: 'files', valueType: 'json', required: true }],
  blocks: [{
    kind: 'loop', id: 'files', name: 'For each file',
    repetition: { kind: 'items', items: input('files'), execution: 'sequential', failurePolicy: 'fail_stop' },
    body: [
      agent('analyze', 'Analyze the file', 'scout', 'Analyze the supplied file. Report evidence and paths.', [{ kind: 'item', field: 'value' }], true),
      agent('review', 'Review the analysis', 'reviewer', 'Review the supplied file and analysis. Report findings without changing the file.',
        [{ kind: 'item', field: 'value' }, result('analyze')], true),
    ],
  }],
  finalOutput: result('files'),
};

const triageAnIssue: WorkflowDefinitionV1 = {
  version: 1, defaults: {}, inputs: [{ name: 'issue', valueType: 'string', required: true }],
  blocks: [
    {
      ...agent('classify', 'Classify the issue', 'scout', 'Classify the supplied issue as bug, question or request, and summarize it.', [input('issue')], true),
      result: { kind: 'json', schema: { type: 'object', required: ['kind', 'summary'], additionalProperties: false,
        properties: { kind: { type: 'string', enum: ['bug', 'question', 'request'] }, summary: { type: 'string' } } } },
    },
    {
      kind: 'if', id: 'respond', name: 'If this is a bug',
      when: { kind: 'compare', operator: 'eq', left: result('classify', ['kind']), right: literal('bug') },
      then: [agent('fix', 'Fix the bug', 'builder', 'Fix the classified bug and verify the change.',
        [{ ...result('classify'), producer: { blockId: 'classify', scope: { kind: 'outer', levels: 1 } } }])],
      otherwise: [agent('reply', 'Draft a reply', 'scout', 'Draft a reply to the classified issue.',
        [{ ...result('classify'), producer: { blockId: 'classify', scope: { kind: 'outer', levels: 1 } } }], true)],
    },
  ],
  finalOutput: result('classify'),
};

const repairUntilItPasses: WorkflowDefinitionV1 = {
  version: 1, defaults: {}, inputs: [
    { name: 'request', valueType: 'string', required: true },
    { name: 'maxAttempts', valueType: 'number', required: true },
  ],
  blocks: [
    { kind: 'loop', id: 'repairs', name: 'Repeat until it passes',
      repetition: { kind: 'until', maxIterations: { kind: 'input', name: 'maxAttempts' },
        stopWhen: { kind: 'compare', operator: 'eq', left: result('check', ['passed']), right: literal(true) } },
      body: [
        agent('fix', 'Repair the task', 'builder', 'Repair the supplied task. Run the relevant checks and preserve unrelated work.', [input('request')]),
        { ...agent('check', 'Check the fix', 'builder', 'Run the relevant checks after the repair. Return whether they passed and describe any failures.', [result('fix')]),
          result: { kind: 'json', schema: { type: 'object', required: ['passed', 'failures'], additionalProperties: false,
            properties: { passed: { type: 'boolean' }, failures: { type: 'string' } } } } },
      ],
    },
    { kind: 'wait', id: 'review-last-fix', name: 'Review the last fix', document: { text: 'Review the last repair and check before continuing.', references: [], attachments: [] } },
  ],
  finalOutput: result('repairs', ['last', 'check']),
};

const morningDigest: WorkflowDefinitionV1 = {
  version: 1, defaults: {}, inputs: [],
  blocks: [
    agent('digest', 'Prepare the morning digest', 'scout', "Summarize yesterday's commits, open pull requests and failing checks in this project; lead with what needs me.", [], true),
    { kind: 'action', id: 'notify', name: 'Tell me about it', actionId: 'notifications.notify_me',
      input: { title: literal('Morning digest'), message: result('digest') } },
  ],
  finalOutput: result('digest'),
};

function example(key: WorkflowStarterExampleKeyV1, copyKey: string, definition: WorkflowDefinitionV1): WorkflowStarterExampleV1 {
  return { key, titleKey: `workflows.examples.${copyKey}.title`, descriptionKey: `workflows.examples.${copyKey}.description`, definition };
}

/** Seeds only: these keys never enter the runtime workflow-reference grammar. */
export const WORKFLOW_STARTER_EXAMPLES_V1: readonly WorkflowStarterExampleV1[] = Object.freeze([
  example('ask-once', 'askOnce', askOnce),
  example('review-pull-request', 'reviewPullRequest', reviewPullRequest),
  example('work-through-each-file', 'workThroughEachFile', workThroughEachFile),
  example('repair-until-it-passes', 'repairUntilItPasses', repairUntilItPasses),
  example('triage-an-issue', 'triageAnIssue', triageAnIssue),
  example('morning-digest', 'morningDigest', morningDigest),
]);

export function getWorkflowStarterExamplesV1(): readonly WorkflowStarterExampleV1[] {
  return WORKFLOW_STARTER_EXAMPLES_V1;
}
