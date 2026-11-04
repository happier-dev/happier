import { STORAGE_OPERATION_INPUT_FIELDS } from './storageInputHints.js';
import { MACHINE_STORAGE_ACTION_IDS } from './storageActionIdsV1.js';
export { MACHINE_STORAGE_ACTION_IDS } from './storageActionIdsV1.js';
import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import {
  HappierStorageSummaryV1Schema, MachineStorageCategoryListInputV1Schema, MachineStorageCategoryListResultV1Schema,
  MachineStorageSizeRefreshInputV1Schema, MachineStorageSummaryGetInputV1Schema,
  MachineStoragePileGetInputV1Schema, MachineStoragePileSetInputV1Schema, MachineStoragePileResultV1Schema,
  MachineStorageItemsCheckInputV1Schema, PileReviewV1Schema, MachineStorageTrashMoveInputV1Schema,
  MachineStorageDeleteNowInputV1Schema, PileApplyResultV1Schema, MachineStorageTrashEmptyInputV1Schema,
  MachineStorageTrashRestoreInputV1Schema, TrashEmptyResultV1Schema, TrashRestoreResultV1Schema,
  MachineStorageWorktreesListInputV1Schema, MachineStorageSuggestionsListInputV1Schema,
  MachineStorageItemsListResultV1Schema, MachineStorageSuggestionsDeclineInputV1Schema, MachineStorageSuggestionsDeclineResultV1Schema,
  DiskScanStateV1Schema, MachineStorageScanStartInputV1Schema, MachineStorageScanGetInputV1Schema, MachineStorageScanGetResultV1Schema,
  MachineStorageScanCancelInputV1Schema, MachineStorageScanSkipInputV1Schema, MachineStorageProtectedAddInputV1Schema, MachineStorageProtectedRemoveInputV1Schema,
  MachineStorageDockerPruneInputV1Schema, MachineStorageDockerPruneResultV1Schema,
} from '../../storage/storageV1.js';
import { MachineResourcesPolicyMutationResultV1Schema } from '../../machines/resources/machineResourcesPolicyV1.js';
import { subsetNarrowing } from '../../approvals/approvalNarrowing.js';
import { RPC_METHODS } from '../../rpc/methods.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';
export type MachineStorageActionId = typeof MACHINE_STORAGE_ACTION_IDS[number];
export const MachineStorageActionIdSchema = lazyZodSchema(() => z.enum(MACHINE_STORAGE_ACTION_IDS));
export const MACHINE_STORAGE_ACTION_INPUT_SCHEMAS = {
  'machines.storage.summary.get': MachineStorageSummaryGetInputV1Schema,
  'machines.storage.category.list': MachineStorageCategoryListInputV1Schema,
  'machines.storage.size.refresh': MachineStorageSizeRefreshInputV1Schema,
  'machines.storage.pile.get': MachineStoragePileGetInputV1Schema,
  'machines.storage.pile.set': MachineStoragePileSetInputV1Schema,
  'machines.storage.items.check': MachineStorageItemsCheckInputV1Schema,
  'machines.storage.trash.move': MachineStorageTrashMoveInputV1Schema,
  'machines.storage.deleteNow': MachineStorageDeleteNowInputV1Schema,
  'machines.storage.trash.empty': MachineStorageTrashEmptyInputV1Schema,
  'machines.storage.trash.restore': MachineStorageTrashRestoreInputV1Schema,
  'machines.storage.worktrees.list': MachineStorageWorktreesListInputV1Schema,
  'machines.storage.suggestions.list': MachineStorageSuggestionsListInputV1Schema,
  'machines.storage.suggestions.decline': MachineStorageSuggestionsDeclineInputV1Schema,
  'machines.storage.scan.start': MachineStorageScanStartInputV1Schema,
  'machines.storage.scan.get': MachineStorageScanGetInputV1Schema,
  'machines.storage.scan.cancel': MachineStorageScanCancelInputV1Schema,
  'machines.storage.scan.skip': MachineStorageScanSkipInputV1Schema,
  'machines.storage.protected.add': MachineStorageProtectedAddInputV1Schema,
  'machines.storage.protected.remove': MachineStorageProtectedRemoveInputV1Schema,
  'machines.storage.docker.prune': MachineStorageDockerPruneInputV1Schema,
} as const;
export type MachineStorageActionInput = z.infer<(typeof MACHINE_STORAGE_ACTION_INPUT_SCHEMAS)[MachineStorageActionId]>;
export const MACHINE_STORAGE_ACTION_OUTPUT_SCHEMAS = {
  'machines.storage.summary.get': HappierStorageSummaryV1Schema,
  'machines.storage.category.list': MachineStorageCategoryListResultV1Schema,
  'machines.storage.size.refresh': HappierStorageSummaryV1Schema,
  'machines.storage.pile.get': MachineStoragePileResultV1Schema,
  'machines.storage.pile.set': MachineStoragePileResultV1Schema,
  'machines.storage.items.check': PileReviewV1Schema,
  'machines.storage.trash.move': PileApplyResultV1Schema,
  'machines.storage.deleteNow': PileApplyResultV1Schema,
  'machines.storage.trash.empty': TrashEmptyResultV1Schema,
  'machines.storage.trash.restore': TrashRestoreResultV1Schema,
  'machines.storage.worktrees.list': MachineStorageItemsListResultV1Schema,
  'machines.storage.suggestions.list': MachineStorageItemsListResultV1Schema,
  'machines.storage.suggestions.decline': MachineStorageSuggestionsDeclineResultV1Schema,
  'machines.storage.scan.start': DiskScanStateV1Schema,
  'machines.storage.scan.get': MachineStorageScanGetResultV1Schema,
  'machines.storage.scan.cancel': DiskScanStateV1Schema,
  'machines.storage.scan.skip': DiskScanStateV1Schema,
  'machines.storage.protected.add': MachineResourcesPolicyMutationResultV1Schema,
  'machines.storage.protected.remove': MachineResourcesPolicyMutationResultV1Schema,
  'machines.storage.docker.prune': MachineStorageDockerPruneResultV1Schema,
} as const;
const surfaces = { ui: true, cli: true, agent: true, mcp: true, voice: true, rpc: false } as const;
const fields = [
  { path: 'serverId', title: 'Home ID', widget: 'text', required: false },
  { path: 'machineId', title: 'Machine ID', widget: 'text', required: true },
] as const;
const base = { safety: 'safe', sideEffectClass: 'read', placements: [], executionPlacement: 'machine', surfaces,
  contextualDefaults: { machineId: 'current_session_machine' } } as const;
const storageReferenceGuidance = 'Use the exact machineId and serverId of the requested Machine page or current Session; reuse that target for every read and proposal. If its storage methods are unavailable, report that limitation instead of trying other Machines. Obtain refs from that Machine’s served category, suggestions or scan view: for a StorageItem reuse { itemId, path }; for a DiskNode use { itemId: node.nodeId, path: node.nodeId } verbatim, including bytes: ids. Never invent itemIds from names or labels. items.check accepts those served refs directly without adding them to the person’s pile. Use the returned ref and expect unchanged in the proposal; use pile.set only when asked to collect into the person’s pile.';
const exampleServedRef = { itemId: '{{itemId}}', path: '/tmp/cache' } as const;
const exampleRef = {
  itemId: '{{itemId}}', path: '/tmp/cache', identity: { dev: '1', ino: '2', kind: 'directory' },
  collectedAt: 0, collectedBy: { accountId: '{{accountId}}', kind: 'person' },
} as const;
const storageRefKey = (ref: unknown) =>
  ref && typeof ref === 'object' && 'itemId' in ref && typeof ref.itemId === 'string' ? ref.itemId : '';
const reviewedItemsNarrowing = subsetNarrowing({ path: 'items', key: item => {
  const ref = item.ref;
  return storageRefKey(ref);
}, refreshable: ['expect'] });
type MachineStorageActionSpec<Id extends MachineStorageActionId> =
  Omit<PreNormalizedActionSpec, 'id' | 'inputSchema' | 'outputSchema'> & {
    id: Id;
    inputSchema: (typeof MACHINE_STORAGE_ACTION_INPUT_SCHEMAS)[Id];
    outputSchema: (typeof MACHINE_STORAGE_ACTION_OUTPUT_SCHEMAS)[Id];
  };

function cleanupSpec<const Id extends MachineStorageActionId>([id, title, description, rpcMethod, sideEffectClass, safety, voiceArgs]:
  readonly [Id, string, string, string, 'read' | 'write' | 'danger', 'safe' | 'danger', z.input<(typeof MACHINE_STORAGE_ACTION_INPUT_SCHEMAS)[Id]>?]): MachineStorageActionSpec<Id> {
  return {
    ...base, id, approval: { result: 'required' }, title, description, safety, sideEffectClass,
    ...(id === 'machines.storage.docker.prune' ? { operation: {
      version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' },
    } as const } : {}),
    ...(id === 'machines.storage.deleteNow' || id === 'machines.storage.trash.empty' || id === 'machines.storage.docker.prune'
      ? { confirmVerb: { key: 'common.delete', fallback: 'Delete' }, irreversible: true as const } : {}),
    ...(id === 'machines.storage.trash.move' ? { approvalPolicy: {
      uiConfirmation: 'direct' as const,
      uiConfirmationForInput: (input: unknown) => {
        const parsed = MachineStorageTrashMoveInputV1Schema.safeParse(input);
        return !parsed.success || parsed.data.emptyAfter === true;
      },
    } } : {}),
    ...(id === 'machines.storage.protected.remove' ? { approvalPolicy: { agentDefault: 'authority' as const, requiredSurfaces: ['mcp', 'plugin'] as const } } : {}),
    toolExposure: { agent: id === 'machines.storage.suggestions.list' ? 'direct' as const : 'discoverable_only' as const },
    prompting: { agentGuidance: id === 'machines.storage.docker.prune'
      ? 'Use this Machine’s exact target and one explicit reviewed image set or the safe unused selection. Never infer custody from a native id, tagless status or Docker’s dangling label. The receiving Storage owner proves expired deployment receipt aliases and retained/running protection. Volumes, bind data, foreign images and unproven build cache are kept. This Action’s own user setting decides approval; never substitute shell prune commands.'
      : `${storageReferenceGuidance} ${sideEffectClass === 'read'
      ? 'Read current storage facts before proposing cleanup. Suggestions omit Keep and Forbidden items and respect declined items. Use machines.storage.scan.get with the find view for requests such as finding 2 GB .mov files; Large and Old are views of the same scan, and since facts describe growth only when reported.'
      : sideEffectClass === 'danger'
        ? 'Read machines.storage.summary.get and machines.storage.suggestions.list first, then check the complete item set through machines.storage.items.check. Propose once through the set Action with reasons and what is lost; never repeat single-item cleanup effects in a loop. The approval UI lets the person select a subset: Safe begins selected, Caution and Keep begin unselected, Keep explains what is lost, and Forbidden goes in notIncluded without a selectable item. claimedVerdict describes the reviewed facts, never a second approval decision; this Action’s own user setting decides approval. Prefer machines.storage.trash.move; use machines.storage.deleteNow only when explicitly asked to delete permanently. For example, “find 20 GB to free” becomes one Trash-move proposal with goalBytes. If a build fails with ENOSPC, propose only this session’s own build outputs and Happier-managed caches, with retry describing the failed task; outside-Happier caches require the whole-disk opt-in. Request emptyAfter only to present the explicit permanent choice “Move to Trash, empty it and retry”; the UI may reduce it to “Move to Trash and retry”, which keeps Undo and frees space only when Trash empties on the same volume. Do not claim disk space is freed while items remain in Trash. If nothing is worth doing, say so without an effect call.'
        : 'Read current storage facts first, then make the requested change once through this Action. Preserve the person’s cleanup pile; proposals carry their own item set. Restore from Trash through its recorded entries, record declined suggestions through suggestions.decline, and edit protected folders through the resources policy owner. Approval follows this Action’s own user setting.'}` },
    surfaces: { ...surfaces, voice: id !== 'machines.storage.deleteNow' && id !== 'machines.storage.trash.empty', rpc: true },
    bindings: { rpcMethod, mcpToolName: id.replaceAll('.', '_') },
    inputSchema: MACHINE_STORAGE_ACTION_INPUT_SCHEMAS[id], outputSchema: MACHINE_STORAGE_ACTION_OUTPUT_SCHEMAS[id],
    cli: { acceptsServerId: true as const, commands: [{ path: id === 'machines.storage.deleteNow' ? ['machines', 'storage', 'delete-now'] : id.split('.'), visibility: 'canonical' as const }] },
    inputHints: { fields: [...fields, ...STORAGE_OPERATION_INPUT_FIELDS[id]] },
    ...(voiceArgs ? { examples: { voice: { argsExample: JSON.stringify(voiceArgs) } } } : {}),
    ...(id === 'machines.storage.trash.move' ? { approvalNarrowing: subsetNarrowing({ path: 'items',
      key: item => storageRefKey(item.ref),
      refreshable: ['expect'], reducible: ['emptyAfter'] }) } :
      id === 'machines.storage.items.check' ? { approvalNarrowing: subsetNarrowing({ path: 'refs', key: storageRefKey }) } :
      id === 'machines.storage.deleteNow' || id === 'machines.storage.suggestions.decline' ? { approvalNarrowing: reviewedItemsNarrowing } :
      id === 'machines.storage.trash.empty' || id === 'machines.storage.trash.restore' ? { approvalNarrowing: subsetNarrowing({ path: 'entryIds', key: () => '' }) } : {}),
  };
}
const cleanupSpecs = [
  cleanupSpec(['machines.storage.pile.get', 'Read the cleanup pile', 'The items you collected for review on this machine.', RPC_METHODS.DAEMON_STORAGE_PILE_GET, 'read', 'safe', { machineId: '{{machineId}}' }]),
  cleanupSpec(['machines.storage.pile.set', 'Collect storage items', 'Adds items to your review pile on this machine, or takes them out.', RPC_METHODS.DAEMON_STORAGE_PILE_SET, 'write', 'safe', { machineId: '{{machineId}}', add: [exampleServedRef] }]),
  cleanupSpec(['machines.storage.items.check', 'Review storage items', 'Checks each served storage item again: what it is, where it lives and what removing it would lose.', RPC_METHODS.DAEMON_STORAGE_ITEMS_CHECK, 'read', 'safe', { machineId: '{{machineId}}', refs: [exampleServedRef] }]),
  cleanupSpec(['machines.storage.trash.move', 'Move storage items to Trash', 'Moves reviewed items to Happier’s Trash, where you can put them back. Forbidden paths are refused; Keep items require confirmation of what is lost or the agent Action’s approval.', RPC_METHODS.DAEMON_STORAGE_TRASH_MOVE, 'danger', 'danger', { machineId: '{{machineId}}', items: [{ ref: exampleRef, expect: '{{expect}}', claimedVerdict: 'safe' }] }]),
  cleanupSpec(['machines.storage.deleteNow', 'Delete storage items now', 'Permanently delete reviewed items; this cannot be undone.', RPC_METHODS.DAEMON_STORAGE_DELETE_NOW, 'danger', 'danger']),
  cleanupSpec(['machines.storage.docker.prune', 'Clean up Docker images', 'Remove unused deployment images with proven expired receipt custody. Keeps retained, running and foreign images, volumes and data; unproven build cache is kept.', RPC_METHODS.DAEMON_STORAGE_DOCKER_PRUNE, 'danger', 'danger']),
  cleanupSpec(['machines.storage.trash.empty', 'Empty Happier’s Trash', 'Deletes what is in Happier’s Trash for good and gives the space back. This can’t be undone.', RPC_METHODS.DAEMON_STORAGE_TRASH_EMPTY, 'danger', 'danger']),
  cleanupSpec(['machines.storage.trash.restore', 'Put storage items back', 'Puts items back from Happier’s Trash without overwriting anything already there.', RPC_METHODS.DAEMON_STORAGE_TRASH_RESTORE, 'write', 'safe', { machineId: '{{machineId}}', entryIds: ['{{entryId}}'] }]),
  cleanupSpec(['machines.storage.worktrees.list', 'Read worktrees', 'Your worktrees with their sizes, and why each one is kept or can go.', RPC_METHODS.DAEMON_STORAGE_WORKTREES_LIST, 'read', 'safe', { machineId: '{{machineId}}' }]),
  cleanupSpec(['machines.storage.suggestions.list', 'Read cleanup suggestions', 'Things that look safe to remove, leaving out what you already declined.', RPC_METHODS.DAEMON_STORAGE_SUGGESTIONS_LIST, 'read', 'safe', { machineId: '{{machineId}}' }]),
  cleanupSpec(['machines.storage.suggestions.decline', 'Decline cleanup suggestions', 'Stops suggesting these items until they change.', RPC_METHODS.DAEMON_STORAGE_SUGGESTIONS_DECLINE, 'write', 'safe', { machineId: '{{machineId}}', items: [{ ref: exampleRef, expect: '{{expect}}' }] }]),
  cleanupSpec(['machines.storage.scan.start', 'Scan machine storage', 'Measures a folder or the whole disk, when scanning is turned on for this machine.', RPC_METHODS.DAEMON_STORAGE_SCAN_START, 'write', 'safe', { machineId: '{{machineId}}', target: { folderPath: '/tmp/cache' } }]),
  cleanupSpec(['machines.storage.scan.get', 'Read a storage scan', 'How far a folder or disk scan has got, and what it found.', RPC_METHODS.DAEMON_STORAGE_SCAN_GET, 'read', 'safe', { machineId: '{{machineId}}', scanId: '{{scanId}}' }]),
  cleanupSpec(['machines.storage.scan.cancel', 'Cancel a storage scan', 'Stops the scan and keeps what it measured so far.', RPC_METHODS.DAEMON_STORAGE_SCAN_CANCEL, 'write', 'safe', { machineId: '{{machineId}}', scanId: '{{scanId}}' }]),
  cleanupSpec(['machines.storage.scan.skip', 'Skip a folder in a scan', 'Skips the folder the scan is stuck on and carries on.', RPC_METHODS.DAEMON_STORAGE_SCAN_SKIP, 'write', 'safe', { machineId: '{{machineId}}', scanId: '{{scanId}}', path: '/tmp/cache' }]),
  cleanupSpec(['machines.storage.protected.add', 'Protect a folder', 'Marks a folder as Keep, excluding it from suggestions and automatic cleanup. Removing it requires confirmation of what is lost or the agent Action’s approval; Forbidden paths remain refused.', RPC_METHODS.DAEMON_STORAGE_PROTECTED_ADD, 'write', 'safe', { machineId: '{{machineId}}', path: '/tmp/cache' }]),
  cleanupSpec(['machines.storage.protected.remove', 'Stop protecting a folder', 'Removes a folder you protected. Built-in protection stays.', RPC_METHODS.DAEMON_STORAGE_PROTECTED_REMOVE, 'write', 'safe', { machineId: '{{machineId}}', path: '/tmp/cache' }]),
] as const;
export const MACHINE_STORAGE_ACTION_SPECS = [
  {
    ...base, id: 'machines.storage.summary.get', approval: {result: 'required'}, title: 'Read Happier storage',
    toolExposure: { agent: 'direct' },
    prompting: { agentGuidance: `${storageReferenceGuidance} Read this summary before analysing disk use or proposing cleanup. Happier’s share is allocated storage, not the amount a Trash move immediately frees; read suggestions and check the selected item set next.` },
    description: 'How much space Happier uses on a machine, by kind, and how full the disk is.',
    bindings: { rpcMethod: RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET, mcpToolName: 'machines_storage_summary_get', voiceClientToolName: 'getMachineStorageSummary' },
    inputSchema: MACHINE_STORAGE_ACTION_INPUT_SCHEMAS['machines.storage.summary.get'], outputSchema: MACHINE_STORAGE_ACTION_OUTPUT_SCHEMAS['machines.storage.summary.get'],
    cli: { acceptsServerId: true as const, commands: [{ path: ['machines', 'storage', 'summary', 'get'], visibility: 'canonical' }] },
    inputHints: { fields: [...fields] },
  },
  ...cleanupSpecs,
  {
    ...base, id: 'machines.storage.category.list', approval: {result: 'required'}, title: 'Read a storage category',
    toolExposure: { agent: 'discoverable_only' },
    prompting: { agentGuidance: 'Read the named category, following its cursor for more items. Use categoryId trash for current Trash entries; report in-Trash bytes separately from freed bytes.' },
    description: 'The items in one kind of Happier storage, with their sizes.',
    bindings: { rpcMethod: RPC_METHODS.DAEMON_STORAGE_CATEGORY_LIST, mcpToolName: 'machines_storage_category_list', voiceClientToolName: 'listMachineStorageCategory' },
    inputSchema: MACHINE_STORAGE_ACTION_INPUT_SCHEMAS['machines.storage.category.list'], outputSchema: MACHINE_STORAGE_ACTION_OUTPUT_SCHEMAS['machines.storage.category.list'],
    cli: { acceptsServerId: true as const, commands: [{ path: ['machines', 'storage', 'category', 'list'], visibility: 'canonical' }] },
    inputHints: { fields: [...fields, { path: 'categoryId', title: 'Category', widget: 'text', required: true }, { path: 'cursor', title: 'Next page', widget: 'text' }] },
  },
  {
    ...base, id: 'machines.storage.size.refresh', approval: {result: 'required'}, title: 'Measure Happier storage again',
    toolExposure: { agent: 'discoverable_only' },
    prompting: { agentGuidance: 'Read machines.storage.summary.get first. Refresh sizes when the person requests another measurement or the current facts need checking; this measures allocation without cleaning anything.' },
    description: 'Measures Happier’s storage again, for one kind or for all of them.',
    sideEffectClass: 'write', surfaces: { ...surfaces, voice: false },
    bindings: { rpcMethod: RPC_METHODS.DAEMON_STORAGE_SIZE_REFRESH, mcpToolName: 'machines_storage_size_refresh' },
    inputSchema: MACHINE_STORAGE_ACTION_INPUT_SCHEMAS['machines.storage.size.refresh'], outputSchema: MACHINE_STORAGE_ACTION_OUTPUT_SCHEMAS['machines.storage.size.refresh'],
    cli: { acceptsServerId: true as const, commands: [{ path: ['machines', 'storage', 'size', 'refresh'], visibility: 'canonical' }] },
    inputHints: { fields: [...fields, { path: 'categoryId', title: 'Category', widget: 'text' }] },
  },
] as const satisfies readonly PreNormalizedActionSpec[];
