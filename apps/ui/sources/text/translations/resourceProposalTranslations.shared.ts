/** The agent's resource proposal card (plan 60 AGW-6/7/8, lab `ra` A2–A4, A7). */
const en = {
  title: {
    storage: 'Cleanup proposal',
    processes: 'Free memory',
    retry: 'Make room and retry',
  },
  machineChecked: ({ machine, time }: { machine: string; time: string }) =>
    `${machine} · checked ${time}`,
  machineChecking: ({ machine }: { machine: string }) =>
    `${machine} · checking…`,
  selected: ({ count, total }: { count: number; total: number }) =>
    `${count} of ${total} selected`,
  selectAll: 'Select all',
  selectAllSafe: 'Select all safe',
  givesBack: 'Gives back',
  frees: 'Frees',
  onDisk: ({ amount }: { amount: string }) => `of ${amount} on disk`,
  changed: 'changed',
  gone: 'gone',
  notIncluded: 'Not part of this proposal',
  includeAnyway: 'Include it',
  goal: ({ found, goal }: { found: string; goal: string }) =>
    `${found} of ${goal} found`,
  staleTitle: ({ count }: { count: number }) =>
    count === 1
      ? 'One thing changed since the agent looked.'
      : `${count} things changed since the agent looked.`,
  staleBody: 'Nothing can be approved until it is checked again.',
  checkAgain: 'Check again',
  checkUnavailable:
    'Couldn’t check these right now. Each item is checked again when it runs.',
  note: {
    trash:
      'Each item is checked again, then moved. The space comes back when the Trash empties.',
    processes: 'Nothing is deleted. Each one is checked again first.',
    emptyAfter:
      'The space is needed now, so the Trash is emptied straight away. That part can’t be undone.',
  },
  approve: {
    trash: ({ count }: { count: number }) => `Move ${count} to Trash`,
    emptyAndRetry: 'Trash, empty and retry',
    keepUndo: 'Move to Trash and retry',
    keepUndoHint: 'Keeps Undo; frees space only when the Trash empties.',
    stop: ({ count }: { count: number }) => `Stop ${count}`,
  },
  notNow: 'Not now',
  declinedTitle: 'Proposal declined',
  declinedFacts: ({ count }: { count: number }) =>
    `${count} items · nothing was changed`,
  reopen: 'Reopen',
  tryAgain: 'Try again',
  startAgain: 'Start again',
  startedAgain: 'Started again',
  keptByGuard: 'Kept, because they are working',
  memoryLabel: 'Memory',
  memoryAfter: ({ now, after }: { now: string; after: string }) => `${now} now · about ${after} after`,
  memoryNow: ({ now }: { now: string }) => `${now} in use`,
  processesTree: 'What is using memory',
  analysingFound: ({ count }: { count: number }) => `${count} found so far`,
  analysingNote: 'Still reading. You can approve when it has finished.',
  inbox: {
    allSafe: ({ count }: { count: number }) => `${count} items, all safe`,
    mixed: ({ count, safe, attention }: { count: number; safe: number; attention: number }) => `${count} items · ${safe} safe, ${attention} need your eye`,
    stops: ({ count }: { count: number }) => `Stop ${count}`,
  },
  restored: 'Put back · nothing was removed',
  receiptChecking: 'Checking Trash and recent Activity…',
  receiptUnavailable: 'Couldn’t check the current outcome. Open this proposal again to retry.',
  receiptUnknown: ({ count }: { count: number }) => `Final outcome unavailable for ${count} items.`,
  receiptRestored: ({ count }: { count: number }) => `${count} items put back`,
  receiptFreed: ({ count, amount }: { count: number; amount: string }) => `${amount} freed · ${count} items deleted`,
  skipped: ({ reason }: { reason: string }) => `Not moved: ${reason}`,
  stopped: ({ count }: { count: number }) => `Stopped ${count}`,
  stoppedFreed: ({ amount }: { amount: string }) => `${amount} freed`,
  notStopped: ({ reason }: { reason: string }) => `Not stopped: ${reason}`,
  failed: 'This proposal couldn’t finish. Nothing else was changed.',
  processSafe: 'Safe · start again any time',
  processStopLoss: ({ title }: { title: string }) => `Stopping “${title}” interrupts its current work or pending question.`,
  processKillLoss: ({ title }: { title: string }) => `Killing “${title}” ends its work immediately; unsaved work is lost.`,
  processCheck: 'Check first',
  itemLabel: ({
    title,
    size,
    verdict,
  }: {
    title: string;
    size: string;
    verdict: string;
  }) => `${title}, ${size}, ${verdict}`,
  owner: {
    session: 'Session',
    terminal: 'Terminal',
    service: 'Dev server',
    run: 'Run',
    browser_sidecar: 'Browser sidecar',
    workspace_sync: 'Workspace sync',
    other: 'Process',
  },
} as const;

export type ResourceProposalTranslations = typeof en;

export const resourceProposalTranslations = {
  en,
} as const;
