import { ScmFileViewedReadResultV1Schema, ScmFileViewedSetResultV1Schema } from '@happier-dev/plugin-sdk/scm';
import { defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import { TriageConfiguredSourceCredentialInstanceV1Schema, TriageSourceEntryLocalRefV1Schema } from '@happier-dev/triage-protocol/v1';

/** Private viewer preferences are separate from repository mutation capabilities. */
export const GITHUB_FILE_VIEWED_ACTION_IDS_V1 = Object.freeze({
  read: 'triage/read-github-file-viewed', set: 'github/pull-request/file-viewed-set',
});
const entry = { v: defineProtocolLiteral(1), instance: TriageConfiguredSourceCredentialInstanceV1Schema,
  localRef: TriageSourceEntryLocalRefV1Schema, routingToken: defineProtocolString({ minLength: 1 }) };
export const GithubFileViewedReadInputV1Schema = defineProtocolObject(entry, { policy: 'closed' });
export const GithubFileViewedSetInputV1Schema = defineProtocolObject({ ...entry,
  path: defineProtocolString({ minLength: 1 }), viewed: defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]),
}, { policy: 'closed' });
export { ScmFileViewedReadResultV1Schema, ScmFileViewedSetResultV1Schema };
