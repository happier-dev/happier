import { z } from 'zod';
import { asProtocolZod } from "../../plugins/actions/internalProtocolZodAdapter.js";

import {
  PluginContributionLocalIdSchema,
} from '../../plugins/contributionIdentity.js';
import { PluginIdSchema } from '../../plugins/pluginId.js';
import {
  parseOpenableContentPreferenceSelectorV1,
  serializeOpenableContentPreferenceSelectorV1,
} from '../../plugins/openableContent.js';

export const WORKSPACE_FILE_VIEWER_PREFERENCES_V1_MAX_ENTRIES = 128;
export const WORKSPACE_FILE_VIEWER_PREFERENCES_V1_MAX_ENCODED_BYTES = 64 * 1024;

const MAX_SERIALIZED_SELECTOR_LENGTH = 512;
const textEncoder = new TextEncoder();

export const WorkspaceFileViewerIdentityV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('builtin') }).strict(),
  z.object({
    kind: z.literal('plugin'),
    pluginId: asProtocolZod(PluginIdSchema),
    contributionLocalId: asProtocolZod(PluginContributionLocalIdSchema),
  }).strict(),
]);
export type WorkspaceFileViewerIdentityV1 = z.infer<typeof WorkspaceFileViewerIdentityV1Schema>;

const WorkspaceFileViewerSelectionsV1Schema = z.record(
  z.string().min(1).max(MAX_SERIALIZED_SELECTOR_LENGTH),
  WorkspaceFileViewerIdentityV1Schema,
);

/**
 * Account-owned durable intent from one SDK-normalized selector to one
 * qualified viewer identity. SDK owns selector semantics; Settings owns only
 * its bounded persistence shape and preserves unavailable identities verbatim.
 */
export const WorkspaceFileViewerPreferencesV1Schema = z.object({
  v: z.literal(1),
  selections: WorkspaceFileViewerSelectionsV1Schema,
}).strict().superRefine((value, context) => {
  const entries = Object.entries(value.selections);
  if (entries.length > WORKSPACE_FILE_VIEWER_PREFERENCES_V1_MAX_ENTRIES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['selections'],
      message: `At most ${WORKSPACE_FILE_VIEWER_PREFERENCES_V1_MAX_ENTRIES} viewer selections are allowed.`,
    });
  }

  const canonicalKeys = new Set<string>();
  for (const [serializedSelector] of entries) {
    try {
      const selector = parseOpenableContentPreferenceSelectorV1(serializedSelector);
      const canonicalSelector = serializeOpenableContentPreferenceSelectorV1(selector);
      if (serializedSelector !== canonicalSelector) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['selections', serializedSelector],
          message: 'Viewer preference selectors must use the canonical SDK serialization.',
        });
      }
      if (canonicalKeys.has(canonicalSelector)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['selections', serializedSelector],
          message: 'Viewer preference selectors must not duplicate after SDK normalization.',
        });
      }
      canonicalKeys.add(canonicalSelector);
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['selections', serializedSelector],
        message: error instanceof Error
          ? error.message
          : 'Viewer preference selector is invalid.',
      });
    }
  }

  if (textEncoder.encode(JSON.stringify(value)).byteLength > WORKSPACE_FILE_VIEWER_PREFERENCES_V1_MAX_ENCODED_BYTES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Viewer preferences exceed ${WORKSPACE_FILE_VIEWER_PREFERENCES_V1_MAX_ENCODED_BYTES} encoded bytes.`,
    });
  }
});
export type WorkspaceFileViewerPreferencesV1 = z.infer<typeof WorkspaceFileViewerPreferencesV1Schema>;

export const DEFAULT_WORKSPACE_FILE_VIEWER_PREFERENCES_V1: WorkspaceFileViewerPreferencesV1 = Object.freeze({
  v: 1,
  selections: {},
});

export type WorkspaceFileViewerPreferenceMutationV1 =
  | Readonly<{
    kind: 'select';
    /** Normalized here through the SDK-owned selector serializer. */
    selector: unknown;
    /** A durable builtin or qualified plugin viewer identity. */
    viewer: unknown;
  }>
  | Readonly<{
    kind: 'clear';
    /** Clearing restores ordinary SDK matching; it writes no fallback. */
    selector: unknown;
  }>;

function readWorkspaceFileViewerPreferences(
  settings: Readonly<Record<string, unknown>>,
): WorkspaceFileViewerPreferencesV1 {
  const parsed = WorkspaceFileViewerPreferencesV1Schema.safeParse(
    settings.workspaceFileViewerPreferencesV1,
  );
  return parsed.success ? parsed.data : DEFAULT_WORKSPACE_FILE_VIEWER_PREFERENCES_V1;
}

/**
 * Settings-owned Account-record transform for one durable file-viewer
 * preference. The caller owns the surrounding Account CAS/currentness; this
 * owner normalizes the SDK selector, bounds the resulting record, and keeps
 * unavailable plugin identities as durable intent without selecting a
 * synthetic builtin fallback.
 */
export function applyWorkspaceFileViewerPreferenceMutationV1(
  settings: Readonly<Record<string, unknown>>,
  mutation: WorkspaceFileViewerPreferenceMutationV1,
): Readonly<Record<string, unknown>> {
  const selector = serializeOpenableContentPreferenceSelectorV1(mutation.selector);
  const current = readWorkspaceFileViewerPreferences(settings);
  const selections: Record<string, WorkspaceFileViewerIdentityV1> = {
    ...current.selections,
  };

  if (mutation.kind === 'select') {
    selections[selector] = WorkspaceFileViewerIdentityV1Schema.parse(mutation.viewer);
  } else if (mutation.kind === 'clear') {
    delete selections[selector];
  } else {
    throw new Error('Workspace file viewer preference mutation kind is invalid.');
  }

  return Object.freeze({
    ...settings,
    workspaceFileViewerPreferencesV1: WorkspaceFileViewerPreferencesV1Schema.parse({
      v: 1,
      selections,
    }),
  });
}
