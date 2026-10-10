

export type WorkflowBuiltinTranslations = typeof en;



export const en = {
    keepGoing: { title: 'Keep going until done', description: 'Continues until the goal is met' },
    reviewAndConverge: { title: 'Review & converge', description: 'Review until the reviewers agree', apply: 'Apply', verifyAndFix: 'Verify and fix', verifyOnly: 'Verify only', rounds: 'Rounds before stopping' },
    planWithAPanel: { title: 'Plan with a panel', description: 'Several agents plan side by side, then the plan waits for your review.', inputs: { request: 'Request', requestPlaceholder: 'What should the panel plan?', engines: 'Planners' } },
    openAPullRequest: { title: 'Open a pull request', description: 'Asks for a second opinion, then opens a pull request. If the second opinion disagrees, it waits for you.', inputs: { base: 'Base branch', title: 'Pull request title', body: 'Description', question: 'Question for the second opinion' } },
};


export const workflowBuiltinTranslationsEnglish = { en } as const;