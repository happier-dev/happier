

export type ExampleCopy = Readonly<{ title: string; description: string }>;



export type Copy = Readonly<{
    title: string; fromExample: string; description: string; sessionDescription: string; use: string; chooseSession: string; builtInDescription: string;
    /** An example card's footer fact (07 S2 "{n} steps"). */
    stepCount: (params: { count: number }) => string;
    /** Catalog-declared names for the starter mini-maps, not clipped prompts. */
    nodes: Readonly<Record<'ask' | 'review-correctness' | 'review-tests' | 'summarize' | 'analyze' | 'review' | 'fix' | 'check' | 'classify' | 'reply' | 'digest' | 'deploy', string>>;
    askOnce: ExampleCopy; reviewPullRequest: ExampleCopy; workThroughEachFile: ExampleCopy;
    investigateFailingPrCheck: ExampleCopy; reviewOpenedPullRequest: ExampleCopy;
    weeklyDependencyCheck: ExampleCopy; investigateNewSentryIssue: ExampleCopy;
    repairUntilItPasses: ExampleCopy; triageAnIssue: ExampleCopy; morningDigest: ExampleCopy; deployOnPush: ExampleCopy;
    notifyWhenAgentWaits: ExampleCopy; dailySummaryInSession: ExampleCopy; memoryUpkeepInSession: ExampleCopy;
    installDepsInWorktree: ExampleCopy; testAfterEveryTurn: ExampleCopy; noSessions: string;
    checkForDrift: ExampleCopy; runJobOnSchedule: ExampleCopy;
    deploymentMove: ExampleCopy; backupVerify: ExampleCopy; nightlyBackups: ExampleCopy; restoreDrill: ExampleCopy; dailyHealthDigest: ExampleCopy; restartWhenNeeded: ExampleCopy;
    /** What a session-bound example does when it is offered inside that Session (no session to choose). */
    sessionNotifyDescription: string; sessionDailySummaryDescription: string; sessionTestDescription: string;
    /** The quiet mark beside an example the catalog added recently (lab `b-habit T`, Memory upkeep). */
    newTag: string;
}>;


export const workflowExamplesTranslationsEnglish: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "en"> = { en: {
        investigateFailingPrCheck: { title: "Investigate failed PR checks", description: "Choose a GitHub source and investigate failed checks for a pull request." },
        reviewOpenedPullRequest: { title: "Review a newly opened pull request", description: "Choose a GitHub source and set up a review for newly opened pull requests." },
        weeklyDependencyCheck: { title: "Check dependencies weekly", description: "Choose a project and turn on the weekly schedule for a read-only dependency check." },
        investigateNewSentryIssue: { title: "Investigate a new Sentry issue", description: "Choose a Sentry source and investigate newly opened issues." },
        sessionNotifyDescription: "A notification whenever this session’s agent needs your input.",
        sessionDailySummaryDescription: "A summary here every day at 09:00.",
        sessionTestDescription: "Run an editable test command after every completed, failed or cancelled turn.",
        newTag: 'New',
        notifyWhenAgentWaits: { title: 'Notify me when an agent waits', description: 'Choose a session and get a notification whenever its agent needs your input.' },
        dailySummaryInSession: { title: 'Daily summary in this session', description: 'Choose a session for a summary every day at 09:00.' },
        memoryUpkeepInSession: { title: 'Memory upkeep', description: 'Review this session’s memory every Sunday at 09:00 and keep useful facts current.' },
        installDepsInWorktree: { title: 'Install deps on a new worktree', description: 'Create a new worktree and run an editable install command there.' },
        testAfterEveryTurn: { title: 'Test after every turn', description: 'Choose a session and run an editable test command after every completed, failed or cancelled turn.' },
        checkForDrift: { title: "Check for drift", description: "Compare a deployed service with its expected setup. Nothing is changed." },
        runJobOnSchedule: { title: "Run a job on a schedule", description: "Choose a service and edit the command in the draft, then turn on its schedule. No agent is involved." },
        deploymentMove: { title: 'Move to another Machine', description: 'Move a stateless repository app without Domains. Keep the source until destination health is verified, then retire only its replaced Machine and retain its data.' },
        backupVerify: { title: "Verify a backup", description: "Check one backup snapshot at the level you choose. Nothing is restored or changed." },
        nightlyBackups: { title: "Nightly backups", description: "Back up your data, verify every new snapshot, then keep only what your retention allows. Turn on its schedule to run it each night." },
        restoreDrill: { title: 'Restore drill', description: 'Verify a snapshot, restore it into a separate saved environment, check its data, then stop its services. Keep that environment and its grants for the next drill.' },
        dailyHealthDigest: { title: "Daily health digest", description: "Sum up how your environments and services did and send it to you. Add a trigger to get it every day." },
        restartWhenNeeded: { title: 'Restart when needed', description: 'Check Setup’s update facts on a schedule and restart only when needed. Maintenance windows and normal reboot approvals still apply.' },
        noSessions: 'Start a working session to use this template.',
        nodes: { ask: 'Ask', 'review-correctness': 'Review correctness', 'review-tests': 'Review tests', summarize: 'Summarize findings', analyze: 'Analyze', review: 'Review', fix: 'Fix', check: 'Check', classify: 'Classify', reply: 'Draft a reply', digest: 'Summarize changes', deploy: 'Deploy the exact commit' },
        title: 'Start from an example', fromExample: 'From an example', description: 'Each one opens as a draft. Nothing runs until you choose Run now.', sessionDescription: 'Each one opens as a draft in this session. Nothing runs until you turn it on.', use: 'Use this', chooseSession: 'Choose a session…', builtInDescription: 'Part of Happier. Duplicate one to change it.', stepCount: ({ count }) => `${count} ${count === 1 ? 'step' : 'steps'}`,
        askOnce: { title: 'Ask once', description: 'One step: ask an agent for something and get its answer.' },
        reviewPullRequest: { title: 'Review a pull request', description: 'Two reviewers side by side, then one summary with every finding.' },
        workThroughEachFile: { title: 'Work through each file', description: 'For each file in a list, one at a time: analyze it, then review the change.' },
        repairUntilItPasses: { title: 'Repair until it passes', description: 'Fix and check, repeating until the check passes or the attempts you allow run out. Then you review the last fix.' },
        triageAnIssue: { title: 'Triage an issue', description: "Classify an issue. If it's a bug, fix it; otherwise draft a reply." },
        morningDigest: { title: 'Morning digest', description: 'Sum up what changed in your project and send it to you. Add a trigger to get it every morning.' },
        deployOnPush: { title: 'Deploy on push or merge', description: 'Configure an authorized repository trigger and a fixed Environment to deploy the event’s exact commit through an Action, without an agent.' },
    } };
