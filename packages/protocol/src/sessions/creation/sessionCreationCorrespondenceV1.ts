import { z } from 'zod';

import { AgentExecutionTargetV1Schema } from '../../agents/executionTargetV1.js';
import { ConnectedServiceBindingsV1Schema } from '../../connect/connectedServiceBindings.js';
import { decodeBase64, encodeBase64 } from '../../crypto/base64.js';
import { SessionMcpSelectionV1Schema } from '../../mcp/servers/sessionSelectionV1.js';
import { SessionModelSelectionV1Schema } from '../../providers/selection/v1.js';
import { AgentSessionConfigurationSnapshotV1Schema } from '../../runtime/agentSessionV1.js';
import { AgentSessionStartupInstructionsMarkerV1Schema } from '../../runtime/agentSessionStartupInstructionsV1.js';
import { SessionAuthoringTerminalV1Schema } from '../authoring/creationFieldsV1.js';
import { SessionCreationTagV1Schema } from './sessionCreationIdentityV1.js';
import { SessionOrganizationPlacementV1Schema } from './sessionSpawnNewResultV1.js';

export const SessionCreationImmutableRecipeV1Schema = z.object({
  execution: z.object({
    machineId: z.string().trim().min(1),
    directory: z.string().trim().min(1),
  }).strict(),
  organization: SessionOrganizationPlacementV1Schema,
  agentTarget: AgentExecutionTargetV1Schema,
  modelSelection: SessionModelSelectionV1Schema.nullable(),
  profileId: z.string().trim().min(1).nullable(),
  requestedPermissionMode: z.string().trim().min(1).nullable(),
  agentModeId: z.string().trim().min(1).nullable(),
  configuration: AgentSessionConfigurationSnapshotV1Schema.nullable(),
  connectedServices: ConnectedServiceBindingsV1Schema.nullable(),
  mcpSelection: SessionMcpSelectionV1Schema.nullable(),
  transcriptStorage: z.enum(['persisted', 'direct']).nullable(),
  terminal: SessionAuthoringTerminalV1Schema.nullable(),
  agentSessionStartupInstructionsMarkerV1:
    AgentSessionStartupInstructionsMarkerV1Schema.nullable(),
  checkout: z.object({
    kind: z.literal('git_worktree'),
    finalDirectory: z.string().trim().min(1),
    baseRef: z.string().trim().min(1).nullable(),
    branchMode: z.enum(['new', 'existing']),
  }).strict().nullable(),
}).strict();
export type SessionCreationImmutableRecipeV1 = z.infer<
  typeof SessionCreationImmutableRecipeV1Schema
>;

export const SessionCreationCorrespondenceV1Schema = z.object({
  v: z.literal(1),
  sessionCreationTag: SessionCreationTagV1Schema,
  recipe: SessionCreationImmutableRecipeV1Schema,
}).strict();
export type SessionCreationCorrespondenceV1 = z.infer<
  typeof SessionCreationCorrespondenceV1Schema
>;

export function normalizeSessionCreationOrganizationPlacementV1(
  input: z.input<typeof SessionOrganizationPlacementV1Schema> | undefined,
): z.output<typeof SessionOrganizationPlacementV1Schema> {
  const parsed = SessionOrganizationPlacementV1Schema.parse(
    input ?? { folderId: null, tagIds: [] },
  );
  return {
    folderId: parsed.folderId,
    tagIds: [...parsed.tagIds].sort((left, right) => left.localeCompare(right)),
  };
}

export function sessionCreationCorrespondenceMatchesV1(
  left: unknown,
  right: unknown,
): boolean {
  const parsedLeft = SessionCreationCorrespondenceV1Schema.safeParse(left);
  const parsedRight = SessionCreationCorrespondenceV1Schema.safeParse(right);
  return parsedLeft.success
    && parsedRight.success
    && JSON.stringify(parsedLeft.data) === JSON.stringify(parsedRight.data);
}

const SESSION_CREATION_CORRESPONDENCE_V1_TRANSPORT_PREFIX = 'scv1:';
const SESSION_CREATION_CORRESPONDENCE_V1_TRANSPORT_MAX_LENGTH = 24_000;
const transportEncoder = new TextEncoder();
const transportDecoder = new TextDecoder('utf-8', { fatal: true });

export function serializeSessionCreationCorrespondenceV1(
  correspondence: SessionCreationCorrespondenceV1,
): string {
  const parsed = SessionCreationCorrespondenceV1Schema.parse(correspondence);
  const encoded = `${SESSION_CREATION_CORRESPONDENCE_V1_TRANSPORT_PREFIX}${encodeBase64(
    transportEncoder.encode(JSON.stringify(parsed)),
    'base64url',
  ).replace(/=+$/u, '')}`;
  if (encoded.length > SESSION_CREATION_CORRESPONDENCE_V1_TRANSPORT_MAX_LENGTH) {
    throw new Error('Session creation correspondence transport exceeds its maximum length');
  }
  return encoded;
}

export function deserializeSessionCreationCorrespondenceV1(
  value: string,
): SessionCreationCorrespondenceV1 {
  if (
    value.length > SESSION_CREATION_CORRESPONDENCE_V1_TRANSPORT_MAX_LENGTH
    || !/^scv1:[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new Error('Invalid Session creation correspondence transport');
  }
  try {
    const parsed = SessionCreationCorrespondenceV1Schema.parse(JSON.parse(
      transportDecoder.decode(decodeBase64(
        value.slice(SESSION_CREATION_CORRESPONDENCE_V1_TRANSPORT_PREFIX.length),
        'base64url',
      )),
    ) as unknown);
    if (serializeSessionCreationCorrespondenceV1(parsed) !== value) {
      throw new Error('non-canonical transport');
    }
    return parsed;
  } catch {
    throw new Error('Invalid Session creation correspondence transport');
  }
}
