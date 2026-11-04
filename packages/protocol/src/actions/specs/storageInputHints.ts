import type { ActionInputFieldHint } from '../actionInputHintsRuntime.js';
import type { MACHINE_STORAGE_ACTION_IDS } from './storageActionIdsV1.js';

type ActionId = typeof MACHINE_STORAGE_ACTION_IDS[number];
const scanId = { path: 'scanId', title: 'Scan id', widget: 'text', required: true } as const;
const path = { path: 'path', title: 'Folder path', widget: 'text', required: true } as const;
const entryIds = { path: 'entryIds', title: 'Trash entry ids', widget: 'json' } as const;
const batchId = { path: 'batchId', title: 'Trash batch id', widget: 'text' } as const;
const items = { path: 'items', title: 'Reviewed storage items', description: 'Use the complete {ref, expect} values returned by machines.storage.items.check.', widget: 'json', required: true } as const;
const volume = { path: 'volume', title: 'Volume', widget: 'text' } as const;

export const STORAGE_OPERATION_INPUT_FIELDS = {
  'machines.storage.summary.get': [],
  'machines.storage.category.list': [],
  'machines.storage.size.refresh': [],
  'machines.storage.pile.get': [],
  'machines.storage.pile.set': [
    { path: 'add', title: 'Add served item references', widget: 'json' },
    { path: 'remove', title: 'Remove item ids', widget: 'json' },
    { path: 'clear', title: 'Clear the pile', widget: 'boolean' },
    { path: 'acknowledgeDropped', title: 'Acknowledge dropped item ids', widget: 'json' },
  ],
  'machines.storage.items.check': [{ path: 'refs', title: 'Served storage references', description: 'Use the exact {itemId, path} values from this Machine’s storage inventory.', widget: 'json', required: true }],
  'machines.storage.trash.move': [
    { ...items, description: 'Use the complete {ref, expect, claimedVerdict} values from the current storage review.' },
    { path: 'notIncluded', title: 'Items not included', widget: 'json' },
    { path: 'goalBytes', title: 'Requested space in bytes', widget: 'integer' },
    { path: 'emptyAfter', title: 'Empty Trash after moving', widget: 'boolean' },
    { path: 'retry', title: 'Session task to retry', widget: 'json' },
  ],
  'machines.storage.deleteNow': [items],
  'machines.storage.trash.empty': [volume, entryIds, batchId],
  'machines.storage.trash.restore': [
    { ...entryIds, description: 'Choose exact entry ids or a batch id.' }, batchId,
    { path: 'beside', title: 'Restore beside an existing item', widget: 'boolean' },
  ],
  'machines.storage.worktrees.list': [
    { path: 'projectId', title: 'Project id', widget: 'text' },
    { path: 'filter', title: 'Storage verdict', widget: 'text' },
  ],
  'machines.storage.suggestions.list': [
    { path: 'group', title: 'Suggestion group', widget: 'select', options: [
      { value: 'can-be-rebuilt', label: 'Can be rebuilt' }, { value: 'old-and-unused', label: 'Old and unused' },
      { value: 'outside-happier', label: 'Outside Happier' },
    ] },
    { path: 'quickestForVolume', title: 'Quickest cleanup for volume', widget: 'text' },
  ],
  'machines.storage.suggestions.decline': [items],
  'machines.storage.scan.start': [
    { path: 'target', title: 'Scan target', description: 'Choose {volumeId} or {folderPath} from the selected Machine.', widget: 'json', required: true },
    { path: 'resume', title: 'Resume a previous scan', widget: 'boolean' },
  ],
  'machines.storage.scan.get': [{ ...scanId, required: false }, { path: 'view', title: 'Scan view', widget: 'json' }],
  'machines.storage.scan.cancel': [scanId],
  'machines.storage.scan.skip': [scanId, path],
  'machines.storage.protected.add': [path],
  'machines.storage.protected.remove': [path],
  'machines.storage.docker.prune': [
    { path: 'expectedEngineId', title: 'Reviewed Docker engine', widget: 'text' },
    { path: 'selection', title: 'Reviewed image selection or safe unused selection', widget: 'json', required: true },
  ],
} satisfies Record<ActionId, ActionInputFieldHint[]>;
