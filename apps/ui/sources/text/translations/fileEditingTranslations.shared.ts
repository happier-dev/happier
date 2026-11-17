import { fileAiSuggestionsTranslations, fileAiSuggestionControls, fileNextEditTranslations } from './fileAiSuggestionsTranslations.shared';
// The file editor's states, conflict and compare choices, offline lines and phone keys (P4 U2/U3/U5/U6).
type Agent = { agent: string };
type Machine = { machine: string };
type Count = { count: number };

const en = {
  aiSuggestions: { ...fileAiSuggestionsTranslations.en, ...fileAiSuggestionControls.en, ...fileNextEditTranslations.en },
  statusEditing: 'Editing',
  statusUnsaved: 'Unsaved',
  statusSaving: 'Saving',
  statusSaved: 'Saved',
  discardEdits: 'Discard edits',
  conflictByAgent: ({ agent }: Agent) => `${agent} changed this file.`,
  conflictOnDisk: 'This file changed on disk.',
  editsKept: 'Your edits are kept.',
  useMine: 'Use mine',
  useAgents: ({ agent }: Agent) => `Use ${agent}’s`,
  useTheirs: 'Use theirs',
  offline: ({ machine }: Machine) =>
    `${machine} isn’t answering. Your edits are kept on this device; save when it’s back.`,
  offlineSaving: ({ machine }: Machine) =>
    `${machine} isn’t answering. Your edits are kept on this device and save when it’s back.`,
  backOnline: ({ machine }: Machine) =>
    `${machine} is back. Your edits are ready to save.`,
  awaitingApproval: 'Waiting for approval to save. Your edits are kept.',
  saveFailed: 'Couldn’t save. Your edits are kept.',
  draftNotStored: 'Your edits aren’t stored on this device. Save to keep them.',
  lineEndings: ({ ending }: { ending: string }) =>
    `Line endings will be saved as ${ending}.`,
  editsSetAside: 'Your edits were set aside',
  agentVersionReplaced: ({ agent }: Agent) => `${agent}’s version was replaced`,
  diskVersionReplaced: 'The version on disk was replaced',
  dismissNotice: 'Dismiss',
  placesDiffer: ({ count }: Count) =>
    count === 1 ? '1 place differs.' : `${count} places differ.`,
  useAllMine: 'Use all mine',
  useAllAgents: ({ agent }: Agent) => `Use all ${agent}’s`,
  useAllTheirs: 'Use all theirs',
  backToEditing: 'Back to editing',
  placeLine: ({ line }: { line: number }) => `Line ${line}`,
  placeLines: ({ start, end }: { start: number; end: number }) => `Lines ${start}–${end}`,
  onlyAgentChanged: ({ agent }: Agent) => `only ${agent} changed it`,
  onlyDiskChanged: 'only the version on disk changed it',
  yoursVsAgents: ({ agent }: Agent) => `yours vs ${agent}’s`,
  yoursVsDisk: 'yours vs the version on disk',
  usingAgents: ({ agent }: Agent) => `Using ${agent}’s`,
  usingTheirs: 'Using theirs',
  usingMine: 'Using mine',
  replacedLines: ({ count }: Count) =>
    count === 1 ? 'Replaced 1 line' : `Replaced ${count} lines`,
  addedLines: ({ count }: Count) =>
    count === 1 ? 'Added 1 line' : `Added ${count} lines`,
  removedLines: ({ count }: Count) =>
    count === 1 ? 'Removed 1 line' : `Removed ${count} lines`,
  youEditedThisChange: 'You edited this change',
  nextChange: 'Next change',
  previousChange: 'Previous change',
  changes: 'Changes',
  hideKeyboard: 'Hide keyboard',
  indent: 'Indent',
  outdent: 'Outdent',
  moveLeft: 'Move left',
  moveRight: 'Move right',
  insertText: ({ text }: { text: string }) => `Insert ${text}`,
  editorKeys: 'Editor keys',
  redo: 'Redo',
};

export type FileEditingTranslations = typeof en;

export const fileEditingTranslations: Pick<Record<
  | 'en'
  | 'ca'
  | 'de'
  | 'es'
  | 'fr'
  | 'it'
  | 'ja'
  | 'pl'
  | 'pt'
  | 'ru'
  | 'zh-Hans'
  | 'zh-Hant',
  FileEditingTranslations
>, 'en'> = {
  en,
};
