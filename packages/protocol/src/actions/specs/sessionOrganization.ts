import { z } from 'zod';
import {
  CreateOrUpdateSessionOrganizationFolderRequestSchema, CreateOrUpdateSessionOrganizationFolderResponseSchema,
  CreateOrUpdateSessionOrganizationTagRequestSchema, CreateOrUpdateSessionOrganizationTagResponseSchema,
  DeleteSessionOrganizationFolderRequestSchema, DeleteSessionOrganizationFolderResponseSchema,
  DeleteSessionOrganizationTagRequestSchema, DeleteSessionOrganizationTagResponseSchema,
} from '../../sessions/organization/mutations.js';
import { SessionOrganizationSnapshotResponseSchema } from '../../sessions/organization/snapshot.js';
import { homeDomainActionRow } from './homeDomainRow.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';

const listInput = z.object({}).strict();
const folderRenameInput = CreateOrUpdateSessionOrganizationFolderRequestSchema.extend({ folderId: z.string().trim().min(1) });
const tagRenameInput = CreateOrUpdateSessionOrganizationTagRequestSchema.extend({ tagId: z.string().trim().min(1) });

// Resource creation and rename use the incumbent upsert contract and display
// envelopes. This is an Action projection, never an organization store.
function row<
  const TActionId extends PreNormalizedActionSpec['id'],
  const TInputSchema extends z.ZodTypeAny,
  const TOutputSchema extends z.ZodTypeAny,
>(spec: Parameters<typeof homeDomainActionRow<TActionId, TInputSchema, TOutputSchema>>[0]) {
  const declared = homeDomainActionRow(spec);
  // Keep this literal family's schema/authority projection exact. The shared
  // row's broad registry type also permits unrelated surface-schema overrides;
  // those are not authored by these resource rows.
  return { id: spec.id, title: declared.title, description: declared.description,
    safety: spec.safety, sideEffectClass: spec.sideEffectClass,
    cli: declared.cli, placements: declared.placements, inputHints: declared.inputHints,
    serverTransport: declared.serverTransport, inputSchema: spec.inputSchema, outputSchema: spec.outputSchema,
    requiredAuthority: declared.requiredAuthority, executionPlacement: declared.executionPlacement,
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    bindings: { mcpToolName: spec.id.replaceAll('.', '_') } } as const;
}

export const SESSION_ORGANIZATION_RESOURCE_ACTION_SPECS = [
  row({ id: 'session.folders.list', title: 'List Session folders', description: 'Read the existing organization snapshot, including folder and tag identities and display envelopes.',
    safety: 'safe', sideEffectClass: 'read', method: 'GET', path: '/v2/session-organization', cliPath: ['session', 'folders', 'list'], inputSchema: listInput, outputSchema: SessionOrganizationSnapshotResponseSchema }),
  row({ id: 'session.folders.create', title: 'Create Session folder', description: 'Create a folder for organizing sessions.',
    safety: 'safe', sideEffectClass: 'external', path: '/v2/session-organization/folders', cliPath: ['session', 'folders', 'create'], inputSchema: CreateOrUpdateSessionOrganizationFolderRequestSchema, outputSchema: CreateOrUpdateSessionOrganizationFolderResponseSchema }),
  row({ id: 'session.folders.rename', title: 'Rename Session folder', description: 'Change a session folder\'s name. Retain its current key, parent and order fields in the request.',
    inputHints: { description: 'Change a session folder\'s name.', fields: [] },
    safety: 'safe', sideEffectClass: 'external', path: '/v2/session-organization/folders', cliPath: ['session', 'folders', 'rename'], inputSchema: folderRenameInput, outputSchema: CreateOrUpdateSessionOrganizationFolderResponseSchema }),
  row({ id: 'session.folders.delete', title: 'Delete Session folder', description: 'Delete an organization folder using the existing assignment disposition contract.',
    safety: 'danger', sideEffectClass: 'danger', method: 'DELETE', path: '/v2/session-organization/folders/:folderId', cliPath: ['session', 'folders', 'delete'], inputSchema: DeleteSessionOrganizationFolderRequestSchema, outputSchema: DeleteSessionOrganizationFolderResponseSchema }),
  row({ id: 'session.tags.list', title: 'List Session tags', description: 'Read the existing organization snapshot, including tag and folder identities and display envelopes.',
    safety: 'safe', sideEffectClass: 'read', method: 'GET', path: '/v2/session-organization', cliPath: ['session', 'tags', 'list'], inputSchema: listInput, outputSchema: SessionOrganizationSnapshotResponseSchema }),
  row({ id: 'session.tags.create', title: 'Create Session tag', description: 'Create a tag for labelling sessions.',
    safety: 'safe', sideEffectClass: 'external', path: '/v2/session-organization/tags', cliPath: ['session', 'tags', 'create'], inputSchema: CreateOrUpdateSessionOrganizationTagRequestSchema, outputSchema: CreateOrUpdateSessionOrganizationTagResponseSchema }),
  row({ id: 'session.tags.rename', title: 'Rename Session tag', description: 'Change a session tag\'s name. Retain its current key and order fields in the request.',
    inputHints: { description: 'Change a session tag\'s name.', fields: [] },
    safety: 'safe', sideEffectClass: 'external', path: '/v2/session-organization/tags', cliPath: ['session', 'tags', 'rename'], inputSchema: tagRenameInput, outputSchema: CreateOrUpdateSessionOrganizationTagResponseSchema }),
  row({ id: 'session.tags.delete', title: 'Delete Session tag', description: 'Delete an organization tag using the existing assignment disposition contract.',
    safety: 'danger', sideEffectClass: 'danger', method: 'DELETE', path: '/v2/session-organization/tags/:tagId', cliPath: ['session', 'tags', 'delete'], inputSchema: DeleteSessionOrganizationTagRequestSchema, outputSchema: DeleteSessionOrganizationTagResponseSchema }),
] as const;
