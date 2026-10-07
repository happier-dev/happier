

export const en = {
    workerUpdate: {
        settled: "Settled",
        stalled: "Stalled",
        published: "Published",
        truncated: "Result shortened.",
        wokenBy: ({ count }: { count: number }) => (count === 1 ? 'Woken by an update' : `Woken by ${count} updates`),
        notFromYou: 'not a message from you',
    },
    title: 'Work',
    subtitle: {
        sessions: ({ count }: { count: number }) => (count === 1 ? '1 session' : `${count} sessions`),
        runs: ({ count }: { count: number }) => (count === 1 ? '1 run' : `${count} runs`),
        nothingStarted: 'Nothing started',
    },
    states: {
        recent: 'Recent',
    },
    view: {
        a11y: 'Work view',
        list: 'List',
        map: 'Map',
        expandMap: 'Open the map beside the session',
    },
    map: {
        positionUnder: ({ position, total, parent }: { position: number; total: number; parent: string }) => `${position} of ${total} under ${parent}`,
    },
    actions: {
        makeOrchestrator: 'Make this an orchestrator',
        makeOrchestratorSubtitle: 'This session plans, delegates and reports back',
        makeOrchestratorFailed: "Couldn't make this session an orchestrator",
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
        needsYou: ({ count }: { count: number }) => `${count} needs you`,
        a11y: ({ summary }: { summary: string }) => `Work: ${summary}`,
    },
    leadArchived: ({ count }: { count: number }) => `This session is archived · ${count} still working`,
    runsStale: 'Workflow runs may be out of date',
    list: {
        level: ({ level }: { level: number }) => `Level ${level}`,
        subSessions: ({ count }: { count: number }) => (count === 1 ? '1 sub-session' : `${count} sub-sessions`),
        reportsWorking: ({ count }: { count: number }) => `${count} working`,
        reportsNeedYou: ({ count }: { count: number }) => (count === 1 ? '1 sub-session needs you' : `${count} sub-sessions need you`),
    },
    archive: {
        alsoArchiveReports: ({ count }: { count: number }) => (count === 1 ? 'Also archive 1 sub-session' : `Also archive ${count} sub-sessions`),
        someNotArchivedTitle: ({ count }: { count: number }) => (count === 1 ? '1 sub-session was not archived' : `${count} sub-sessions were not archived`),
    },
    peek: {
        reportsTo: ({ lead }: { lead: string }) => `Reports to ${lead}`,
        repliesGoHere: 'Replies go to this session',
    },
};


export const notifyEnglish = { en: { turn: 'Notify me when this turn finishes', attention: 'Notify me when this needs me', armed: 'You’ll be notified', cancel: 'Cancel notification', failed: 'Couldn’t update the notification. Try again.', turnFinished: 'This session’s turn finished.', needsYou: 'This session needs you.', settings: 'Notification settings' } };


export const runNotifyEnglish = { en: { run: 'Notify me when this finishes', runFinished: 'This run finished.', runNeedsYou: 'This run needs you.', setup: 'Set up notifications' } };


export const sessionWorkTranslationsEnglish = { en: { ...en, notify: { ...notifyEnglish.en, ...runNotifyEnglish.en } } };