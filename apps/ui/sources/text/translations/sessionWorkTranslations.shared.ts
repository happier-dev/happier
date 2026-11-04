

export const en = {
    scheduled: {
        title: "Scheduled",
        writesHere: "Writes here",
        empty: "No workflows are scheduled to write here.",
        step: ({ ordinal, title } : { ordinal: number; title: string }) => `step ${ordinal} · ${title}`,
        provenanceWorkflowStep: ({ source, step } : { source: string; step: string }) => `From ${source} · step ${step}`,
        notifyOnlyReported: "Only if the agent reported something",
        notifyOnlyReportedDescription: "Skip the notification when the agent returns no text.",
        notifyOnlyReportedNeedsResult: "Use the text result from an earlier Agent step as the message.",
    },
    workerUpdate: {
        state: {
            settled: "finished its turn",
            needsYou: "needs you",
            neededYou: "needed you",
            stalled: "stalled",
            published: "published",
            failed: "failed",
            stopped: "stopped",
            timedOut: "timed out",
            finished: "finished",
        },
        peek: "Peek",
        mute: 'Mute',
        muted: 'Muted here',
        unmute: 'Undo',
        muteFailed: 'Couldn’t mute it',
        truncated: "Result shortened.",
        wokenBy: ({ count }: { count: number }) => (count === 1 ? 'Woken by an update' : `Woken by ${count} updates`),
        updateCount: ({ count }: { count: number }) => (count === 1 ? '1 update' : `${count} updates`),
        notFromYou: 'not a message from you',
    },
    workerFollow: {
        manager: 'Your worker',
        follower: 'You follow it',
        rule: 'Your rule',
        queued: 'Queued',
        nextTurn: 'Next turn',
        woke: 'Woke it',
        answered: 'Answered',
        held: 'Held for you',
        offline: 'Machine offline',
        archived: 'Archived',
        locked: 'Machine locked',
        muted: 'Muted',
        unavailable: 'Couldn’t deliver',
        checkIn: 'Waits for your check-in',
        exchangeStopped: 'Exchange stopped',
    },
    title: 'Work',
    subtitle: {
        sessions: ({ count }: { count: number }) => (count === 1 ? '1 session' : `${count} sessions`),
        runs: ({ count }: { count: number }) => (count === 1 ? '1 run' : `${count} runs`),
        nothingStarted: 'Nothing started',
        archived: ({ count }: { count: number }) => `${count} archived`,
    },
    states: {
        recent: 'Recent',
        archived: 'Archived',
        stopped: 'Stopped',
    },
    view: {
        a11y: 'Work view',
        list: 'List',
        map: 'Map',
        expandMap: 'Open the map beside the session',
    },
    map: {
        folded: ({ names }: { names: string }) => `Finished work stays in List: ${names}`,
        backgroundRuns: ({ count }: { count: number }) => (count === 1 ? "1 background run" : `${count} background runs`),
        positionUnder: ({ position, total, parent }: { position: number; total: number; parent: string }) => `${position} of ${total} under ${parent}`,
        waitingOn: ({ count }: { count: number }) => `Waiting on ${count}`,
    },
    actions: {
        showInTranscript: 'Show in transcript',
        unarchive: 'Unarchive',
    },
    putUnder: {
        title: "Put under…",
        subtitle: "Report to another session",
        search: "Find a session",
        topLevel: "Top level — reports to no one",
        errors: {
            cycle: "That session already reports to this one",
            changed: "This session was just moved. Try again",
            forbidden: "You can’t put it under that session",
            failed: "Couldn’t move this session",
        },
    },
    kinds: {
        session: 'Session',
        workflowRun: 'Workflow run',
        backgroundRun: 'Background run',
    },
    showMore: ({ count }: { count: number }) => `Show ${count} more`,
    role: {
        none: 'None',
        handsOff: 'hands-off',
        a11y: ({ role }: { role: string }) => `Role: ${role}. Change role`,
    },
    empty: {
        title: 'No work started yet',
        reason: 'Sessions, workflows and background runs this session starts will appear here, with anything that needs you.',
    },
    row: {
        a11y: ({ title, status }: { title: string; status: string }) => `${title}, ${status}`,
    },
    progress: ({ completed, total }: { completed: number; total: number }) => `${completed} of ${total}`,
    strip: {
        openInSidebar: 'Open in sidebar',
        stillWorking: ({ count }: { count: number }) => `${count} still working`,
        needsYou: ({ count }: { count: number }) => count === 1 ? '1 needs you' : `${count} need you`,
        a11y: ({ summary }: { summary: string }) => `Work: ${summary}`,
    },
    leadArchived: ({ count }: { count: number }) => `This session is archived · ${count} still working`,
    managedBy: 'Managed by',
    plan: 'Plan',
    runsStale: 'Workflow runs may be out of date',
    list: {
        level: ({ level }: { level: number }) => `Level ${level}`,
        coordinator: 'Coordinator',
        subSessions: ({ count }: { count: number }) => (count === 1 ? '1 sub-session' : `${count} sub-sessions`),
        transcriptSessions: ({ count }: { count: number }) => `Sessions · ${count}`,
        showReports: ({ name, count }: { name: string; count: number }) => (count > 0 ? `Show ${count} sessions under ${name}` : `Show sessions under ${name}`),
        hideReports: ({ name }: { name: string }) => `Hide sessions under ${name}`,
        reportsWorking: ({ count }: { count: number }) => `${count} working`,
        reportsNeedYou: ({ count }: { count: number }) => (count === 1 ? '1 sub-session needs you' : `${count} sub-sessions need you`),
    },
    archive: {
        alsoArchiveReports: ({ count }: { count: number }) => (count === 1 ? 'Also archive 1 sub-session' : `Also archive ${count} sub-sessions`),
        someNotArchivedTitle: ({ count }: { count: number }) => (count === 1 ? '1 sub-session was not archived' : `${count} sub-sessions were not archived`),
    },
    step: {
        drivenBy: "Driven by a workflow",
        partOf: ({ run }: { run: string }) => `Part of ${run}`,
        checkedByWorkflow: "The workflow checks this step's result, so triggers, goals and second opinions don't run in this session.",
        nothingStarted: "Nothing started from this step.",
    },
    invite: {
        orAskFor: "Or ask for",
    },
    peek: {
        manager: ({ lead }: { lead: string }) => `Reports to ${lead}`,
        repliesGoHere: 'Replies go to this session',
    },
};


export const notifyEnglish = { en: { attention: 'Notify me when this needs me', armed: 'You’ll be notified', cancel: 'Cancel notification', failed: 'Couldn’t update the notification. Try again.', turnFinished: 'This session’s turn finished.', needsYou: 'This session needs you.', settings: 'Notification settings' } };


export const runNotifyEnglish = { en: { run: 'Notify me when this finishes', runFinished: 'This run finished.', runNeedsYou: 'This run needs you.', setup: 'Set up notifications', walkthroughUpdate: 'Your walkthrough has an update.', commitPlanUpdate: 'Your commit proposals have an update.' } };


export const sessionWorkTranslationsEnglish = { en: { ...en, notify: { ...notifyEnglish.en, ...runNotifyEnglish.en } } };
