import { lazyActionSpecArray } from '../lazyActionSpecValue.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import {
  CreateOrUpdateSessionOrganizationTagRequestSchema, CreateOrUpdateSessionOrganizationTagResponseSchema,
  DeleteSessionOrganizationTagRequestSchema, DeleteSessionOrganizationTagResponseSchema,
} from '../../sessions/organization/mutations.js';
import { SessionOrganizationSnapshotResponseSchema } from '../../sessions/organization/snapshot.js';
import { SESSION_ORGANIZATION_TAG_DELETE_ASSIGNMENTS_DEFAULT } from '../../sessions/organization/constants.js';
import { SessionSectionRefV1Schema, SessionSectionsCreateInputV1Schema, SessionSectionsUpdateInputV1Schema,
  SessionSectionsReorderInputV1Schema, SessionSectionsListResultV1Schema, SessionSectionResultV1Schema,
  SessionSectionsReorderResultV1Schema, SessionSectionsDeleteResultV1Schema, SessionSectionsArchiveResultV1Schema } from '../sessionSections.js';
import { homeDomainActionRow } from './homeDomainRow.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';

const listInput = z.strictObject({});
const tagRenameInput = lazyZodSchema(() => z.extend(CreateOrUpdateSessionOrganizationTagRequestSchema, { tagId: z.string().check(z.trim(), z.minLength(1)) }));

// Resource creation and rename use the incumbent upsert contract and display
// envelopes. This is an Action projection, never an organization store.
function row<
  const TActionId extends PreNormalizedActionSpec['id'],
  const TInputSchema extends z.ZodMiniType,
  const TOutputSchema extends z.ZodMiniType,
>(spec: Parameters<typeof homeDomainActionRow<TActionId, TInputSchema, TOutputSchema>>[0]) {
  const declared = homeDomainActionRow(spec);
  // Keep this literal family's schema/authority projection exact. The shared
  // row's broad registry type also permits unrelated surface-schema overrides;
  // those are not authored by these resource rows.
  return { id: spec.id, approval: spec.approval, title: declared.title, description: declared.description,
    ...(spec.irreversible === undefined ? {} : { irreversible: spec.irreversible }),
    safety: spec.safety, sideEffectClass: spec.sideEffectClass,
    cli: declared.cli, placements: declared.placements, inputHints: declared.inputHints,
    serverTransport: declared.serverTransport, inputSchema: spec.inputSchema, outputSchema: spec.outputSchema,
    requiredAuthority: declared.requiredAuthority, executionPlacement: declared.executionPlacement,
    surfaces: { ui: true, voice: spec.id.startsWith('session.tags.'), agent: true, mcp: true, cli: true, rpc: false },
    bindings: { mcpToolName: spec.id.replaceAll('.', '_'),
      ...(spec.id.startsWith('session.tags.') ? { voiceClientToolName: spec.id.replaceAll('.', '_') } : {}) } } as const;
}

function createSessionOrganizationResourceActionSpecs() {
  return [
  row({ id: 'session.sections.list', approval: {result: 'none'}, title: 'List Session sections', description: 'Read all section definitions on the selected Home.',
    safety: 'safe', sideEffectClass: 'read', method: 'GET', path: '/v2/session-organization', cliPath: ['session', 'sections', 'list'], inputSchema: listInput, outputSchema: lazyZodSchema(() => SessionSectionsListResultV1Schema) }),
  row({ id: 'session.sections.create', approval: {result: 'none'}, title: 'Create Session section', description: 'Create a named Account section with an optional icon.',
    safety: 'safe', sideEffectClass: 'external', path: '/v2/session-organization/folders', cliPath: ['session', 'sections', 'create'], inputSchema: lazyZodSchema(() => SessionSectionsCreateInputV1Schema), outputSchema: lazyZodSchema(() => SessionSectionResultV1Schema) }),
  row({ id: 'session.sections.update', approval: {result: 'none'}, title: 'Update Session section', description: 'Change a section name or icon, preserving omitted display fields.',
    safety: 'safe', sideEffectClass: 'external', path: '/v2/session-organization/folders', cliPath: ['session', 'sections', 'update'], inputSchema: lazyZodSchema(() => SessionSectionsUpdateInputV1Schema), outputSchema: lazyZodSchema(() => SessionSectionResultV1Schema) }),
  row({ id: 'session.sections.reorder', approval: {result: 'none'}, title: 'Reorder Session section', description: 'Move a section before another section; null appends.',
    safety: 'safe', sideEffectClass: 'external', path: '/v2/session-organization/folders', cliPath: ['session', 'sections', 'reorder'], inputSchema: lazyZodSchema(() => SessionSectionsReorderInputV1Schema), outputSchema: lazyZodSchema(() => SessionSectionsReorderResultV1Schema) }),
  row({ id: 'session.sections.delete', approval: {result: 'none'}, title: 'Remove Session section', description: 'Remove only this section. Its own assignments and direct legacy children return to its parent; Sessions survive.',
    inputHints: { fields: [{ path: 'sectionId', title: 'Section ID', prompt: 'Use session.sections.list on the selected Home to find the section.', widget: 'text', required: true }] },
    safety: 'safe', sideEffectClass: 'external', method: 'DELETE', path: '/v2/session-organization/folders/:sectionId', cliPath: ['session', 'sections', 'delete'], inputSchema: lazyZodSchema(() => SessionSectionRefV1Schema), outputSchema: lazyZodSchema(() => SessionSectionsDeleteResultV1Schema) }),
  row({ id: 'session.sections.archive', approval: {result: 'none'}, title: 'Archive Sessions in section', description: 'Archive exact section membership through each Session archive policy, including unloaded members.',
    safety: 'safe', sideEffectClass: 'external', method: 'GET', path: '/v2/session-organization', cliPath: ['session', 'sections', 'archive'], inputSchema: lazyZodSchema(() => SessionSectionRefV1Schema), outputSchema: lazyZodSchema(() => SessionSectionsArchiveResultV1Schema) }),
  row({ id: 'session.tags.list', approval: {result: 'required'}, title: 'List Session tags', description: 'Read the existing organization snapshot, including tag and folder identities and display envelopes.',
    safety: 'safe', sideEffectClass: 'read', method: 'GET', path: '/v2/session-organization', cliPath: ['session', 'tags', 'list'], inputSchema: listInput, outputSchema: SessionOrganizationSnapshotResponseSchema }),
  row({ id: 'session.tags.create', approval: {result: 'required'}, title: 'Create Session tag', description: 'Create a tag for labelling sessions.',
    safety: 'safe', sideEffectClass: 'external', path: '/v2/session-organization/tags', cliPath: ['session', 'tags', 'create'], inputSchema: CreateOrUpdateSessionOrganizationTagRequestSchema, outputSchema: CreateOrUpdateSessionOrganizationTagResponseSchema }),
  row({ id: 'session.tags.rename', approval: {result: 'required'}, title: 'Rename Session tag', description: 'Change a session tag\'s name. Retain its current key and order fields in the request.',
    inputHints: { description: 'Change a session tag\'s name.', fields: [] },
    safety: 'safe', sideEffectClass: 'external', path: '/v2/session-organization/tags', cliPath: ['session', 'tags', 'rename'], inputSchema: tagRenameInput, outputSchema: CreateOrUpdateSessionOrganizationTagResponseSchema }),
  row({ id: 'session.tags.delete', approval: {result: 'required'}, title: 'Delete Session tag', description: 'Delete an organization tag using the existing assignment disposition contract.',
    irreversible: true,
    preservePathFieldsInBody: true,
    inputHints: { fields: [
      { path: 'tagId', title: 'Tag ID', prompt: 'Use session.tags.list on the selected Home to find the tag ID.', widget: 'text', required: true },
      { path: 'assignmentBehavior', title: 'Assignment behavior', widget: 'select', options: [
        { value: SESSION_ORGANIZATION_TAG_DELETE_ASSIGNMENTS_DEFAULT, label: 'Remove tag assignments' },
      ] },
    ] },
    safety: 'danger', sideEffectClass: 'danger', method: 'DELETE', path: '/v2/session-organization/tags/:tagId', cliPath: ['session', 'tags', 'delete'], inputSchema: DeleteSessionOrganizationTagRequestSchema, outputSchema: DeleteSessionOrganizationTagResponseSchema }),
] as const;
}

export const SESSION_ORGANIZATION_RESOURCE_ACTION_SPECS: ReturnType<typeof createSessionOrganizationResourceActionSpecs> = lazyActionSpecArray(createSessionOrganizationResourceActionSpecs);
