import { z } from 'zod';
import { EntityDragScopeV1Schema } from '../plugins/ui/entityDragDrop.js';
import { ComposerRefV1Schema, ComposerTransactionV1Schema, ComposerTransactionResultV1Schema } from '../plugins/ui/composer.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import type { PreNormalizedActionSpec } from './actionSpecs.js';

const composerAddress = { scope: EntityDragScopeV1Schema, ref: asProtocolZod(ComposerRefV1Schema) };
export const ComposerTransactionApplyInputV1Schema = z.object({
  ...composerAddress, transaction: ComposerTransactionV1Schema,
}).strict();
export const ComposerAttachmentsPickInputV1Schema = z.object(composerAddress).strict();
export const ComposerAttachmentsPickResultV1Schema = z.object({
  status: z.enum(['opened', 'notEditable', 'unavailable']),
}).strict();
export const RepositoryUploadPickInputV1Schema = z.object({
  scope: EntityDragScopeV1Schema,
  workspace: z.object({ serverId: z.string().trim().min(1), machineId: z.string().trim().min(1), rootPath: z.string().trim().min(1) }).strict(),
  destinationDir: z.string(),
  kind: z.enum(['files', 'folder']),
}).strict().refine(input => input.scope.serverId === input.workspace.serverId, { path: ['workspace', 'serverId'] });
export const RepositoryUploadPickResultV1Schema = z.discriminatedUnion('status', [
  z.object({ status: z.enum(['requested', 'unavailable', 'cancelled']) }).strict(),
  z.object({ status: z.literal('refused'), reason: z.string().min(1) }).strict(),
]);
export type ComposerTransactionApplyInputV1 = z.infer<typeof ComposerTransactionApplyInputV1Schema>;
export type ComposerAttachmentsPickInputV1 = z.infer<typeof ComposerAttachmentsPickInputV1Schema>;
export type RepositoryUploadPickInputV1 = z.infer<typeof RepositoryUploadPickInputV1Schema>;
export type RepositoryUploadPickResultV1 = z.infer<typeof RepositoryUploadPickResultV1Schema>;

const client = { executionPlacement: 'client', placements: [],
  surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: false, rpc: false } } as const;
const addressHints = [
  { path: 'scope', title: 'Account scope', widget: 'json', required: true },
  { path: 'ref', title: 'Mounted composer', widget: 'json', required: true },
] as const;
export const COMPOSER_INGRESS_ACTION_SPECS = [{
  ...client, id: 'composer.transaction.apply', title: 'Apply composer transaction',
  description: 'Apply a revision-bound text/reference transaction to the exact mounted editable composer. Preserves the existing document owner; never submits input or grants attachment custody.',
  safety: 'safe', sideEffectClass: 'external', bindings: { mcpToolName: 'composer_transaction_apply' },
  inputSchema: ComposerTransactionApplyInputV1Schema, outputSchema: ComposerTransactionResultV1Schema,
  inputHints: { title: 'Apply composer transaction', fields: [...addressHints,
    { path: 'transaction', title: 'Revision-bound transaction', widget: 'json', required: true }] },
  examples: { mcp: { argsExample: '{"scope":{"serverId":"home-a","accountId":"account-a"},"ref":{"kind":"newSession","instanceId":"composer-a"},"transaction":{"expectedRevision":1,"operations":[{"kind":"text.insert","position":{"offset":0},"text":"Context"}]}}' } },
}, {
  ...client, id: 'composer.attachments.pick', title: 'Pick composer attachments',
  description: 'Open the exact mounted composer file picker. Selected files use its existing staging custody and never auto-send. OS file handles and bytes cannot be authored in Action input.',
  safety: 'safe', sideEffectClass: 'external', bindings: { mcpToolName: 'composer_attachments_pick' },
  inputSchema: ComposerAttachmentsPickInputV1Schema, outputSchema: ComposerAttachmentsPickResultV1Schema,
  inputHints: { title: 'Pick composer attachments', fields: [...addressHints] },
  examples: { mcp: { argsExample: '{"scope":{"serverId":"home-a","accountId":"account-a"},"ref":{"kind":"newSession","instanceId":"composer-a"}}' } },
}, {
  ...client, id: 'repository.upload.pick', title: 'Pick repository upload',
  description: 'Request the mounted repository file or folder picker for the exact workspace and destination. Existing transfer progress, conflicts and partial failure remain authoritative; requested does not acknowledge upload completion.',
  safety: 'danger', sideEffectClass: 'danger', bindings: { mcpToolName: 'repository_upload_pick' },
  inputSchema: RepositoryUploadPickInputV1Schema, outputSchema: RepositoryUploadPickResultV1Schema,
  inputHints: { title: 'Pick repository upload', fields: [
    addressHints[0],
    { path: 'workspace', title: 'Workspace', widget: 'json', required: true },
    { path: 'destinationDir', title: 'Destination directory', widget: 'text', required: true },
    { path: 'kind', title: 'Files or folder', widget: 'text', required: true },
  ] },
  examples: { mcp: { argsExample: '{"scope":{"serverId":"home-a","accountId":"account-a"},"workspace":{"serverId":"home-a","machineId":"machine-a","rootPath":"/repo"},"destinationDir":"src","kind":"files"}' } },
}] as const satisfies readonly PreNormalizedActionSpec[];
