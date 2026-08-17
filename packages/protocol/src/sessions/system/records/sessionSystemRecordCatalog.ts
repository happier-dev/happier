import { z } from 'zod';

import { SessionSummaryShardV1Schema } from '../../../messages/structured/sessionSummaryShardV1.js';
import { SessionSynopsisV1Schema } from '../../../messages/structured/sessionSynopsisV1.js';
import { SessionBackgroundTaskRecordV1Schema } from '../../work/backgroundTask/backgroundTaskRecordV1.js';
import { SessionWorkflowRunSnapshotV1Schema } from '../../work/workflow/sessionWorkflowRunSnapshotV1.js';
import {
  SESSION_PERMISSION_SYSTEM_RECORD_NAMESPACE,
  SessionPermissionRemoteGrantRecordV1Schema,
  SessionPermissionRemoteSettlementRecordV1Schema,
} from '../../permissions/mediationRecordsV1.js';
import { SESSION_SYSTEM_RECORD_ACTIVITY_NAMESPACE } from './activity/activitySystemRecordKinds.js';
import { SESSION_SYSTEM_RECORD_MEMORY_NAMESPACE } from './memory/memorySystemRecordKinds.js';

export type SessionSystemRecordKindDefinition = Readonly<{
  payloadSchema: z.ZodType<unknown>;
  policy: SessionSystemRecordKindPolicy;
}>;

export type SessionSystemRecordKindPolicy = Readonly<{
  accountScope: 'actor' | 'session-owner';
  read: 'visible' | 'edit' | 'unavailable';
  write: 'visible' | 'edit' | 'unavailable';
  delete: 'visible' | 'edit' | 'unavailable';
  revision: 'opaque-row-version';
  cas: 'stored-envelope';
}>;

export type SessionSystemRecordNamespaceDefinition = Readonly<{
  kinds: Readonly<Record<string, SessionSystemRecordKindDefinition>>;
}>;

export type SessionSystemRecordCatalog = Readonly<Record<string, SessionSystemRecordNamespaceDefinition>>;

function defineSessionSystemRecordCatalog<const Catalog extends SessionSystemRecordCatalog>(catalog: Catalog): Catalog {
  return catalog;
}

export const SESSION_SYSTEM_RECORD_CATALOG = defineSessionSystemRecordCatalog({
  [SESSION_SYSTEM_RECORD_MEMORY_NAMESPACE]: {
    kinds: {
      'summary_shard.v1': {
        payloadSchema: SessionSummaryShardV1Schema,
        policy: {
          accountScope: 'actor',
          read: 'visible',
          write: 'visible',
          delete: 'visible',
          revision: 'opaque-row-version',
          cas: 'stored-envelope',
        },
      },
      'synopsis.v1': {
        payloadSchema: SessionSynopsisV1Schema,
        policy: {
          accountScope: 'actor',
          read: 'visible',
          write: 'visible',
          delete: 'visible',
          revision: 'opaque-row-version',
          cas: 'stored-envelope',
        },
      },
    },
  },
  [SESSION_SYSTEM_RECORD_ACTIVITY_NAMESPACE]: {
    kinds: {
      'workflow_run.v1': {
        payloadSchema: SessionWorkflowRunSnapshotV1Schema,
        policy: {
          accountScope: 'session-owner',
          read: 'visible',
          write: 'edit',
          delete: 'edit',
          revision: 'opaque-row-version',
          cas: 'stored-envelope',
        },
      },
      // Same policy as its `workflow_run.v1` sibling, and for the same reason: both are durable
      // outcomes of work the session owner's runtime performed, readable by anyone who can see the
      // session and writable only by an editor.
      'background_task.v1': {
        payloadSchema: SessionBackgroundTaskRecordV1Schema,
        policy: {
          accountScope: 'session-owner',
          read: 'visible',
          write: 'edit',
          delete: 'edit',
          revision: 'opaque-row-version',
          cas: 'stored-envelope',
        },
      },
    },
  },
  [SESSION_PERMISSION_SYSTEM_RECORD_NAMESPACE]: {
    kinds: {
      'remote_settlement.v1': {
        payloadSchema: SessionPermissionRemoteSettlementRecordV1Schema,
        policy: {
          accountScope: 'session-owner',
          read: 'unavailable',
          write: 'unavailable',
          delete: 'unavailable',
          revision: 'opaque-row-version',
          cas: 'stored-envelope',
        },
      },
      'remote_grant.v1': {
        payloadSchema: SessionPermissionRemoteGrantRecordV1Schema,
        policy: {
          accountScope: 'session-owner',
          read: 'unavailable',
          write: 'unavailable',
          delete: 'unavailable',
          revision: 'opaque-row-version',
          cas: 'stored-envelope',
        },
      },
    },
  },
});

export function getSessionSystemRecordPayloadSchema(namespace: string, kind: string): z.ZodType<unknown> | null {
  const catalog: SessionSystemRecordCatalog = SESSION_SYSTEM_RECORD_CATALOG;
  return catalog[namespace]?.kinds[kind]?.payloadSchema ?? null;
}

export function getSessionSystemRecordKindPolicy(namespace: string, kind: string): SessionSystemRecordKindPolicy | null {
  const catalog: SessionSystemRecordCatalog = SESSION_SYSTEM_RECORD_CATALOG;
  return catalog[namespace]?.kinds[kind]?.policy ?? null;
}

export function isRegisteredSessionSystemRecordKind(namespace: string, kind: string): boolean {
  return getSessionSystemRecordPayloadSchema(namespace, kind) !== null;
}

export function addRegisteredSessionSystemRecordKindIssue(value: { namespace: string; kind: string }, ctx: z.RefinementCtx): void {
  if (!isRegisteredSessionSystemRecordKind(value.namespace, value.kind)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Unregistered session system record namespace/kind pair',
      path: ['kind'],
    });
  }
}

export function addSessionSystemRecordPlainContentPayloadIssue(
  value: { namespace: string; kind: string; content?: unknown },
  ctx: z.RefinementCtx,
): void {
  addRegisteredSessionSystemRecordKindIssue(value, ctx);

  const content = value.content;
  if (!content || typeof content !== 'object' || Array.isArray(content)) return;
  const record = content as Record<string, unknown>;
  if (record.t !== 'plain') return;

  const payloadSchema = getSessionSystemRecordPayloadSchema(value.namespace, value.kind);
  if (!payloadSchema) return;

  const parsed = payloadSchema.safeParse(record.v);
  if (parsed.success) return;

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'Plain session system record content does not match registered namespace/kind payload schema',
    path: ['content', 'v'],
  });
}
