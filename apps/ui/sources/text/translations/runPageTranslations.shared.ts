

export type Count = Readonly<{ count: number }>;



export type Machine = Readonly<{ machine: string }>;



export type Reviewer = Readonly<{ reviewer: string }>;



export type RunPageTranslations = Readonly<{
    untitledRun: string;
    intentTitles: Readonly<{ review: string; plan: string; delegate: string }>;
    thisMachine: string;
    menu: Readonly<{
        cancelResponse: string;
        copyResult: string;
        showInTranscript: string;
        runDetails: string;
        agent: string;
        permissions: string;
        kind: string;
        finishesOnItsOwn: string;
        selectionInherited: string;
        selectionExplicit: string;
        selectionIndependent: string;
        selectionRetained: string;
        selectionChoose: string;
        selectionChooseDetail: string;
        staysOpen: string;
        started: string;
        run: string;
        process: string;
    }>;
    opening: Readonly<{ reading: (params: Machine) => string }>;
    gone: Readonly<{
        title: (params: Machine) => string;
        reason: string;
        closeTab: string;
    }>;
    stopFailed: Readonly<{
        title: Readonly<{ review: string; plan: string; delegate: string; run: string }>;
        reasonWithOthers: (params: Machine & Count) => string;
        reasonAlone: (params: Machine) => string;
        stopSession: string;
    }>;
    steps: Readonly<{
        title: string;
        count: (params: Count) => string;
    }>;
    review: Readonly<{
        findings: string;
        findingsCount: (params: Count) => string;
        highCount: (params: Count) => string;
        severity: Readonly<{ blocker: string; high: string; medium: string; low: string; nit: string }>;
        triageLabel: string;
        reviewerAsks: string;
        answer: string;
        askAboutThis: string;
        fixesSelected: (params: Count) => string;
        noFixesSelected: string;
        implementFixes: (params: Count) => string;
        couldNotSaveChoice: string;
        reviewers: string;
        findingTotal: (params: Count) => string;
        moreFindings: (params: Count) => string;
        fixesToImplement: (params: Count) => string;
        verifiedFirst: string;
        replies: (params: Count) => string;
        updatedAfterQuestion: string;
        reviewerUpdated: (params: Reviewer) => string;
        askPlaceholder: string;
        askReviewerPlaceholder: string;
        toReviewer: (params: Reviewer) => string;
        followUpsGoTo: (params: Reviewer) => string;
        waitingForAnswer: (params: Reviewer) => string;
        waitingForAnswers: string;
        both: string;
        reviewerCount: (params: Count) => string;
        askReviewersPlaceholder: string;
        followUpsGoToAll: (params: Count) => string;
        stillReviewing: string;
        reviewerDidNotFinish: string;
        reviewersNotStarted: (params: Count) => string;
        reviewerNotStarted: (params: Reviewer) => string;
        notSaved: string;
        decisionsUnavailable: string;
        followUpUnavailable: Readonly<{
            notResumable: string;
            ended: string;
            resumeUnavailable: string;
            busy: string;
            failed: string;
        }>;
    }>;
    launcher: Readonly<{
        titles: Readonly<{ review: string; plan: string; delegate: string }>;
        descriptions: Readonly<{
            review: (params: Machine) => string;
            plan: (params: Machine) => string;
            delegate: (params: Machine) => string;
        }>;
        whatFor: string;
        who: Readonly<{ review: string; plan: string; delegate: string }>;
        selectedCount: (params: Count) => string;
        focus: Readonly<{ review: string; plan: string; delegate: string }>;
        optional: string;
        start: Readonly<{
            review: (params: Count) => string;
            plan: string;
            delegate: string;
        }>;
        runsOn: (params: Machine) => string;
        checking: string;
        unavailableTitle: string;
        unavailableReason: string;
    }>;
}>;


export const runPageTranslationsEnglish = { en: {
        untitledRun: 'Agent run',
        intentTitles: { review: 'Review', plan: 'Plan', delegate: 'Delegated task' },
        thisMachine: 'this machine',
        menu: {
            cancelResponse: 'Cancel this response',
            copyResult: 'Copy result',
            showInTranscript: 'Show in transcript',
            runDetails: 'Run details',
            agent: 'Agent',
            permissions: 'Permissions',
            kind: 'Kind',
            finishesOnItsOwn: 'Finishes on its own',
            selectionInherited: 'Inherit session',
            selectionExplicit: 'Chosen for this run',
            selectionIndependent: 'Account default',
            selectionRetained: 'Kept from its start',
            selectionChoose: 'Choose for this run',
            selectionChooseDetail: 'Pick a model and where it runs through',
            staysOpen: 'Stays open',
            started: 'Started',
            run: 'Run',
            process: 'Process',
        },
        opening: { reading: ({ machine }) => `Reading it from ${machine}.` },
        gone: {
            title: ({ machine }) => `This run is no longer on ${machine}`,
            reason: 'It isn’t kept there any more, and the part of the transcript that’s loaded doesn’t include it.',
            closeTab: 'Close tab',
        },
        stopFailed: {
            title: {
                review: 'Couldn’t stop this review',
                plan: 'Couldn’t stop this plan',
                delegate: 'Couldn’t stop this task',
                run: 'Couldn’t stop this run',
            },
            reasonWithOthers: ({ machine, count }) => `${machine} didn’t confirm the stop. You can stop the whole session instead — that also stops the ${count} other ${count === 1 ? 'agent' : 'agents'} running in it.`,
            reasonAlone: ({ machine }) => `${machine} didn’t confirm the stop. You can stop the whole session instead.`,
            stopSession: 'Stop session…',
        },
        steps: {
            title: 'How it got there',
            count: ({ count }) => (count === 1 ? '1 step' : `${count} steps`),
        },
        review: {
            findings: 'Findings',
            findingsCount: ({ count }) => `${count}`,
            highCount: ({ count }) => `${count} high`,
            severity: { blocker: 'Blocker', high: 'High', medium: 'Medium', low: 'Low', nit: 'Nit' },
            triageLabel: 'What to do with this finding',
            reviewerAsks: 'The reviewer asks',
            answer: 'Answer',
            askAboutThis: 'Ask about this',
            fixesSelected: ({ count }) => (count === 1 ? '1 fix selected' : `${count} fixes selected`),
            noFixesSelected: 'Choose the fixes to implement',
            implementFixes: ({ count }) => (count === 1 ? 'Implement 1 fix' : count > 1 ? `Implement ${count} fixes` : 'Implement fixes'),
            couldNotSaveChoice: 'Couldn’t save your choice.',
            reviewers: 'Reviewers',
            findingTotal: ({ count }) => (count === 1 ? '1 finding' : `${count} findings`),
            moreFindings: ({ count }) => (count === 1 ? '1 more finding' : `${count} more findings`),
            fixesToImplement: ({ count }) => (count === 1 ? '1 fix to implement' : `${count} fixes to implement`),
            verifiedFirst: 'Each is verified first, then fixed',
            replies: ({ count }) => (count === 1 ? '1 reply' : `${count} replies`),
            updatedAfterQuestion: 'Updated after your question',
            reviewerUpdated: ({ reviewer }) => `${reviewer} updated the finding`,
            askPlaceholder: 'Ask a follow-up about this finding…',
            askReviewerPlaceholder: 'Ask the reviewer a follow-up…',
            toReviewer: ({ reviewer }) => `To ${reviewer}`,
            followUpsGoTo: ({ reviewer }) => `Follow-ups go to ${reviewer}`,
            waitingForAnswer: ({ reviewer }) => `Waiting for ${reviewer}…`,
            waitingForAnswers: 'Waiting for the reviewers…',
            both: 'Both',
            reviewerCount: ({ count }) => `${count} reviewers`,
            askReviewersPlaceholder: 'Ask the reviewers a follow-up…',
            followUpsGoToAll: ({ count }) => (count === 2 ? 'Follow-ups go to both reviewers' : `Follow-ups go to all ${count} reviewers`),
            stillReviewing: 'Still reviewing',
            reviewerDidNotFinish: 'Didn’t finish',
            reviewersNotStarted: ({ count }) => (count === 1 ? 'A reviewer didn’t start' : `${count} reviewers didn’t start`),
            reviewerNotStarted: ({ reviewer }) => `${reviewer} couldn’t start.`,
            notSaved: 'This finding wasn’t saved, so it can’t take a decision yet.',
            decisionsUnavailable: 'Couldn’t load your decisions.',
            followUpUnavailable: {
                notResumable: 'This review ended; follow-ups need a review that stays open.',
                ended: 'This review didn’t finish, so it can’t take follow-ups.',
                resumeUnavailable: 'The reviewer can’t be reached on this machine any more.',
                busy: 'The reviewer is still busy. Try again in a moment.',
                failed: 'Couldn’t send your question.',
            },
        },
        launcher: {
            titles: { review: 'Ask for a review', plan: 'Ask for a plan', delegate: 'Hand off a task' },
            descriptions: {
                review: ({ machine }) => `Each agent reviews the changes on ${machine} on its own; you get one result from each, here.`,
                plan: ({ machine }) => `The agent reads the code on ${machine} and proposes a plan here. It doesn’t change anything.`,
                delegate: ({ machine }) => `The agent works on ${machine} with the permissions below and reports back here.`,
            },
            whatFor: 'What for',
            who: { review: 'Who reviews', plan: 'Who plans', delegate: 'Who does it' },
            selectedCount: ({ count }) => `${count} selected`,
            focus: {
                review: 'What should they focus on?',
                plan: 'What should the plan cover?',
                delegate: 'What should it do?',
            },
            optional: 'optional',
            start: {
                review: ({ count }) => (count > 1 ? `Start ${count} reviews` : 'Start review'),
                plan: 'Start plan',
                delegate: 'Start task',
            },
            runsOn: ({ machine }) => `Runs on ${machine}`,
            checking: 'Checking which agents can run here',
            unavailableTitle: 'Agents can’t start in this session',
            unavailableReason: 'Its machine doesn’t offer reviews, plans or delegated tasks right now.',
        },
    } } as const satisfies Pick<Record<string, RunPageTranslations>, "en">;