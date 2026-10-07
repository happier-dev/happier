

export type ExampleCopy = Readonly<{ title: string; description: string }>;



export type Copy = Readonly<{
    title: string; fromExample: string; description: string; use: string; chooseSession: string; builtInDescription: string;
    /** An example card's footer fact (07 S2 "{n} steps"). */
    stepCount: (params: { count: number }) => string;
    /** Catalog-declared names for the starter mini-maps, not clipped prompts. */
    nodes: Readonly<Record<'ask' | 'review-correctness' | 'review-tests' | 'summarize' | 'analyze' | 'review' | 'fix' | 'check' | 'classify' | 'reply' | 'digest', string>>;
    askOnce: ExampleCopy; reviewPullRequest: ExampleCopy; workThroughEachFile: ExampleCopy;
    repairUntilItPasses: ExampleCopy; triageAnIssue: ExampleCopy; morningDigest: ExampleCopy;
}>;


export const workflowExamplesTranslationsEnglish: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "en"> = { en: {
        nodes: { ask: 'Ask', 'review-correctness': 'Review correctness', 'review-tests': 'Review tests', summarize: 'Summarize findings', analyze: 'Analyze', review: 'Review', fix: 'Fix', check: 'Check', classify: 'Classify', reply: 'Draft a reply', digest: 'Summarize changes' },
        title: 'Start from an example', fromExample: 'From an example', description: 'Each one opens as a draft. Nothing runs until you choose Run now.', use: 'Use this', chooseSession: 'Choose a session…', builtInDescription: 'Part of Happier. Duplicate one to change it.', stepCount: ({ count }) => `${count} ${count === 1 ? 'step' : 'steps'}`,
        askOnce: { title: 'Ask once', description: 'One step: ask an agent for something and get its answer.' },
        reviewPullRequest: { title: 'Review a pull request', description: 'Two reviewers side by side, then one summary with every finding.' },
        workThroughEachFile: { title: 'Work through each file', description: 'For each file in a list, one at a time: analyze it, then review the change.' },
        repairUntilItPasses: { title: 'Repair until it passes', description: 'Fix and check, repeating until the check passes or the attempts you allow run out. Then you review the last fix.' },
        triageAnIssue: { title: 'Triage an issue', description: "Classify an issue. If it's a bug, fix it; otherwise draft a reply." },
        morningDigest: { title: 'Morning digest', description: 'Sum up what changed in your project and send it to you. Add a trigger to get it every morning.' },
    } };