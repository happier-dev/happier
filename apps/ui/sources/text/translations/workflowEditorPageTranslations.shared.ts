import { workflowFieldTranslationsEnglish as workflowFieldTranslations } from './workflowFieldTranslations.shared';



export type WorkflowEditorPageTranslations = typeof en;



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



export const en = {
    fields: workflowFieldTranslations.en,
    blocks: {
        actionSub: 'Action · no agent turn',
        notSet: 'Not set',
        set: 'Set',
        clear: 'Clear',
        required: 'Required',
        noFields: 'Nothing to set for this action.',
        workflowSub: 'Runs another workflow · its steps show in this run',
        builtin: 'Built-in',
        waitTitle: 'Wait for you',
        waitSub: 'This lane waits until you continue',
        waitSubRoot: 'This workflow waits until you continue.',
        waitPlaceholder: 'What should you check or decide here?',
        returnsText: 'Returns text',
        returnsFields: ({ fields }: { fields: string }) => `Returns ${fields}`,
        workflowDefaults: 'Workflow defaults',
        addNamedResults: 'Add named results',
        menuRun: 'Run a workflow',
        menuAction: 'Action',
        menuWait: 'Wait for you',
        actionSearch: 'Search actions',
        workflowSearch: 'Search workflows',
        libraryGroup: 'Your workflows',
        noAgentTurn: 'Notify, review, post — no agent turn',
        agentSub: 'A prompt for an agent',
        parallelSub: 'Lanes that run at the same time',
        loopSub: 'For each item, a number of times, or until…',
        ifSub: 'Only when a result says so',
        actionSourcePhone: 'Your phone',
        actionSourceReview: 'Review engines',
        useNumber: 'Use a number',
        actionUnavailable: ({ action }: { action: string }) => `${action} isn't available here.`,
        childInputs: ({ workflow }: { workflow: string }) => `Inputs come from ${workflow}.`,
        retryLoading: "Retry loading",
        openWorkflow: ({ workflow }: { workflow: string }) => `Open ${workflow}`,
        selfRef: ({ workflow }: { workflow: string }) => `${workflow} runs this workflow, so it can't run inside it.`,
        maxFromInput: ({ name }: { name: string }) => `From input · ${name}`,
        useInput: ({ name }: { name: string }) => `Use input ${name}`,
    },
    backToRun: 'Back to run',
    reviewedCopyTitle: 'Review before saving',
    reviewedCopyBody: 'This is a copy from a Run. Save stores the steps and settings, not Run history or results. Where it runs, where each step runs and supplied input values are Run-only choices. Review references to existing sessions, folders, profiles, models, services and MCP servers before reusing them.',
    chromeTitle: 'Workflow',
    untitled: 'Untitled workflow',
    nameLabel: 'Workflow name',
    descriptionPlaceholder: 'Add a description',
    descriptionLabel: 'Description',
    save: 'Save',
    flow: 'Flow',
    flowSubtitle: 'This draft as a map',
    settings: 'Workflow settings',
    settingsSubtitle: 'Every step uses these unless it changes them.',
    deleteWorkflow: 'Delete workflow',
    deleteBody: 'Past runs are kept.',
    discardChangesBody: 'Goes back to the last saved version. Undo brings your edits back.',
    deleteFailedTitle: 'Could not delete workflow',
    changedForStep: 'Changed for this step',
    issuesToFix: ({ count }: { count: number }) => (count === 1 ? '1 thing to fix before this can run' : `${count} things to fix before this can run`),
    readyToRun: 'Ready',
    saveStatus: {
        notSaved: 'Not saved yet',
        unsaved: 'Unsaved changes',
        saving: 'Saving…',
        saved: 'Saved',
        savedJustNow: 'Saved just now',
        savedAge: ({ age }: { age: string }) => `Saved ${age}`,
        failed: 'Could not save',
        yourEdits: 'Your edits',
        newerVersion: 'The newer version',
        newerVersionRevision: ({ revision }: { revision: string }) => `The newer version · ${revision}`,
    },
    where: {
        label: 'Where it runs',
        choose: 'Choose where it runs',
    },
    sections: {
        whereTitle: 'Where it runs',
        machineAndProject: 'Machine and project',
        eachStepRunsIn: 'Each step runs in',
        eachStepSession: 'Each step shows in your sessions list, under this run.',
        eachStepBackground: 'Each step runs in the background, under this run.',
        aSession: 'A session',
        aBackgroundRun: 'A background run',
        agentTitle: 'Agent and model',
        agentDescription: 'Steps use these unless they choose their own.',
        rolesTitle: 'Roles for this workflow',
        conversationTitle: 'Conversation and workspace',
        inputsTitle: 'Inputs and output',
    },
    /** Why a background run can't be chosen (the run-as availability owner's closed reasons). */
    unavailable: {
        machine_not_selected: 'Choose a machine first.',
        capability_unknown: 'Checking what this machine supports.',
        machine_does_not_support_detached_runs: 'This machine can\'t run background runs yet.',
    },
    /** Workflow settings and Step options (U-9): group summaries and the block subject. */
    inspector: {
        stepOptions: 'Step options',
        whereMissing: 'No machine chosen',
        none: 'None',
        inputCount: ({ count }: { count: number }) => count === 1 ? '1 input' : `${count} inputs`,
        finalOutput: ({ output }: { output: string }) => `Final output: ${output}`,
        originSession: 'The session that started it',
        differsFromWorkflow: 'differs from the workflow',
        followsWorkflow: 'uses the workflow settings',
        advancedTitle: 'Advanced',
        deadline: ({ ms }: { ms: number }) => `Waits ${ms} ms for its result`,
        workflowDefault: ({ value }: { value: string }) => `Workflow default · ${value}`,
        aSession: 'A session…',
        continues: ({ session }: { session: string }) => `Continues ${session}`,
        runsIn: 'Runs in',
        runsInBoundBySession: 'Continues a session, so it runs in that session.',
        reviewTitle: 'Review before continuing',
        reviewDescription: 'Later steps in this lane wait until you use, edit or regenerate the result. Other work keeps going.',
        reviewEvaluator: 'Each iteration waits for your review.',
        reviewsBeforeContinuing: 'Reviews before continuing',
        resultTitle: 'Result',
        resultFromAction: ({ action }: { action: string }) => `Defined by ${action}`,
        resultFromWorkflow: ({ workflow }: { workflow: string }) => `Returns what ${workflow} returns`,
        back: 'Back',
        options: 'Options',
        itemConversation: 'Separate conversation per item; steps inside share it.',
        dropContinue: ({ session }: { session: string }) => `Continue ${session} in this step`,
        dropRefused: ({ session, machine, where }: { session: string; machine: string; where: string }) => `${session} is on ${machine}; this workflow runs on ${where}.`,
        lanes: ({ count }: { count: number }) => `Side by side · ${count} lanes`,
        laneCount: ({ count }: { count: number }) => (count === 1 ? '1 lane' : `${count} lanes`),
        lane: ({ position }: { position: number }) => `Lane ${position}`,
        forEachIn: ({ source }: { source: string }) => `For each item in ${source}`,
        atATime: ({ count }: { count: number }) => `${count} at a time`,
        repeatTimes: ({ count }: { count: number | string }) => `Repeat ${count} times`,
        repeatUntil: ({ condition }: { condition: string }) => `Repeat until ${condition}`,
        repeatUntilDecided: 'Repeat until a step says stop',
        ifSentence: ({ condition }: { condition: string }) => `If ${condition}`,
        onlyWhenSentence: ({ condition }: { condition: string }) => `Only when ${condition}`,
        conditionAll: 'all of these hold',
        conditionAny: 'any of these holds',
        conditionNot: ({ condition }: { condition: string }) => `not (${condition})`,
        returnsStructured: 'Returns structured data',
        returnsDecision: 'Returns a decision',
    },
};


export const workflowEditorPageTranslationsEnglish = { en } as const;
