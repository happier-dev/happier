import { workflowBuiltinTranslationsEnglish as workflowBuiltinTranslations } from './workflowBuiltinTranslations.shared';


import { workflowExamplesTranslationsEnglish as workflowExamplesTranslations } from './workflowExamplesTranslations.shared';


import { workflowEditorPageTranslationsEnglish as workflowEditorPageTranslations } from './workflowEditorPageTranslations.shared';


import { workflowsDestinationTranslationsEnglish as workflowsDestinationTranslations } from './workflowsDestinationTranslations.shared';


import { workflowTriggersTranslationsEnglish as workflowTriggersTranslations } from './workflowTriggersTranslations.shared';


import { workflowStartTranslationsEnglish as workflowStartTranslations } from './workflowStartTranslations.shared';


import { workflowRunListTranslationsEnglish as workflowRunListTranslations } from './workflowRunListTranslations.shared';


import { workflowPluginTranslationsEnglish as workflowPluginTranslations } from './workflowPluginTranslations.shared';


import { workflowAgentAuthoringTranslationsEnglish as workflowAgentAuthoringTranslations } from './workflowAgentAuthoringTranslations.shared';


import { workflowValueReferenceTranslationsEnglish as workflowValueReferenceTranslations } from './workflowValueReferenceTranslations.shared';
import type { WorkflowValueReferenceCopy } from './workflowValueReferenceTranslations.shared';


import { workflowActionTranslationsEnglish as workflowActionTranslations } from './workflowActionTranslations.shared';



export type WorkflowTranslatedLocale = Omit<typeof en, 'input'> & Readonly<{
    input: Omit<typeof en.input, keyof typeof workflowReferenceScopeTranslations | keyof typeof workflowValueReferenceTranslations.en>
        & Partial<typeof workflowReferenceScopeTranslations>;
}>;



export function translated(
    valueReferences: WorkflowValueReferenceCopy,
    value: WorkflowTranslatedLocale,
): typeof en {
    return {
        ...value,
        input: { ...workflowReferenceScopeTranslations, ...valueReferences, ...value.input },
    };
}



export function pluralPl(count: number, one: string, few: string, many: string): string {
    const lastDigit = count % 10;
    const lastTwoDigits = count % 100;
    if (count === 1) return one;
    if (lastDigit >= 2 && lastDigit <= 4 && (lastTwoDigits < 12 || lastTwoDigits > 14)) return few;
    return many;
}



export function pluralRu(count: number, one: string, few: string, many: string): string {
    const lastDigit = count % 10;
    const lastTwoDigits = count % 100;
    if (lastDigit === 1 && lastTwoDigits !== 11) return one;
    if (lastDigit >= 2 && lastDigit <= 4 && (lastTwoDigits < 12 || lastTwoDigits > 14)) return few;
    return many;
}



export type WorkflowTranslations = typeof en;



export const workflowReferenceScopeTranslations = {
    scopeCurrent: 'This scope',
    scopePreviousIteration: 'Previous round',
    scopeOuter: ({ levels }: { levels: number }) => levels === 1 ? 'Parent scope' : `${levels} scopes out`,
} as const;



export const en = {
    testRun: {
        title: 'Test run',
        savedNotice: 'Runs the saved version for real. Unsaved edits stay here.',
        resultsNotice: 'Results from the saved version · latest occurrence. Unsaved edits were not run.',
        recordedDuration: ({ seconds }: { seconds: number }) => `Recorded elapsed time · ${seconds} s`,
        loading: 'Loading test results…',
    },
    runWhen: {
        title: 'Run when',
        success: 'Success',
        failure: 'Failure',
        always: 'Always',
        ifSuccess: 'If it succeeds',
        ifFailure: 'If it fails',
        regardless: 'Either way',
        previousStep: 'Relative to the previous step',
    },
    title: 'Workflows',
    newWorkflow: 'New workflow',
    copyName: ({ name }: { name: string }) => `${name} copy`,
    importJson: 'Import JSON',
    exportJson: 'Export JSON',
    openCollection: 'Open Workflows',
    destination: workflowsDestinationTranslations.en,
    plugins: workflowPluginTranslations.en,
    authoring: workflowAgentAuthoringTranslations.en,
    page: workflowEditorPageTranslations.en,
    actionTitles: workflowActionTranslations.en,
    builtins: workflowBuiltinTranslations.en,
    examples: workflowExamplesTranslations.en,
    triggers: workflowTriggersTranslations.en,
    start: workflowStartTranslations.en,
    list: workflowRunListTranslations.en,
    review: {
        publishedByAgent: 'Published by the agent',
        publishedByYou: 'Published by you',
        editedByYou: 'Edited by you',
        editedByPerson: 'Edited by another person',
        previousAttempt: 'Previous attempt',
        useBody: "Later steps get exactly what you see. No agent turn.",
        usePlanBody: "Uses exactly this plan. No agent turn.",
        reportBackTitle: ({ session }: { session: string }) => "Report back to " + session,
        reportBackBody: ({ session }: { session: string }) => session + " gets this run’s result when it finishes.",
        planRunNotice: "Runs the proposed workflow exactly as shown and uses the plan. It does not save it.",
        editedPlanBody: 'This draft differs from the proposal. Use the reviewed plan for editing first? Your edits stay here, and nothing starts until you run the draft again.',
        title: "Result for review",
        planTitle: "Plan for review",
        waitTitle: "Waiting for you",
        waitBody: "This lane waits until you continue.",
        editsTitle: "Your unsaved edits",
        editsBody: "The stored result stays as it is until you use it.",
        heldBody: "Waiting for your review · not yet passed to later steps",
        noValue: "No valid result yet",
        enterValues: 'Fill in the fields.',
        useResult: "Use this result",
        usePlan: "Use this plan",
        useValues: "Use these values",
        continue: "Continue",
        invalid: "Fix the highlighted field first.",
        newer: "A newer result is available.",
        showNewer: "Show newer",
        keepMyEdits: 'Keep my edits',
        useNewer: 'Use newer',
        showFullResult: 'Show full result',
        showFullPlan: 'Show full plan',
        generationRequested: "Generation requested",
        startsResume: "Starts when you resume the run.",
        generateBody: "The agent writes a new result in this conversation. If it is valid, the run continues without asking you again.",
        acceptedPaused: "Using this result keeps the workflow paused.",
        editResult: "Edit result",
        generate: "Generate result and continue",
        discuss: "Discuss",
        discussBody: "Reply in this step’s conversation. The agent can publish an updated result here.",
        proposal: "Proposed workflow",
        planStarted: "A run from this plan started",
        earlierPlanStarted: "A run was already started from an earlier proposal",
        openEarlierPlanRun: "Open that run",
        runNewProposal: "Run the new proposal",
        runPlan: "Run it as a workflow",
        runPlanBody: "Opens Run review with the proposed workflow. Starting it also uses this plan.",
        editPlan: "Edit the workflow first",
        editPlanBody: "Uses this plan, then opens the proposed workflow as an unsaved draft.",
        editPlanFallback: "Uses this plan, then opens a one-step workflow with this plan as its prompt.",
        waitingMachine: ({ machine } : { machine: string }) => "Waiting for " + machine,
    },

    tabs: {
        saved: 'Saved',
        runs: 'Runs',
        steps: 'Steps',
        flow: 'Flow',
        map: 'Map',
        activity: 'Activity',
    },
    tabsAccessibility: {
        savedRuns: 'Saved workflows or runs',
        stepsFlow: 'Steps or flow',
        activityFlow: 'Activity or flow',
        runViews: "Run views",
    },

    filters: {
        all: 'All',
        active: 'Active',
        needsYou: 'Needs you',
        clear: 'Clear filter',
    },

    empty: {
        savedTitle: 'No saved workflows yet',
        savedBody: 'Saving a workflow keeps a reusable definition you can run or schedule.',
        runsTitle: 'Nothing has run yet',
        runsBody: 'Runs appear here whether or not you save the workflow.',
        filteredTitle: 'No runs match this filter',
        filteredBody: 'Clear the filter to see the rest of your runs.',
        missingTitle: 'This workflow is not available',
        missingBody: 'Happier could not open the workflow this link points to. Your other workflows, Automations and runs are unaffected.',
        missingDraftTitle: 'This unsaved copy was lost',
        missingDraftBody: 'Reloading loses unsaved copies. Open the original workflow to duplicate it again.',
    },

    loadFailedTitle: 'Could not load workflows',
    loadFailedBody: 'Your work is unaffected. Try again when you are ready.',
    retry: 'Try again',
    contentUnavailable: 'Private content is unavailable on this device.',
    readState: {
        historyTitle: 'History not readable',
        historyBody: 'This run was recorded by an earlier development build of Happier, so its history cannot be opened. Start a new run to continue.',
        encryptionTitle: 'Needs encryption setup',
        encryptionBody: 'This is end-to-end encrypted. Set up encryption on this account to open it.',
        keysTitle: 'Waiting for keys',
        keysBody: 'This device does not have the encryption keys for this run yet. Try again after your keys are available.',
        storageTitle: 'Run storage is unavailable',
        storageBody: 'Happier could not access run storage. Check your connection, then try again.',
        openSettings: 'Open Settings',
    },
    contentReasons: {
        invalidHeader: 'This workflow’s saved information is invalid.',
        revisionMismatch: 'This workflow does not match its saved revision.',
        missingBody: 'This workflow’s saved definition is missing.',
        invalidBody: 'This workflow’s saved definition is invalid.',
        notFound: 'This workflow is no longer available.',
    },

    /**
     * The Session a Session-origin workflow is captured from. Waiting,
     * gone, refused and unusable are four different facts.
     */
    sessionEntry: {
        missingTitle: 'This session is no longer available',
        missingBody: 'It may have been deleted, or it lives on another Home. Open Sessions to find it.',
        inaccessibleTitle: 'You cannot open this session',
        inaccessibleBody: 'Happier could not confirm access to it. Sign in again or ask its owner, then reopen this page.',
        failedTitle: 'Could not open this session',
        failedBody: 'Happier keeps trying. You can try again now.',
        unsupportedTitle: 'This session cannot start a workflow',
        unsupportedBody: 'Happier could not read the agent and machine it runs on. Create the workflow from Workflows instead.',
    },

    editor: {
        namePlaceholder: 'Workflow name',
        agentRuntime: 'Agent runtime',
        firstPromptTitle: 'What should happen first?',
        firstPromptBody: 'One prompt is a workflow. Add steps when you need them.',
        promptPlaceholder: 'Describe what this step should do',
        useWorkflowDefault: 'Use workflow default',
        defaultsTitle: 'Defaults',
        produces: 'Produces',
        whereTitle: 'Where',
        add: 'Add',
        addAccessibility: 'Add a block to this workflow',
        addStep: 'Agent step',
        addParallel: 'Side by side',
        addLoop: 'Repeat',
        addIf: 'If',
        targetRequired: 'Choose the machine and project folder for this workflow.',
        loadingTitle: 'Opening workflow…',
        accountChangedTitle: 'You switched accounts',
        accountChangedBody: 'This workflow was opened by the previous account and cannot be carried over. Open it again from Workflows.',
        loadFailedTitle: 'Could not open this workflow',
        loadFailedBody: 'The saved workflow could not be read just now.',
        timeoutTitle: 'Result wait (ms)',
        noDeadline: 'No deadline',
        timeoutExplain: 'Milliseconds to wait for this step’s result before it needs attention. Leave empty for no deadline.',
        wholeNumberRequired: 'Enter a whole number of at least 1.',
        runNow: 'Run now',
        save: 'Save workflow',
        saveAutomation: 'Save Automation',
        schedule: 'Schedule',
        savedRevision: ({ revision }: { revision: string }) => `Saved · ${revision}`,
        moveUp: 'Move up',
        moveDown: 'Move down',
        moveIn: 'Move into the group above',
        moveOut: 'Move out of this group',
        remove: 'Remove',
        undo: 'Undo',
        redo: 'Redo',
        historyRestoreRequiresSetup: 'This Event needs to be set up again. Its saved private configuration cannot be restored after deletion.',
        history: { edited: 'Edit workflow', agent: 'Agent edit', description: 'Edit description', where: 'Change where it runs', target: 'Change how steps run', triggers: 'Edit triggers', example: 'Insert example', document: 'Edit prompt', renameWorkflow: 'Rename workflow', renameStep: 'Rename step', renameLane: 'Rename lane' },
        undoAction: ({ change }: { change: string }) => `Undo: ${change}`,
        redoAction: ({ change }: { change: string }) => `Redo: ${change}`,
        removedBlock: ({ block }: { block: string }) => `Removed ${block}`,
        rename: 'Rename',
        stepOrdinal: ({ position }: { position: number }) => `${position}`,
        unnamedStep: ({ position }: { position: number }) => `Step ${position}`,
        unnamedParallel: 'Parallel group',
        unnamedLoop: 'Loop',
        unnamedIf: 'Condition',
        branch: 'Branch',
        addBranch: 'Add a lane',
        ifTrue: 'Then',
        otherwise: 'Otherwise',
        addOtherwise: 'Add an otherwise branch',
        evaluator: 'Decide whether to continue',
        loopBody: 'Repeat these steps',
        continuation: 'After each round',
    },

    input: {
        ...workflowReferenceScopeTranslations,
        ...workflowValueReferenceTranslations.en,
        label: 'Input',
        result: 'Result',
        change: 'Change',
        none: 'No input',
        previousResult: ({ block }: { block: string }) => `${block} result`,
        workflowInput: ({ name }: { name: string }) => `Workflow input ${name}`,
        currentItem: 'The current item',
        iteration: 'This round',
        unavailable: 'This source is no longer available',
        itemField: {
            value: 'Item value',
            index: 'Item index, from 0',
            position: 'Item position, from 1',
            count: 'Item count',
        },
        iterationField: {
            index: 'Round index, from 0',
            position: 'Round number, from 1',
            count: 'Round count',
            stopReason: 'Stop reason',
        },
        valueKindGroup: 'Value source',
        inputNameGroup: 'Workflow input',
        producerGroup: 'Source step',
        workspaceFieldGroup: 'Workspace field',
        itemFieldGroup: 'Item field',
        iterationFieldGroup: 'Round field',
    },

    inputs: {
        title: 'Workflow inputs',
        addInput: 'Add input',
        namePlaceholder: 'Name',
        descriptionPlaceholder: 'What is this for?',
        required: 'Required',
        optional: 'Optional',
        defaultValue: 'Default value',
        typeString: 'Text',
        typeNumber: 'Number',
        typeBoolean: 'Yes or no',
        typeJson: 'Structured data',
        runSheetTitle: 'Run this workflow',
        runSheetBody: 'Supply the values this workflow declares, then run it.',
        missingRequired: 'This value is required.',
        wrongType: ({ type }: { type: string }) => `This value must be a ${type}.`,
    },

    finalOutput: {
        title: 'Final output',
        none: 'No final output selected',
        change: 'Change',
        clear: 'Clear selection',
        fieldPath: 'Field path',
        explain: 'What this workflow returns when it finishes.',
    },

    conversation: {
        title: 'Conversation',
        sharedRun: 'Same conversation',
        branchesShareAndTakeTurns: 'Branches share one conversation and take turns.',
        fresh: 'Separate conversations',
        fromStep: ({ block }: { block: string }) => `Continue ${block}`,
        existingSession: 'An existing session',
        existingSessionById: ({ sessionId }: { sessionId: string }) => `Session ${sessionId}`,
        noExistingSessions: 'No session on this machine can be continued here.',
        chooseExistingSession: 'Choose a session to continue',
        continuingKeepsAgentAndFolder: 'Continuing keeps the Agent and folder of that conversation. A different Agent or folder needs a separate conversation.',
        waitingForConversation: ({ block }: { block: string }) => `Waiting for ${block} to finish in this conversation.`,
        branchesUseSeparate: 'Branches in a parallel group use separate conversations.',
    },

    workspace: {
        title: 'Workspace',
        inherit: 'Workflow workspace',
        projectCheckout: 'Project folder',
        fromStep: ({ block }: { block: string }) => `Continue ${block}'s workspace`,
        newWorktreeOriginal: 'New worktree from the original folder',
        newWorktreeWorkflow: 'New worktree from the workflow workspace',
        newWorktreeStep: ({ block }: { block: string }) => `New worktree from ${block}`,
        committedOnlyNote: 'A new worktree contains the source folder’s committed state. Staged, uncommitted and untracked changes stay in the source.',
        reuseNote: 'Continuing a workspace sees its uncommitted files exactly as they are.',
        sharedParallelNote: 'Branches sharing one workspace can write to it at the same time.',
        unavailable: ({ block }: { block: string }) => `The workspace for ${block} is unavailable.`,
        unavailableBody: 'Restore it to continue this run, or review a new run that may repeat completed work.',
        // Exactly one of D4's arms is reachable at a time, so each says what
        // that one actually does to the run's completed work.
        unavailableRestoreBody: 'Restore it to continue this run with its completed work intact.',
        unavailableNewRunBody: 'It cannot be restored. A reviewed new run starts over, and completed work may repeat.',
        restore: 'Restore',
        inspect: 'Inspect',
    },

    condition: {
        onlyWhen: 'Only run when',
        always: 'Always',
        stopWhen: 'Stop when',
        ifWhen: 'Run the first branch when',
        addCondition: 'Add a condition',
        removeCondition: 'Remove condition',
        allOf: 'All of these',
        anyOf: 'Any of these',
        not: 'Not',
        exists: 'has a value',
        operatorEq: 'is',
        operatorNeq: 'is not',
        operatorLt: 'is less than',
        operatorLte: 'is at most',
        operatorGt: 'is more than',
        operatorGte: 'is at least',
        notFirstRound: 'this is not the first round',
        trailingCountAtLeast: ({ source, value, count }: { source: string; value: string; count: string }) => `${source} is ${value} ${count} times in a row`,
        loopRanOutOfRounds: ({ loop }: { loop: string }) => `${loop} ran out of rounds`,
        loopEnded: ({ loop, outcome }: { loop: string; outcome: string }) => `${loop} ended: ${outcome}`,
        loopStoppedBecause: ({ loop, condition }: { loop: string; condition: string }) => `${loop} stopped because ${condition}`,
        valuePlaceholder: 'Value',
        literalPlaceholder: 'Type a value',
        skippedReason: ({ block }: { block: string }) => `Skipped because ${block}’s condition was false.`,
    },

    loop: {
        modeTitle: 'Repeat',
        modeCount: 'A set number of times',
        modeItems: 'Once for each item',
        modeUntil: 'Until a result says stop',
        modeEvaluate: 'Until an agent says stop',
        count: 'Number of times',
        items: 'List',
        sequential: 'Sequential items',
        parallel: 'Parallel items',
        maxConcurrentItems: 'Maximum concurrent items',
        maxConcurrentBranches: 'Maximum concurrent branches',
        noWorkflowLimit: 'No workflow limit',
        maxIterations: 'Maximum rounds',
        limitReached: 'Limit reached',
        historyTitle: 'Previous evaluations',
        historyNone: 'None',
        historyLatest: 'Latest',
        historyAll: 'All',
        historyExplain: 'This selects the saved decisions and feedback, not whole transcripts.',
        continuingConversation: 'This evaluator keeps its previous conversation and adds each new round.',
        emptyListCompletes: 'An empty list finishes with no rounds.',
    },

    failurePolicy: {
        title: 'If a step fails',
        failStop: 'Stop this group on failure',
        failStopExplain: 'This group stops starting work and asks active branches to stop, including independent ones. Completed results and changes remain. This is not a rollback.',
        collectOutcomes: 'Finish independent work',
        collectOutcomesExplain: 'Healthy branches finish their whole pipeline and every outcome is collected. Steps after a failure inside a branch do not run.',
    },

    runState: {
        pending: 'Waiting to start',
        queued: 'Waiting to start',
        claimed: 'Starting',
        running: 'Running',
        waiting_for_review: 'Waiting for your review',
        succeeded: 'Completed',
        failed: 'Failed',
        cancel_requested: 'Stopping',
        cancelled: 'Stopped',
        pause_requested: 'Pausing',
        paused: 'Paused',
        interrupted: 'Interrupted',
        expired: 'Expired before it started',
        dispatch_failed: 'Could not start',
        skipped: 'Skipped',
        missed: 'Missed',
        outcome_uncertain: 'Outcome uncertain',
        completed: 'Completed',
        completed_with_failures: 'Completed with failures',
    },

    invocationState: {
        pending: 'Waiting',
        waiting_for_capacity: 'Waiting for capacity',
        admitting: 'Starting',
        running: 'Running',
        waiting_for_approval: 'Waiting for approval',
        waiting_for_review: 'Waiting for your review',
        needs_attention: 'Needs you',
        completed: 'Completed',
        failed: 'Failed',
        skipped: 'Skipped',
        cancel_requested: 'Stopping',
        cancelled: 'Stopped',
        outcome_uncertain: 'Outcome uncertain',
        superseded: 'Replaced by a later attempt',
    },

    run: {
        title: 'Run',
        frozenVersion: "This run uses the version it started with. Edits change future runs only.",
        selectOccurrence: 'Choose a step',
        openReview: 'Review result',
        open: 'Open run',
        openExact: ({ title }: { title: string }) => `Open ${title} run`,
        openExecution: 'Open background run',
        loadMore: 'Load older steps',
        origin: {
            direct: 'Started directly',
            automation: 'Scheduled',
            fromSession: 'From a session',
        },
        needsYou: 'Needs you',
        needsYouLoadedCount: 'loaded',
        review: 'Review',
        stop: 'Stop',
        stopAgain: 'Stop again',
        stopping: 'Stopping…',
        stopRequested: ({ machine }: { machine: string }) => `Stop requested. Waiting for ${machine} to confirm.`,
        evidenceStale: 'Showing the last known details. Happier could not confirm they are current.',
        pauseAtBoundary: 'Pause at boundary',
        pausePending: 'Finishing current work, then pausing.',
        paused: 'Paused after the last completed boundary.',
        resume: 'Resume',
        runAgain: 'Run workflow again',
        retryStep: 'Retry step',
        attempt: ({ attempt }: { attempt: string }) => `Attempt ${attempt}`,
        untitled: 'Workflow run',
        openResult: 'Open result',
        inspectSteps: 'Inspect steps',
        seeFailures: 'See failures',
        saveAsWorkflow: 'Save as workflow',
        saveAsNewWorkflow: 'Save as new workflow',
        showCurrentWork: 'Show current work',
        editWorkflow: 'Edit workflow',
        openWorkflow: 'Open workflow',
        deleteHistory: 'Delete run history',
        deleteHistoryConfirm: 'Inputs and results are removed. Workspaces, conversations, saved workflows and Automations remain.',
        technicalDetails: 'Technical details',
        technical: {
            runId: 'Run ID',
            invocationId: 'Step ID',
            machine: 'Machine',
            machineId: 'Machine ID',
            revision: 'Revision',
        },
        usageUnavailable: 'Usage unavailable',
        startedAt: ({ time }: { time: string }) => `Started ${time}`,
        timeRange: ({ start, end }: { start: string; end: string }) => `${start} – ${end}`,
        openConversation: 'Open conversation',
        openChildRun: 'Open its run',
        openStepDetails: 'Open details',
        outcomeLine: ({ word, sentence }: { word: string; sentence: string }) => `${word} — ${sentence}`,
        attentionReviewRow: ({ step }: { step: string }) => `${step} is waiting for your review`,
        attentionWaitRow: ({ step }: { step: string }) => `${step} is waiting for you`,
        attentionReviewSentence: ({ step }: { step: string }) => `${step} is waiting for your review.`,
        attentionWaitSentence: ({ step }: { step: string }) => `${step} is waiting for you.`,
        reviewing: 'Reviewing',
        notStarted: 'Not started',
        machineUnavailable: ({ machine }: { machine: string }) => `This run lost contact with ${machine}.`,
        machineUnavailableBody: 'Resume choices will appear when the current state is known.',
        completedCount: ({ count }: { count: number }) => `${count} ${count === 1 ? 'step' : 'steps'} completed.`,
        completedWithFailures: ({ completed, failed }: { completed: number; failed: number }) =>
            `Completed with failures. ${completed} completed; ${failed} could not finish.`,
        approvalWanted: ({ block }: { block: string }) => `${block} wants to run a command.`,
        approvalWantedBody: 'Review it to continue.',
        capacityOccupied: 'All authored workflow slots are in use.',
        openSourceSession: 'Open the session it came from',
        observedActivity: 'Observed activity',
        observedActivityBody: 'Happier can see this agent’s phases and agents, but it was not started as a managed workflow, so it cannot be edited, saved or run again.',
    },

    recovery: {
        title: 'Review recovery',
        reattach: 'Reattach',
        reattachExplain: 'Watches the work that is already running. It starts nothing new.',
        resumeSameConversation: 'Resume',
        resumeSameConversationExplain: ({ block }: { block: string }) => `${block} can continue in the same conversation.`,
        freshAgent: 'Continue with a fresh Agent',
        freshAgentExplain: 'This conversation cannot be continued. The workspace is available for a fresh Agent.',
        uncertainEffects: ({ block }: { block: string }) => `${block} stopped before reporting. It may already have changed the workspace.`,
        acknowledgeEffects: 'I understand previous changes may already have happened',
        waitingForStop: 'Waiting for stop or confirmation',
        remainingNotStarted: ({ count }: { count: number }) => `${count} ${count === 1 ? 'sibling has' : 'siblings have'} not started`,
        startReviewedRun: 'Start a reviewed new run',
        editContinuation: 'Inspect or edit continuation',
        continuationPlaceholder: 'Add anything this step should do differently',
        useReplacementInput: 'Replace the step input',
        repeatedEffectWarning: 'Completed work may repeat. The original run keeps its history.',
    },

    unavailable: {
        title: 'Workflows are unavailable',
        body: 'Workflows are unavailable on this server, so a workflow cannot be created or run here.',
        conversion: 'These changes need the workflow format, and workflows are unavailable on this server. Keep this Automation to a single prompt, or try again once workflows are available.',
        savedAutomation: 'This Automation runs as a workflow. Its saved steps stay exactly as they are; you can still edit its name, description and triggers.',
    },
    conversion: {
        title: 'These changes need the workflow format',
        automationTarget: 'Workflow',
        body: 'This Automation still runs one prompt on its saved target. Converting keeps your edits and runs future occurrences as a workflow on one exact machine. Runs that already happened are unaffected.',
        action: 'Convert to workflow',
        machineRequired: 'Choose the machine and project folder future runs should use.',
    },
    save: {
        conflictTitle: 'A newer version was saved',
        conflictBody: 'Your edits are still here.',
        compare: 'Compare',
        saveAsCopy: 'Save as a copy',
        failedTitle: 'Could not save',
        failedBody: 'Your local work is still here.',
        deleteTitle: 'Delete this workflow?',
        deleteBody: 'Existing Automations and runs are unaffected and keep working.',
        unsupportedAttachment: 'Attach media through a durable reference before saving this workflow.',
        nameRequired: 'Name this workflow before saving it.',
        runsCurrentDraft: 'This run uses the workflow as it is on screen. It does not save it.',
    },

    interchange: {
        importTitle: 'Import a workflow',
        importBody: 'Importing opens an unsaved draft to review. It does not run or schedule anything.',
        importIssuesTitle: 'Review this workflow',
        importIssuesBody: 'Some settings need your attention before this workflow can be used.',
        openRepairDraft: 'Open repair draft',
        importFailedTitle: 'Could not read that file',
        importFailedInvalidJson: 'That file is not valid JSON.',
        importFailedUnsupportedVersion: 'That file uses a workflow version this app does not support.',
        importFailedInvalidDocument: 'That file is not a Happier workflow.',
        exportPrivacyNote: 'The exported file contains prompts and settings. It never contains credentials or run results.',
    },

    issue: {
        invalid_version: 'This workflow uses an unsupported version.',
        unknown_field: 'This block has a setting this workflow does not support.',
        invalid_id: 'This block needs a valid identifier.',
        duplicate_id: 'Two blocks share the same identifier.',
        missing_reference: 'This input points at a block that no longer exists.',
        invalid_reference_scope: 'This input points at a block that does not finish first.',
        invalid_input: 'This value is not valid.',
        missing_required_input: 'A required value is missing.',
        invalid_result_contract: 'This step’s result settings are not valid.',
        invalid_condition: 'This condition cannot be compared.',
        invalid_repetition: 'This loop cannot repeat as configured.',
        invalid_max_concurrent: 'Maximum concurrency needs a whole number of at least 1 and applies only to parallel work.',
        unsupported_persisted_attachment: 'Attached media must have a durable reference before saving.',
        conversation_workspace_mismatch: 'This conversation and workspace cannot be continued together.',
        target_unavailable: 'Choose an Agent for this workflow before running it.',
        emptyPrompt: 'Write what this step should do.',
        emptyWaitPrompt: 'Write what you should check or decide here.',
        fieldMissing: ({ field }: { field: string }) => `${field} is required.`,
        fieldInvalid: ({ field }: { field: string }) => `${field} needs a valid value.`,
    },

    /**
     * One localized state per closed Workflow failure and per canonical
     * availability reason. `workflowProblemPresentation.ts` chooses which one;
     * no screen matches on a reason code of its own, and no raw code reaches a
     * person.
     */
    problem: {
        title: 'That did not work',
        waitingTitle: 'Not possible yet',
        subtreeDenied: 'An agent can only start work in its own session or in sessions it leads.',
        roleTargetUnavailable: 'This role cannot be used here.',
        roleRunsAsMismatch: 'This role runs in a way this step cannot use. Choose another role or change how the step runs.',
        policyDeniedField: 'Your agent settings do not allow the requested setting for work an agent starts.',
        permissionExceedsCeiling: 'This needs more permission than the agent that started it has.',
        workDepthExceeded: 'This would go deeper than your delegation limit. Do it in this session, or raise the limit in Settings › Delegation.',
        definitionExceedsAuthority: 'The agent cannot save a workflow that could do more than the agent itself can start.',
        sourceUnavailable: 'This workflow is unavailable, so its triggers cannot run.',
        legacyConversionUnsupported: 'This automation cannot be changed here yet. It keeps running as it is.',
        nativeGoalOwner: 'The agent already keeps going toward goals on its own in this session.',
        sessionAlreadyStarted: 'This session has already started. Session-start triggers can only be added when a session is created.',
        generic: 'Happier could not finish that workflow request. Your work is unaffected.',
        needsRepair: 'This workflow has settings that need repairing before it can run.',
        targetUnavailable: 'The machine or agent this workflow needs is not available right now.',
        notFound: 'This run no longer exists.',
        accessDenied: 'You do not have access to this run.',
        conflict: 'This changed somewhere else. Refresh to see the current version; your local work is kept.',
        inputTooLarge: 'That input is too large to send. Nothing was changed.',
        unresolvedOutcome: 'Happier cannot confirm yet that the previous work stopped, so it cannot be replaced.',
        interactionCapacity: 'This conversation has too much waiting on it to accept more right now.',
        conversationUnavailable: 'That conversation cannot be continued.',
        workspaceRestore: 'The workspace could not be restored. Nothing was changed.',
        waitSelfDependency: 'This would leave the workflow waiting on the conversation that started it.',
        updateRequired: 'The machine running this needs a newer Happier before it can accept this step.',
        ineligible: 'This run has moved on, so that is no longer possible.',
        custodyPending: 'Happier is still waiting for the machine to confirm.',
        runFinished: 'This run has finished.',
        checkpointUnavailable: 'There is no saved point to resume from.',
        recoveryEvidenceRequired: 'Open this run to see its recovery choices.',
        executionNotStarted: 'No step has started yet.',
        custodySettled: 'This run is already settled.',
        unavailableHere: 'This is not available right now.',
    },

    a11y: {
        blockList: 'Workflow blocks',
        stepContext: ({ block, position, total }: { block: string; position: number; total: number }) =>
            `${block}, step ${position} of ${total}`,
        groupContext: ({ group, block }: { group: string; block: string }) => `${block}, inside ${group}`,
        inherited: 'using the workflow setting',
        overridden: 'set for this step',
        inserted: ({ block, position, total }: { block: string; position: number; total: number }) =>
            `Added ${block} at position ${position} of ${total}`,
        removed: ({ block, total }: { block: string; total: number }) =>
            `Removed ${block}. ${total} ${total === 1 ? 'block' : 'blocks'} remain`,
        reordered: ({ block, position, total }: { block: string; position: number; total: number }) =>
            `Moved ${block} to position ${position} of ${total}`,
        validation: ({ reason }: { reason: string }) => reason,
        validationInBlock: ({ block, reason }: { block: string; reason: string }) => `${block}: ${reason}`,
        needsYou: ({ count }: { count: number }) =>
            `${count} ${count === 1 ? 'step needs' : 'steps need'} you`,
        needsYouLoaded: 'loaded',
        terminal: ({ state }: { state: string }) => state,
        terminalWithAttention: ({ state, count }: { state: string; count: number }) =>
            `${state}. ${count} ${count === 1 ? 'step needs' : 'steps need'} you`,
        selectedRowUpdated: ({ block }: { block: string }) => `${block} updated`,
        progress: ({ count }: { count: number }) =>
            `${count} ${count === 1 ? 'step' : 'steps'} updated`,
        progressLoaded: ({ count }: { count: number }) =>
            `${count} ${count === 1 ? 'step' : 'steps'} updated so far`,
        progressWithAttention: ({ count, attention }: { count: number; attention: number }) =>
            `${count} ${count === 1 ? 'step' : 'steps'} updated; ${attention} ${attention === 1 ? 'needs' : 'need'} you`,
        flowNode: ({ node, state }: { node: string; state: string }) => `${node}, ${state}`,
        editStep: 'Edit step',
        editBlock: 'Edit block',
        commandRefused: ({ reason }: { reason: string }) => `Not possible yet. ${reason}`,
    },
};


export const workflowTranslationsEnglish = { en } as const;
