import { lazyActionSpecArray } from '../lazyActionSpecValue.js';
import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import {
  SHARED_SAVED_SECRET_ACTION_IDS_V1,
  SHARED_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1,
  SHARED_SAVED_SECRET_ACTION_METHODS_V1,
  SHARED_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1,
  SHARED_SAVED_SECRET_ACTION_PATHS_V1,
} from '../../account/settings/savedSecretResourceActionsV1.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';
import { homeDomainActionRow } from './homeDomainRow.js';

const READ_ACTIONS = new Set(['secrets.shared.list']);

function projectSharedSavedSecretObservationInput(id: string, input: unknown): unknown {
  if (id === 'secrets.shared.create') {
    const parsed = SHARED_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1[id].safeParse(input);
    if (!parsed.success) return {};
    return {
      resourceId: parsed.data.resourceId,
      displayName: parsed.data.displayName,
      kind: parsed.data.kind,
      encryptionMode: parsed.data.encryptionMode,
      accountGrants: parsed.data.accountGrants,
      teamGrants: parsed.data.teamGrants,
      groupGrants: parsed.data.groupGrants,
    };
  }
  if (id === 'secrets.shared.promote') {
    const parsed = SHARED_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1[id].safeParse(input);
    if (!parsed.success) return {};
    return {
      resourceId: parsed.data.resourceId,
      displayName: parsed.data.displayName,
      kind: parsed.data.kind,
      encryptionMode: parsed.data.encryptionMode,
      accountGrants: parsed.data.accountGrants,
      teamGrants: parsed.data.teamGrants,
      groupGrants: parsed.data.groupGrants,
      expectedSettingsVersion: parsed.data.expectedSettingsVersion,
    };
  }
  if (id === 'secrets.shared.grants.set') {
    const parsed = SHARED_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1[id].safeParse(input);
    if (!parsed.success) return {};
    return {
      resourceId: parsed.data.resourceId,
      expectedRevision: parsed.data.expectedRevision,
      accountGrants: parsed.data.accountGrants,
      teamGrants: parsed.data.teamGrants,
      groupGrants: parsed.data.groupGrants,
    };
  }
  if (id === 'secrets.shared.update') {
    const parsed = SHARED_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1[id].safeParse(input);
    if (!parsed.success) return {};
    return {
      resourceId: parsed.data.resourceId,
      expectedRevision: parsed.data.expectedRevision,
      displayName: parsed.data.displayName,
      kind: parsed.data.kind,
      // A mode conversion is the trust change the approver decides on.
      ...(parsed.data.toMode ? { toMode: parsed.data.toMode } : {}),
    };
  }
  return input;
}

export const SHARED_SAVED_SECRET_ACTION_SPECS: readonly PreNormalizedActionSpec[] = lazyActionSpecArray(() => Object.freeze(
  SHARED_SAVED_SECRET_ACTION_IDS_V1.map((id): PreNormalizedActionSpec => {
    if (id === 'secrets.shared.repair') return {
      id, title: 'Finish sharing Saved Secret', description: 'Prepare owed key envelopes for the already-approved audience at the exact Saved Secret revision.',
      safety: 'danger', sideEffectClass: 'write', requiredAuthority: 'present_user', executionPlacement: 'client',
      approval: { result: 'required', flow: 'deferred' }, approvalPolicy: { uiConfirmation: 'direct' }, placements: [],
      surfaces: { ui: true, cli: false, agent: true, mcp: true, rpc: false, voice: false },
      bindings: { mcpToolName: 'secrets_shared_repair' },
      inputSchema: SHARED_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1[id], outputSchema: SHARED_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1[id],
      inputHints: { fields: [] },
    };
    if (id === 'secrets.shared.reveal') return {
      id, title: 'Reveal shared Saved Secret', description: 'Display an exact managed Saved Secret only to the person in the app.',
      safety: 'danger', sideEffectClass: 'write', requiredAuthority: 'present_user', executionPlacement: 'client',
      approval: { result: 'optional', flow: 'deferred' }, approvalPolicy: { uiConfirmation: 'direct' }, placements: [],
      // Agent/MCP callers request it through the ordinary default Ask; the value
      // is shown only in the approving person's app and never returned.
      surfaces: { ui: true, cli: false, agent: true, mcp: true, rpc: false, voice: false },
      bindings: { mcpToolName: 'secrets_shared_reveal' },
      inputSchema: SHARED_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1[id], outputSchema: SHARED_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1[id],
      inputHints: { fields: [] },
    };
    const reviewSchema = id === 'secrets.shared.create'
      ? lazyZodSchema(() => z.omit(SHARED_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1['secrets.shared.create'], { storedContent: true, keyEnvelopes: true }))
      : id === 'secrets.shared.promote'
        ? lazyZodSchema(() => z.extend(z.omit(SHARED_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1['secrets.shared.create'],
          { storedContent: true, keyEnvelopes: true }), {
          expectedSettingsVersion: SHARED_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1['secrets.shared.promote'].shape.expectedSettingsVersion,
        }))
        : id === 'secrets.shared.update'
          ? lazyZodSchema(() => z.omit(SHARED_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1['secrets.shared.update'], { storedContent: true, keyEnvelopes: true }))
          : undefined;
    const row = homeDomainActionRow({
      mcp: true,
      id, approval: READ_ACTIONS.has(id) ? { result: 'required' } : { result: 'required', flow: 'deferred' },
      ...(id === 'secrets.shared.delete' ? { confirmVerb: { key: 'common.delete', fallback: 'Delete' }, irreversible: true as const } : {}),
      title: {
        'secrets.shared.list': 'List Saved Secrets',
        'secrets.shared.create': 'Create Saved Secret',
        'secrets.shared.promote': 'Promote Saved Secret',
        'secrets.shared.grants.set': 'Update shared Saved Secret access',
        'secrets.shared.update': 'Update Saved Secret',
        'secrets.shared.delete': 'Delete Saved Secret',
      }[id],
      description: {
        'secrets.shared.list': 'List Saved Secret metadata visible to the authenticated Account without revealing values.',
        'secrets.shared.create': 'Create an independently managed Saved Secret resource.',
        'secrets.shared.promote': 'Atomically promote a personal Saved Secret and rewrite its Account Settings references.',
        'secrets.shared.grants.set': 'Replace the complete Account, Team, and Group audience of a shared Saved Secret.',
        'secrets.shared.update': 'Rename or rotate a Saved Secret through its canonical resource owner.',
        'secrets.shared.delete': 'Delete a Saved Secret resource.',
      }[id],
      safety: READ_ACTIONS.has(id) ? 'safe' : 'danger',
      sideEffectClass: READ_ACTIONS.has(id) ? 'read' : 'danger',
      cliPath: id.split('.').map((segment) => segment.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)),
      method: SHARED_SAVED_SECRET_ACTION_METHODS_V1[id],
      path: SHARED_SAVED_SECRET_ACTION_PATHS_V1[id],
      inputSchema: SHARED_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1[id],
      outputSchema: SHARED_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1[id],
      // Review uses the existing safe resource/audience projection; stored
      // content and recipient key envelopes remain executable operands only.
      ...(reviewSchema ? { approvalPresentation: { summary: () => null, inputSchema: reviewSchema, inputHints: { fields: [] },
        projectInput: (input: unknown) => reviewSchema.parse(projectSharedSavedSecretObservationInput(id, input)),
      } } : {}),
      // Observation redaction only. `create`/`promote`/`update` deliberately do NOT
      // declare `approvalInputCustody: 'live_only'`, and that is settled, not an
      // oversight: their `storedContent` is the explicit
      // `{ t: 'plain', v } | { t: 'encrypted', c }` envelope
      // (`savedSecretResourceContentSchemaV1.ts:81-90`), so an e2ee resource puts
      // only ciphertext into the durable approval args, and a plain resource puts
      // the same bytes the Account-scoped destination stores in cleartext anyway —
      // identical custody class, no new disclosure. These Actions are also
      // deferred-replayable, so a live-only input would break replay for no gain.
      ...(id === 'secrets.shared.create'
        || id === 'secrets.shared.promote'
        || id === 'secrets.shared.grants.set'
        || id === 'secrets.shared.update'
        ? { projectObservationInput: (input: unknown) => projectSharedSavedSecretObservationInput(id, input) }
        : {}),
    });
    if (!row.surfaces.mcp) return row;
    return {
      ...row,
      bindings: { ...row.bindings, mcpToolName: id.replaceAll('.', '_') },
    };
  }),
));
