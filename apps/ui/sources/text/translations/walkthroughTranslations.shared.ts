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
    conversationTitle: 'Walkthrough conversation',
    generated: 'Generated',
    generatedBy: ({ model }: { model: string }) => `Generated · ${model}`,
    generatedA11y: 'Written by a model',
    restoring: 'Opening saved walkthroughs…',
    restoreFailedTitle: 'Couldn’t open saved walkthroughs',
    restoreFailedReason: 'Nothing was changed. Try again, or check that the machine is online.',
    readingChanges: 'Reading the changes…',
    modelFallback: 'The model',
    analysisAll: ({ who, count }: { who: string; count: number }) => `${who} read all ${count}`,
    analysisSome: ({ who, analysed, total }: { who: string; analysed: number; total: number }) => `${who} has read ${analysed} of ${total}`,
    analysisStopped: ({ who, analysed, total }: { who: string; analysed: number; total: number }) => `${who} read ${analysed} of ${total} before stopping`,
    unavailableCount: ({ count }: { count: number }) => `${count} unavailable`,
    youReviewed: ({ count, total }: { count: number; total: number }) => `You reviewed ${count} of ${total}`,
    contents: 'Contents',
    reviewedOfTotal: ({ count, total }: { count: number; total: number }) => `${count} of ${total} reviewed`,
    boardReviewedCount: ({ count, total }: { count: number; total: number }) => `${count} of ${total}`,
    boardStopsReviewed: 'stops reviewed',
    boardAllReviewed: 'Every stop reviewed',
    continueReading: 'Continue reading',
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
    askQuestionA11y: ({ question }: { question: string }) => `Ask: ${question}`,
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
    stopNumber: ({ number }: { number: number }) => `Stop ${number}`,
    receipt: {
        wrote: 'Wrote the walkthrough',
        updated: 'Updated the walkthrough',
        savedAnalysis: 'Saved the change analysis',
        updatedAnalysis: 'Updated the change analysis',
        stopCount: ({ count }: { count: number }) => (count === 1 ? '1 stop' : `${count} stops`),
        open: 'Open walkthrough',
        openChanges: 'Open changes',
        stopChanged: ({ number }: { number: number }) => `stop ${number} changed`,
        stopsChanged: ({ numbers }: { numbers: string }) => `stops ${numbers} changed`,
        stopsRemoved: ({ count }: { count: number }) => (count === 1 ? '1 stop removed' : `${count} stops removed`),
        stopsMergedInto: ({ count, number }: { count: number; number: number }) => `${count} stops merged into stop ${number}`,
        titleEditKept: 'your title edit kept',
        lastChangeUndone: 'last change undone',
        undo: 'Undo',
        undoing: 'Undoing…',
        undone: 'Undone',
        changedSince: 'The walkthrough changed after this update, so it can’t be undone here.',
    },
    exchange: {
        youAsked: 'You asked the walkthrough',
        waiting: 'Waiting for the answer…',
        openConversation: 'Open conversation',
    },
    notice: {
        stale: 'Files changed after this was written',
        refresh: 'Refresh walkthrough',
        failedGeneric: 'Writing stopped',
        endedPartway: 'Writing stopped partway.',
        stoppedAfter: ({ count }: { count: number }) => `Writing stopped after ${count === 1 ? '1 stop' : `${count} stops`}`,
        tryAgain: 'Try again',
        chooseModel: 'Choose model',
        cancelled: 'Writing was stopped. What was written stays.',
        rest: 'The rest weren’t written. The files are all in Files; nothing was skipped silently.',
        offline: ({ machine, time }: { machine: string; time: string }) => `${machine} is offline · showing the walkthrough and code from ${time}. Asking and refreshing come back when it reconnects.`,
        offlineA11y: 'Needs the machine, which is offline',
        unknownStart: 'This walkthrough may not have started',
        unknownStartReason: 'Happier couldn’t confirm that the machine received the request.',
        checkAgain: 'Check again',
        incomplete: 'Some changes couldn’t be listed. What is here is exact; nothing claims to be complete.',
        undo: 'Undo',
    },
    // Why a start was refused, and the next step: written for any output (Walkthrough, Commits), never a code.
    generationFailure: {
        inputTooLarge: 'This change is bigger than the agent on this machine can read at once.',
        contextTooSmall: 'This is more than the selected model can read at once.',
        narrowChange: 'Explain a smaller set of changes, or read these in Files.',
        invalidRequest: 'This machine couldn’t read the request. Its Happier may be out of date.',
        reviewRequest: 'Update this machine’s Happier, then try again.',
        modelUnavailable: 'The selected model isn’t available right now.',
        machineUnavailable: 'Happier can’t reach this machine.',
        reconnectMachine: 'Reconnect it, then try again.',
        disabled: '“Explain changes” is off.',
        enableExplain: 'Turn it on in settings',
    },
    none: {
        title: 'No walkthrough yet',
        reason: 'A walkthrough reads these changes in order and explains each one beside its exact code. Every file is already in Files.',
        showFiles: 'Show files',
    },
    explain: {
        notInStory: 'Not part of the story',
        readInWalkthrough: 'Read in Walkthrough',
        captionLines: ({ start, end }: { start: number; end: number }) => start === end ? `L${start}` : `L${start}–${end}`,
        captionA11y: ({ letter, lines }: { letter: string; lines: string }) => `Caption ${letter}, ${lines}`,
        captionOf: ({ position, total }: { position: number; total: number }) => `${position} of ${total}`,
        captionStop: ({ number, title }: { number: number; title: string }) => `Stop ${number} · ${title}`,
        stopCaptions: ({ number, count }: { number: number; count: number }) => `Stop ${number} · ${count === 1 ? '1 caption' : `${count} captions`}`,
        previousCaption: 'Previous caption',
        nextCaption: 'Next caption',
        showCaption: 'Show caption',
    },
};


export const walkthroughTranslationsEnglish = { en: { walkthrough: en as WalkthroughTranslations } };
