import {
  QualifiedConnectedAccountConfigurationSnapshotV4Schema,
  QualifiedConnectedAccountConfigurationTargetV4Schema,
  QualifiedConnectedAccountCredentialSnapshotV4Schema,
  QualifiedConnectedAccountGroupActiveAccountV4Schema,
  QualifiedConnectedAccountGroupCreateV4Schema,
  QualifiedConnectedAccountGroupListResponseV4Schema,
  QualifiedConnectedAccountGroupMemberDeleteV4Schema,
  QualifiedConnectedAccountGroupMemberMutationV4Schema,
  QualifiedConnectedAccountGroupPatchV4Schema,
  QualifiedConnectedAccountGroupRefSchema,
  QualifiedConnectedAccountGroupResponseV4Schema,
  QualifiedConnectedAccountQuotaResponseV4Schema,
  QualifiedConnectedAccountRefSchema,
  QualifiedConnectedAccountServiceRefSchema,
  encodeQualifiedConnectedAccountV4StructuredQueryValue,
  type QualifiedConnectedAccountConfigurationSnapshotV4,
  type QualifiedConnectedAccountCredentialSnapshotV4,
  type QualifiedConnectedAccountGroupRef,
  type QualifiedConnectedAccountGroupV4,
  type QualifiedConnectedAccountRef,
  type QualifiedConnectedAccountServiceRef,
} from '@happier-dev/protocol';
import type { z } from 'zod';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import {
  serverFetch,
  type ExpectedActiveServerFetchBasis,
} from '@/sync/http/client';
import { HappyError } from '@/utils/errors/errors';
import { backoff } from '@/utils/timing/time';
import { throwConnectedServiceApiError } from './connectedServiceApiError';

function headers(credentials: AuthCredentials): HeadersInit {
  return {
    Authorization: `Bearer ${credentials.token}`,
    'Content-Type': 'application/json',
  };
}

async function readQualifiedSnapshot<T>(params: Readonly<{
  credentials: AuthCredentials;
  path: string;
  parse(value: unknown): T;
  expectedActiveServer?: ExpectedActiveServerFetchBasis;
}>): Promise<T> {
  return await backoff(async () => {
    const response = await serverFetch(
      params.path,
      {
        method: 'GET',
        headers: headers(params.credentials),
      },
      {
        includeAuth: false,
        ...(params.expectedActiveServer
          ? { expectedActiveServer: params.expectedActiveServer }
          : {}),
      },
    );
    if (!response.ok) {
      await throwConnectedServiceApiError(response);
    }
    const json: unknown = await response.json().catch(() => null);
    try {
      return params.parse(json);
    } catch {
      throw new HappyError(
        'invalid response',
        false,
        { status: response.status, kind: 'server' },
      );
    }
  });
}

async function mutateQualifiedSnapshot<T>(params: Readonly<{
  credentials: AuthCredentials;
  path: string;
  method: 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  parse(value: unknown): T;
  expectedActiveServer?: ExpectedActiveServerFetchBasis;
}>): Promise<T> {
  const response = await serverFetch(
    params.path,
    {
      method: params.method,
      headers: headers(params.credentials),
      ...(params.body === undefined
        ? {}
        : { body: JSON.stringify(params.body) }),
    },
    {
      includeAuth: false,
      ...(params.expectedActiveServer
        ? { expectedActiveServer: params.expectedActiveServer }
        : {}),
    },
  );
  if (!response.ok) {
    await throwConnectedServiceApiError(response);
  }
  const json: unknown = await response.json().catch(() => null);
  try {
    return params.parse(json);
  } catch {
    throw new HappyError(
      'invalid response',
      false,
      { status: response.status, kind: 'server' },
    );
  }
}

function structuredQuery<T>(
  key: string,
  schema: z.ZodType<T>,
  value: T,
): string {
  const encoded = encodeURIComponent(
    encodeQualifiedConnectedAccountV4StructuredQueryValue(schema, value),
  );
  return `${key}=${encoded}`;
}

export async function getQualifiedConnectedAccountCredentialV4(
  credentials: AuthCredentials,
  ref: QualifiedConnectedAccountRef,
): Promise<QualifiedConnectedAccountCredentialSnapshotV4> {
  const encoded = encodeURIComponent(
    encodeQualifiedConnectedAccountV4StructuredQueryValue(
      QualifiedConnectedAccountRefSchema,
      ref,
    ),
  );
  return await readQualifiedSnapshot({
    credentials,
    path: `/v4/connect/qualified/credential?ref=${encoded}`,
    parse: (value) =>
      QualifiedConnectedAccountCredentialSnapshotV4Schema.parse(value),
  });
}

export async function listQualifiedConnectedAccountGroupsV4(
  credentials: AuthCredentials,
  params: Readonly<{ service: QualifiedConnectedAccountServiceRef }>,
): Promise<{ groups: QualifiedConnectedAccountGroupV4[] }> {
  return await readQualifiedSnapshot({
    credentials,
    path: `/v4/connect/qualified/groups?${structuredQuery(
      'service',
      QualifiedConnectedAccountServiceRefSchema,
      params.service,
    )}`,
    parse: (value) =>
      QualifiedConnectedAccountGroupListResponseV4Schema.parse(value),
  });
}

export async function getQualifiedConnectedAccountGroupV4(
  credentials: AuthCredentials,
  params: Readonly<{
    group: QualifiedConnectedAccountGroupRef;
    expectedRuntimeStateRevision?: number;
  }>,
): Promise<{ group: QualifiedConnectedAccountGroupV4 }> {
  const query = new URLSearchParams();
  query.set(
    'group',
    encodeQualifiedConnectedAccountV4StructuredQueryValue(
      QualifiedConnectedAccountGroupRefSchema,
      params.group,
    ),
  );
  if (params.expectedRuntimeStateRevision !== undefined) {
    query.set(
      'expectedRuntimeStateRevision',
      String(params.expectedRuntimeStateRevision),
    );
  }
  return await readQualifiedSnapshot({
    credentials,
    path: `/v4/connect/qualified/group?${query.toString()}`,
    parse: (value) =>
      QualifiedConnectedAccountGroupResponseV4Schema.parse(value),
  });
}

export async function createQualifiedConnectedAccountGroupV4(
  credentials: AuthCredentials,
  params: z.input<typeof QualifiedConnectedAccountGroupCreateV4Schema>,
): Promise<{ group: QualifiedConnectedAccountGroupV4 }> {
  const body = QualifiedConnectedAccountGroupCreateV4Schema.parse(params);
  return await mutateQualifiedSnapshot({
    credentials,
    path: '/v4/connect/qualified/groups',
    method: 'POST',
    body,
    parse: (value) =>
      QualifiedConnectedAccountGroupResponseV4Schema.parse(value),
  });
}

export async function patchQualifiedConnectedAccountGroupV4(
  credentials: AuthCredentials,
  params: z.input<typeof QualifiedConnectedAccountGroupPatchV4Schema>,
): Promise<{ group: QualifiedConnectedAccountGroupV4 }> {
  const body = QualifiedConnectedAccountGroupPatchV4Schema.parse(params);
  return await mutateQualifiedSnapshot({
    credentials,
    path: '/v4/connect/qualified/group',
    method: 'PATCH',
    body,
    parse: (value) =>
      QualifiedConnectedAccountGroupResponseV4Schema.parse(value),
  });
}

export async function deleteQualifiedConnectedAccountGroupV4(
  credentials: AuthCredentials,
  params: Readonly<{
    group: QualifiedConnectedAccountGroupRef;
    expectedRuntimeStateRevision?: number;
  }>,
): Promise<boolean> {
  const query = new URLSearchParams();
  query.set(
    'group',
    encodeQualifiedConnectedAccountV4StructuredQueryValue(
      QualifiedConnectedAccountGroupRefSchema,
      params.group,
    ),
  );
  if (params.expectedRuntimeStateRevision !== undefined) {
    query.set(
      'expectedRuntimeStateRevision',
      String(params.expectedRuntimeStateRevision),
    );
  }
  await mutateQualifiedSnapshot({
    credentials,
    path: `/v4/connect/qualified/group?${query.toString()}`,
    method: 'DELETE',
    parse: (value) => {
      if (
        typeof value !== 'object'
        || value === null
        || (value as { success?: unknown }).success !== true
      ) {
        throw new Error('invalid response');
      }
      return true;
    },
  });
  return true;
}

export async function addQualifiedConnectedAccountGroupMemberV4(
  credentials: AuthCredentials,
  params: z.input<
    typeof QualifiedConnectedAccountGroupMemberMutationV4Schema
  >,
): Promise<{ group: QualifiedConnectedAccountGroupV4 }> {
  const body =
    QualifiedConnectedAccountGroupMemberMutationV4Schema.parse(params);
  return await mutateQualifiedSnapshot({
    credentials,
    path: '/v4/connect/qualified/group/members',
    method: 'POST',
    body,
    parse: (value) =>
      QualifiedConnectedAccountGroupResponseV4Schema.parse(value),
  });
}

export async function patchQualifiedConnectedAccountGroupMemberV4(
  credentials: AuthCredentials,
  params: z.input<
    typeof QualifiedConnectedAccountGroupMemberMutationV4Schema
  >,
): Promise<{ group: QualifiedConnectedAccountGroupV4 }> {
  const body =
    QualifiedConnectedAccountGroupMemberMutationV4Schema.parse(params);
  return await mutateQualifiedSnapshot({
    credentials,
    path: '/v4/connect/qualified/group/member',
    method: 'PATCH',
    body,
    parse: (value) =>
      QualifiedConnectedAccountGroupResponseV4Schema.parse(value),
  });
}

export async function removeQualifiedConnectedAccountGroupMemberV4(
  credentials: AuthCredentials,
  params: z.input<
    typeof QualifiedConnectedAccountGroupMemberDeleteV4Schema
  >,
): Promise<{ group: QualifiedConnectedAccountGroupV4 }> {
  const mutation =
    QualifiedConnectedAccountGroupMemberDeleteV4Schema.parse(params);
  return await mutateQualifiedSnapshot({
    credentials,
    path: `/v4/connect/qualified/group/member?${structuredQuery(
      'mutation',
      QualifiedConnectedAccountGroupMemberDeleteV4Schema,
      mutation,
    )}`,
    method: 'DELETE',
    parse: (value) =>
      QualifiedConnectedAccountGroupResponseV4Schema.parse(value),
  });
}

export async function setQualifiedConnectedAccountGroupActiveAccountV4(
  credentials: AuthCredentials,
  params: z.input<
    typeof QualifiedConnectedAccountGroupActiveAccountV4Schema
  >,
): Promise<{ group: QualifiedConnectedAccountGroupV4 }> {
  const body =
    QualifiedConnectedAccountGroupActiveAccountV4Schema.parse(params);
  return await mutateQualifiedSnapshot({
    credentials,
    path: '/v4/connect/qualified/group/active-account',
    method: 'POST',
    body,
    parse: (value) =>
      QualifiedConnectedAccountGroupResponseV4Schema.parse(value),
  });
}

export async function getQualifiedConnectedAccountQuotaV4(
  credentials: AuthCredentials,
  ref: QualifiedConnectedAccountRef,
  opts?: Readonly<{
    expectedActiveServer?: ExpectedActiveServerFetchBasis;
  }>,
): Promise<z.infer<typeof QualifiedConnectedAccountQuotaResponseV4Schema> | null> {
  try {
    return await readQualifiedSnapshot({
      credentials,
      path: `/v4/connect/qualified/quotas?${structuredQuery(
        'ref',
        QualifiedConnectedAccountRefSchema,
        ref,
      )}`,
      parse: (value) =>
        QualifiedConnectedAccountQuotaResponseV4Schema.parse(value),
      ...(opts?.expectedActiveServer
        ? { expectedActiveServer: opts.expectedActiveServer }
        : {}),
    });
  } catch (error) {
    if (
      error
      && typeof error === 'object'
      && (error as { code?: unknown }).code === 'connect_quotas_not_found'
    ) {
      return null;
    }
    throw error;
  }
}

export async function requestQualifiedConnectedAccountQuotaRefreshV4(
  credentials: AuthCredentials,
  ref: QualifiedConnectedAccountRef,
  opts?: Readonly<{
    expectedActiveServer?: ExpectedActiveServerFetchBasis;
  }>,
): Promise<void> {
  await mutateQualifiedSnapshot({
    credentials,
    path: '/v4/connect/qualified/quotas/refresh',
    method: 'POST',
    body: { ref },
    ...(opts?.expectedActiveServer
      ? { expectedActiveServer: opts.expectedActiveServer }
      : {}),
    parse: (value) => {
      if (
        typeof value !== 'object'
        || value === null
        || (value as { success?: unknown }).success !== true
      ) {
        throw new Error('invalid response');
      }
      return undefined;
    },
  });
}

export async function getQualifiedConnectedAccountConfigurationV4(
  credentials: AuthCredentials,
  ref: QualifiedConnectedAccountRef,
): Promise<QualifiedConnectedAccountConfigurationSnapshotV4> {
  const target = { kind: 'account' as const, ref };
  const encoded = encodeURIComponent(
    encodeQualifiedConnectedAccountV4StructuredQueryValue(
      QualifiedConnectedAccountConfigurationTargetV4Schema,
      target,
    ),
  );
  return await readQualifiedSnapshot({
    credentials,
    path: `/v4/connect/qualified/configuration?target=${encoded}`,
    parse: (value) =>
      QualifiedConnectedAccountConfigurationSnapshotV4Schema.parse(
        value,
      ),
  });
}
