type N = Readonly<{ n: number }>;
type Line = Readonly<{ line: number }>;
type Range = Readonly<{ start: number; end: number }>;
type Position = Readonly<{ current: number; total: number }>;
type RowA11y = Readonly<{ n: number; total: number; range: string }>;
type Count = Readonly<{ count: number }>;
type Name = Readonly<{ name: string }>;
type Machine = Readonly<{ machine: string }>;
type Agent = Readonly<{ agent: string }>;
type Turn = Readonly<{ turn: number }>;

/** Inline review on a diff: change rows, the review strip, the phone bar and image compare. */
export type Labels = Readonly<{
  change: (params: N) => string;
  line: (params: Line) => string;
  lines: (params: Range) => string;
  kept: string;
  keep: string;
  keepUnavailable: string;
  discard: string;
  keepA11y: (params: RowA11y) => string;
  unkeepA11y: (params: RowA11y) => string;
  discardA11y: (params: RowA11y) => string;
  counter: (params: Position) => string;
  changes: (params: Readonly<{ total: number }>) => string;
  previousChange: string;
  nextChange: string;
  keepAll: string;
  fileReviewed: string;
  filesLeft: (params: Count) => string;
  viewed: string;
  viewedChanged: string;
  viewedNotSaved: string;
  viewedA11y: (params: Name) => string;
  viewedCount: (params: Readonly<{ count: number; total: number }>) => string;
  viewedUnavailable: string;
  nextFile: string;
  nextNamed: (params: Name) => string;
  scopeA11y: string;
  scopeTurn: string;
  scopeSession: string;
  scopeUncommitted: string;
  noTurnChanges: string;
  noChanges: string;
  showSession: string;
  discardNeeds: (params: Machine) => string;
  agentWriting: (params: Agent) => string;
  turn: (params: Turn) => string;
  comment: string;
  askAbout: string;
  copy: string;
  noticeDiscarded: string;
  noticeDiscardedAt: (params: Readonly<{ range: string }>) => string;
  noticeRestored: (params: Name) => string;
  noticeKeptEdited: string;
  noticeUndone: string;
  noticeUndoConflict: string;
  noticeUndoUnavailable: string;
  noticeNoteFailed: (params: Agent) => string;
  noticeMovedOn: string;
  noticeUpdateRequired: (params: Machine) => string;
  noticeUnsupported: string;
  discardStaged: string;
  discardRenamedOrCopied: string;
  discardUntracked: string;
  noticeUnavailable: string;
  noticeUnknown: string;
  undo: string;
  replaceUnsavedTitle: string;
  replaceUnsavedMessage: string;
  replace: string;
  imageSideBySide: string;
  imageSwipe: string;
  imageOnion: string;
  imageModeA11y: string;
  imageBefore: string;
  imageAfter: string;
  pdfOpenBefore: string;
  pdfOpenAfter: string;
  imageAdded: string;
  imageDeleted: string;
  imageUnreadable: string;
  imageNoPreview: string;
  imageTooLarge: string;
  imageUnsupported: string;
  imageMissing: string;
  imageLoading: string;
  imageBlend: string;
  unchangedLines: (params: Readonly<{ count: number }>) => string;
  agentFallback: string;
}>;

export const hunkReviewTranslations = {
  en: {
    change: ({ n }) => `Change ${n}`,
    line: ({ line }) => `line ${line}`,
    lines: ({ start, end }) => `lines ${start}–${end}`,
    kept: 'Kept',
    keep: 'Keep',
    keepUnavailable: 'Keep is unavailable. Reopen this review to try again.',
    discard: 'Discard',
    keepA11y: ({ n, total, range }) => `Keep change ${n} of ${total}, ${range}`,
    unkeepA11y: ({ n, total, range }) =>
      `Mark change ${n} of ${total}, ${range}, as not reviewed`,
    discardA11y: ({ n, total, range }) =>
      `Discard change ${n} of ${total}, ${range}`,
    counter: ({ current, total }) => `${current} of ${total}`,
    changes: ({ total }) => String((total === 1 ? 'change' : 'changes')),
    previousChange: 'Previous change',
    nextChange: 'Next change',
    keepAll: 'Keep all',
    fileReviewed: 'All changes in this file reviewed',
    filesLeft: ({ count }) => (count === 1 ? '1 file left' : `${count} files left`),
    viewed: 'Viewed',
    viewedChanged: 'Changed since viewed',
    viewedNotSaved: 'Not saved to GitHub',
    viewedA11y: ({ name }) => `${name}, viewed on GitHub`,
    viewedCount: ({ count, total }) => `${count} of ${total} viewed`,
    viewedUnavailable: 'Viewed unavailable',
    nextFile: 'Next file',
    nextNamed: ({ name }) => `Next · ${name}`,
    scopeA11y: 'Changes to show',
    scopeTurn: 'This turn',
    scopeSession: 'This session',
    scopeUncommitted: 'Uncommitted',
    noTurnChanges: 'No changes from this turn in this file.',
    noChanges: 'No changes in this file.',
    showSession: 'Show this session',
    discardNeeds: ({ machine }) => `Discard needs ${machine}`,
    agentWriting: ({ agent }) => `${agent} is writing this file`,
    turn: ({ turn }) => `turn ${turn}`,
    comment: 'Comment',
    askAbout: 'Ask about this change',
    copy: 'Copy',
    noticeDiscarded: 'Discarded the change',
    noticeDiscardedAt: ({ range }) => `Discarded the change at ${range}`,
    noticeRestored: ({ name }) => `Restored ${name}`,
    noticeKeptEdited: 'Kept: edited since',
    noticeUndone: 'Undone',
    noticeUndoConflict: 'The file changed since. Cannot undo.',
    noticeUndoUnavailable: 'Done. Undo is not available for this one.',
    noticeNoteFailed: ({ agent }) => `Done, but ${agent} could not be told`,
    noticeMovedOn: 'The file changed. Review it again.',
    noticeUpdateRequired: ({ machine }) =>
      `Update ${machine} to discard or restore changes`,
    noticeUnsupported: 'This change cannot be discarded here.',
    discardStaged: 'Unstage these changes first.',
    discardRenamedOrCopied: 'Individual changes cannot be discarded in renamed or copied files.',
    discardUntracked: 'Individual changes cannot be discarded in untracked files.',
    noticeUnavailable: 'These changes are no longer available.',
    noticeUnknown: 'Could not confirm. Refresh.',
    undo: 'Undo',
    replaceUnsavedTitle: 'Replace your unsaved edits?',
    replaceUnsavedMessage:
      'Restoring the file replaces the edits you have not saved.',
    replace: 'Replace',
    imageSideBySide: 'Side by side',
    imageSwipe: 'Swipe',
    imageOnion: 'Onion',
    imageModeA11y: 'Compare images',
    imageBefore: 'Before',
    imageAfter: 'After',
    pdfOpenBefore: 'Open before',
    pdfOpenAfter: 'Open after',
    imageAdded: 'Added',
    imageDeleted: 'Deleted',
    imageUnreadable: 'This image could not be read',
    imageNoPreview: 'No preview',
    imageTooLarge: "Too large to preview",
    imageUnsupported: "Can't preview this format",
    imageMissing: "File not found",
    imageLoading: 'Loading image',
    imageBlend: 'Blend',
    unchangedLines: ({ count }) => (count === 1 ? '1 unchanged line' : `${count} unchanged lines`),
    agentFallback: 'the agent',
  },
} as const satisfies Pick<Record<string, Labels>, 'en'>;
