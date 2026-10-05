import {
  QualifiedConnectedAccountGroupCreateV4Schema,
  QualifiedConnectedAccountGroupPatchV4Schema,
  QualifiedConnectedAccountGroupDeleteV4Schema,
  QualifiedConnectedAccountGroupRefSchema,
  QualifiedConnectedAccountGroupMemberMutationV4Schema,
  QualifiedConnectedAccountGroupMemberDeleteV4Schema,
} from './qualifiedConnectedAccountsV4.js';
import { encodeQualifiedConnectedAccountV4StructuredQueryValue } from './qualifiedConnectedAccountsV4QueryCodec.js';

/** The existing qualified pool HTTP contract, shared by app adapters and Actions. */
export function buildQualifiedConnectedAccountGroupMutationRequestV4(
  operation: 'create' | 'patch' | 'delete' | 'addMember' | 'patchMember' | 'removeMember',
  input: unknown,
): Readonly<{ method: 'POST' | 'PATCH' | 'DELETE'; path: string; body?: unknown }> {
  switch (operation) {
    case 'create':
      return { method: 'POST', path: '/v4/connect/qualified/groups', body: QualifiedConnectedAccountGroupCreateV4Schema.parse(input) };
    case 'patch':
      return { method: 'PATCH', path: '/v4/connect/qualified/group', body: QualifiedConnectedAccountGroupPatchV4Schema.parse(input) };
    case 'addMember':
      return { method: 'POST', path: '/v4/connect/qualified/group/members', body: QualifiedConnectedAccountGroupMemberMutationV4Schema.parse(input) };
    case 'patchMember':
      return { method: 'PATCH', path: '/v4/connect/qualified/group/member', body: QualifiedConnectedAccountGroupMemberMutationV4Schema.parse(input) };
    case 'removeMember': {
      const body = QualifiedConnectedAccountGroupMemberDeleteV4Schema.parse(input);
      const mutation = encodeURIComponent(encodeQualifiedConnectedAccountV4StructuredQueryValue(QualifiedConnectedAccountGroupMemberDeleteV4Schema, body));
      return { method: 'DELETE', path: `/v4/connect/qualified/group/member?mutation=${mutation}` };
    }
    case 'delete': {
      const mutation = QualifiedConnectedAccountGroupDeleteV4Schema.parse(input);
      const query = new URLSearchParams({
        group: encodeQualifiedConnectedAccountV4StructuredQueryValue(QualifiedConnectedAccountGroupRefSchema, mutation.group),
        expectedIncarnation: mutation.expectedIncarnation,
        expectedGeneration: String(mutation.expectedGeneration),
      });
      if (mutation.expectedRuntimeStateRevision !== undefined) query.set('expectedRuntimeStateRevision', String(mutation.expectedRuntimeStateRevision));
      return { method: 'DELETE', path: `/v4/connect/qualified/group?${query.toString()}` };
    }
  }
}
