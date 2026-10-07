import { walkthroughSavedTranslationsEnglish as walkthroughSavedTranslations } from './walkthroughSavedTranslations.shared';


import { walkthroughProgressTranslationsEnglish as walkthroughProgressTranslations } from './walkthroughProgressTranslations.shared';



export type WalkthroughTranslations = {
    -readonly [Key in keyof typeof en]: (typeof en)[Key] extends Readonly<Record<string, unknown>>
        ? { -readonly [Child in keyof (typeof en)[Key]]: (typeof en)[Key][Child] }
        : (typeof en)[Key];
};



export function translated(value: WalkthroughTranslations): WalkthroughTranslations {
    return value;
}



export const en = {
    saved: walkthroughSavedTranslations.en,
    progress: walkthroughProgressTranslations.en,
    eyebrow: 'Walkthrough',
    generated: 'Generated',
    generatedBy: ({ model }: { model: string }) => `Generated · ${model}`,
    generatedA11y: 'Written by a model',
    readingChanges: 'Reading the changes…',
    modelFallback: 'The model',
    analysisAll: ({ who, count }: { who: string; count: number }) => `${who} read all ${count}`,
    analysisSome: ({ who, analysed, total }: { who: string; analysed: number; total: number }) => `${who} has read ${analysed} of ${total}`,
    analysisStopped: ({ who, analysed, total }: { who: string; analysed: number; total: number }) => `${who} read ${analysed} of ${total} before stopping`,
    unavailableCount: ({ count }: { count: number }) => `${count} unavailable`,
    youReviewed: ({ count, total }: { count: number; total: number }) => `You reviewed ${count} of ${total}`,
    contents: 'Contents',
    reviewedOfTotal: ({ count, total }: { count: number; total: number }) => `${count} of ${total} reviewed`,
    boardReadProgress: ({ count, total }: { count: number; total: number }) => `${count} of ${total} read`,
    stopOf: ({ number, total }: { number: number; total: number }) => `${number} of ${total}`,
    stopA11y: ({ number, title }: { number: number; title: string }) => `Stop ${number}: ${title}`,
    stopReviewedA11y: ({ number }: { number: number }) => `Stop ${number}, reviewed`,
    importance: {
        start: 'Start here',
        high: 'Read closely',
        low: 'Skim',
    },
    markReviewed: 'Mark reviewed',
    reviewed: 'Reviewed',
    markReviewedA11y: 'Mark this stop reviewed',
    unmarkReviewedA11y: 'Reviewed. Press to clear your mark',
    askAboutThis: 'Ask about this',
    askAboutStopA11y: 'Ask about this stop',
    openConversation: 'Open the walkthrough conversation',
    andIn: ({ file }: { file: string }) => `and in ${file}`,
    newFile: 'New file',
    deletedFile: 'Deleted',
    openInFiles: ({ file }: { file: string }) => `Open ${file} in Files`,
    otherChanges: 'Other changes',
    otherChangesDescription: 'Not part of the story, still here. Open any of them like a normal diff.',
    otherChangesCue: 'Mechanical, shown as diffs',
    keys: {
        move: 'move',
        reviewed: 'reviewed',
        ask: 'ask',
    },
    overview: 'Overview',
    codeMapOf: ({ count }: { count: number }) => `Code map of ${count} ${count === 1 ? 'file' : 'files'}`,
    codeMapHint: 'point at a stop to outline its files',
    touchesOutlined: 'touches the outlined files',
    showOverviewA11y: ({ count }: { count: number }) => `Show the overview: a code map of ${count} files`,
    inventory: {
        title: 'Everything in this comparison · ready now in Files',
        read: 'Read',
        reading: 'Reading',
        unavailable: 'Unavailable',
    },
    arriving: 'The next stops appear here as they are written.',
    previousStop: 'Previous stop',
    nextStop: 'Next stop',
    done: 'Done',
    evidence: {
        displayFailed: 'The saved code couldn’t be displayed. The file stays in Files.',
        binary: 'Binary file, described from its metadata. Shown, not analysed.',
        unavailable: ({ reason }: { reason: string }) => `Couldn’t be read (${reason}). It stays in the list; nothing here claims it was reviewed.`,
    },
    notice: {
        stale: 'Files changed after this was written',
        refresh: 'Refresh walkthrough',
        failed: ({ reason }: { reason: string }) => `Writing stopped · ${reason}`,
        failedGeneric: 'Writing stopped',
        tryAgain: 'Try again',
        chooseModel: 'Choose model',
        cancelled: 'Writing was stopped. What was written stays.',
        rest: 'The rest weren’t written. The files are all in Files; nothing was skipped silently.',
        offline: ({ machine, time }: { machine: string; time: string }) => `${machine} is offline · showing the walkthrough and code from ${time}. Asking and refreshing come back when it reconnects.`,
        offlineA11y: 'Needs the machine, which is offline',
        incomplete: 'Some changes couldn’t be listed. What is here is exact; nothing claims to be complete.',
        undo: 'Undo',
    },
    none: {
        title: 'No walkthrough yet',
        reason: 'A walkthrough reads these changes in order and explains each one beside its exact code. Every file is already in Files.',
        showFiles: 'Show files',
    },
    explain: {
        notInStory: 'Not part of the story',
        readInWalkthrough: 'Read in Walkthrough',
    },
};


export const walkthroughTranslationsEnglish = { en: { walkthrough: en as WalkthroughTranslations } };