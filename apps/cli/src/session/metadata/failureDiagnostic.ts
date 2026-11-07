import { z } from 'zod/mini';
import { readUnexpectedActionErrorDiagnosticV1 } from '@happier-dev/protocol/actions/actionExecutionResult';

import { SessionDetailInvalidResponseError } from '@/session/transport/http/sessionDetailInvalidResponse';
import { ExternalSessionFollowMetadataMismatchError } from '@/api/session/external/backgroundFollow/externalSessionFollowMetadataMismatchError';

export function readSessionMetadataFailureDiagnostic(error: unknown): Readonly<{
  errorClass: ReturnType<typeof readUnexpectedActionErrorDiagnosticV1>['errorClass'];
  schema?: SessionDetailInvalidResponseError['schema'];
  causeCode?: ExternalSessionFollowMetadataMismatchError['code'];
  causeDetails?: ExternalSessionFollowMetadataMismatchError['details'];
  schemaIssues?: readonly Readonly<{
    path: readonly (string | number)[];
    code: z.core.$ZodIssue['code'];
  }>[];
}> {
  const { errorClass } = readUnexpectedActionErrorDiagnosticV1(error);
  if (error instanceof ExternalSessionFollowMetadataMismatchError) {
    return { errorClass, causeCode: error.code, causeDetails: error.details };
  }
  if (error instanceof SessionDetailInvalidResponseError) {
    return { errorClass, schema: error.schema, schemaIssues: error.issues };
  }
  const schemaIssues = error instanceof z.core.$ZodError
    ? error.issues.map(({ path, code }) => ({
      // Raw Zod errors do not identify their schema. String path segments
      // may be content-derived record keys; retain only path structure.
      path: path.map(segment => typeof segment === 'number' ? segment : '[redacted]'),
      code,
    }))
    : undefined;
  return { errorClass, ...(schemaIssues ? { schemaIssues } : {}) };
}
