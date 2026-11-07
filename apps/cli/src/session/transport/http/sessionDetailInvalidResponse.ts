import type { z } from 'zod/mini';
import { V2SessionByIdResponseSchema, V2SessionRecordSchema } from '@happier-dev/protocol/sessions/control/contract';
import { SessionMetadataTuplePatchSuccessV1Schema, SessionMetadataVersionConflictV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';

/** A parser-owned refusal; no response values or Zod messages cross this boundary. */
export class SessionDetailInvalidResponseError extends Error {
  readonly code = 'session_detail_invalid_response' as const;
  readonly issues: readonly Readonly<{ path: readonly string[]; code: z.core.$ZodIssue['code'] }>[];

  constructor(
    readonly schema: 'v2_session_detail' | 'current_access_projection_v1' | 'session_metadata_version_conflict_v1' | 'session_metadata_tuple_patch_success_v1',
    issues: readonly z.core.$ZodIssue[],
  ) {
    super(`Unexpected /v2/sessions response shape (${schema})`);
    const rootShape = schema === 'session_metadata_version_conflict_v1'
      ? SessionMetadataVersionConflictV1Schema.shape
      : schema === 'session_metadata_tuple_patch_success_v1'
        ? SessionMetadataTuplePatchSuccessV1Schema.shape
        : V2SessionRecordSchema.shape;
    const structuralIssues = new Map<string, { path: string[]; code: z.core.$ZodIssue['code'] }>();
    for (const issue of issues) {
      // Diagnose the owning Session field. Collapsing nested paths excludes record
      // keys/array indices and bounds output by schema fields × Zod issue codes,
      // regardless of response collection sizes, without an arbitrary truncation cap.
      const path: string[] = [];
      const root = issue.path[0];
      if (schema === 'v2_session_detail') {
        if (typeof root === 'string' && Object.hasOwn(V2SessionByIdResponseSchema.shape, root)) path.push(root);
        const field = issue.path[1];
        if (root === 'session' && typeof field === 'string' && Object.hasOwn(V2SessionRecordSchema.shape, field)) path.push(field);
      } else if (typeof root === 'string' && Object.hasOwn(rootShape, root)) {
        path.push(root);
      }
      structuralIssues.set(JSON.stringify([path, issue.code]), { path, code: issue.code });
    }
    this.issues = [...structuralIssues.values()];
  }
}
