import { BUILTIN_WORKFLOW_TITLES_V1 } from '@happier-dev/protocol/workflows/workflowRunDisplayMetadataV1';

export type WorkflowBuiltinTranslations = Omit<typeof en, 'repositoryReview'> & {
    repositoryReview?: typeof en.repositoryReview;
};



export const en = {
    keepGoing: { title: BUILTIN_WORKFLOW_TITLES_V1['builtin:keep-going'], description: 'Continues until the goal is met' },
    reviewAndConverge: { title: BUILTIN_WORKFLOW_TITLES_V1['builtin:review-and-converge'], description: 'Review until the reviewers agree', apply: 'Apply', verifyAndFix: 'Verify and fix', verifyOnly: 'Verify only', rounds: 'Rounds before stopping', inputs: { engines: 'Reviewers', reviewSession: 'Session to review', useJudge: 'Let a judge settle disputes', focus: 'What to focus on' } },
    planWithAPanel: { title: BUILTIN_WORKFLOW_TITLES_V1['builtin:plan-with-a-panel'], description: 'Several agents plan side by side, then the plan waits for your review.', inputs: { request: 'Request', requestPlaceholder: 'What should the panel plan?', engines: 'Planners' } },
    parallelImplementations: { title: BUILTIN_WORKFLOW_TITLES_V1['builtin:parallel-implementations'], description: 'Implement in separate worktrees, compare the diffs, then choose a result.', inputs: { first: 'First model', second: 'Second model', third: 'Third model' } },
    freshOpinions: { title: BUILTIN_WORKFLOW_TITLES_V1['builtin:fresh-opinions'], description: 'Independent answers to the same question, with an optional summary.' },
    answerAndReview: { title: BUILTIN_WORKFLOW_TITLES_V1['builtin:answer-and-review'], description: 'One agent answers, then another reviews that exact answer.' },
    debate: { title: BUILTIN_WORKFLOW_TITLES_V1['builtin:debate'], description: 'Compare views over your chosen rounds, with a summary after each round.' },
    repositoryReview: { title: BUILTIN_WORKFLOW_TITLES_V1['builtin:repository-review'], description: 'Review the entire repository with the selected reviewers.' },
    patternInputs: { question: 'Question', participants: 'Participants', synthesis: 'Summarize the answers', synthesizer: 'Who summarizes', answerer: 'Who answers', reviewer: 'Who reviews', rounds: 'Rounds', digestAuthor: 'Who summarizes each round', previousRoundContext: 'Previous round' },
    openAPullRequest: { title: BUILTIN_WORKFLOW_TITLES_V1['builtin:open-a-pull-request'], description: 'Asks for a second opinion, then opens a pull request. If the second opinion disagrees, it waits for you.', inputs: { base: 'Base branch', title: 'Pull request title', body: 'Description', question: 'Question for the second opinion' } },
};


export const workflowBuiltinTranslationsEnglish = { en } as const;
