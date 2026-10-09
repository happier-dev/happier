import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { SessionDraftAddressV1Schema } from '../drafts/sessionDrafts.js';
import type { PreNormalizedActionSpec } from './actionSpecs.js';
import { ComposerRefV1Schema } from '../plugins/ui/composerRef.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { SessionDirectoryIntentV1Schema } from '../sessions/creation/sessionDirectoryIntentV1.js';

export const APP_SHELL_ACTION_IDS = ['inbox.mark_all_read', 'session.draft.delete', 'session.draft.directory.set'] as const;
export type AppShellActionId = typeof APP_SHELL_ACTION_IDS[number];
export function isAppShellActionId(value: string): value is AppShellActionId {
  return (APP_SHELL_ACTION_IDS as readonly string[]).includes(value);
}

const InboxTargetSchema = lazyZodSchema(() => z.object({ serverId: z.string().min(1), sessionId: z.string().min(1) }).strict());
export const AppShellActionInputSchemas = {
  'inbox.mark_all_read': z.object({ targets: z.array(InboxTargetSchema) }).strict(),
  'session.draft.delete': z.object({ draftId: SessionDraftAddressV1Schema.options[0].shape.draftId }).strict(),
  'session.draft.directory.set': z.object({ ref: asProtocolZod(ComposerRefV1Schema).refine(ref => ref.kind === 'newSession'),
    directory: SessionDirectoryIntentV1Schema }).strict(),
} as const;
export const AppShellActionOutputSchemas = {
  'inbox.mark_all_read': z.object({ results: z.array(InboxTargetSchema.extend({
    status: z.enum(['succeeded', 'failed', 'skipped', 'cancelled']),
  })) }).strict(),
  'session.draft.delete': z.object({ status: z.enum(['deleted', 'missing', 'launch_custody', 'unavailable']) }).strict(),
  'session.draft.directory.set': z.object({ status: z.enum(['applied', 'unavailable']) }).strict(),
} as const;

export const APP_SHELL_ACTION_SPECS = [
  {
    id: 'inbox.mark_all_read', title: 'Mark Inbox as read',
    description: 'Mark an exact Home-scoped Inbox snapshot read. Does not resolve approvals, mentions or human attention.',
    safety: 'safe', sideEffectClass: 'write', requiredAuthority: 'account_automation', executionPlacement: 'client',
    placements: [], bindings: { mcpToolName: 'inbox_mark_all_read' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: false, rpc: false },
    toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
    inputSchema: AppShellActionInputSchemas['inbox.mark_all_read'], outputSchema: AppShellActionOutputSchemas['inbox.mark_all_read'],
    inputHints: { fields: [{ path: 'targets', title: 'Inbox snapshot', widget: 'json', required: true }] },
  },
  {
    id: 'session.draft.delete', title: 'Delete a New Session draft',
    description: 'Delete an exact New Session draft on the answering client through draft tombstone and attachment cleanup. Refuses launches already in custody.',
    safety: 'danger', sideEffectClass: 'danger', requiredAuthority: 'account_automation', executionPlacement: 'client',
    placements: [], bindings: { mcpToolName: 'session_draft_delete' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: false, rpc: false },
    toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
    inputSchema: AppShellActionInputSchemas['session.draft.delete'], outputSchema: AppShellActionOutputSchemas['session.draft.delete'],
    inputHints: { fields: [{ path: 'draftId', title: 'Draft id', widget: 'text', required: true }] },
  },
  {
    id: 'session.draft.directory.set', title: 'Set New Session draft directory',
    description: 'Set folder or no-folder intent on one exact mounted editable New Session composer. Does not launch a Session or create a directory.',
    safety: 'safe', sideEffectClass: 'write', requiredAuthority: 'account_automation', executionPlacement: 'client',
    placements: [], bindings: { mcpToolName: 'session_draft_directory_set' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: false, rpc: false },
    toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
    inputSchema: AppShellActionInputSchemas['session.draft.directory.set'], outputSchema: AppShellActionOutputSchemas['session.draft.directory.set'],
    inputHints: { fields: [{ path: 'ref', title: 'Exact New Session composer', widget: 'json', required: true },
      { path: 'directory', title: 'Directory intent', widget: 'json', required: true }] },
  },
] as const satisfies readonly PreNormalizedActionSpec[];
