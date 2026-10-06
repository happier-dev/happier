import axios from 'axios';
import { CreateOrUpdateSessionOrganizationFolderRequestSchema, CreateOrUpdateSessionOrganizationFolderResponseSchema, CreateOrUpdateSessionOrganizationTagRequestSchema, CreateOrUpdateSessionOrganizationTagResponseSchema } from '@happier-dev/protocol/sessions/organization/mutations';
import { SessionOrganizationSnapshotResponseSchema } from '@happier-dev/protocol/sessions/organization/snapshot';
import { prepareSessionOrganizationDisplayEnvelopeForAccountModeV1, projectSessionOrganizationDisplayEnvelopeForReadV1 } from '@happier-dev/protocol/sessions/organization/content';
import type { AccountScopedCryptoMaterial, HomeDomainActionIdV1, SessionOrganizationContentEnvelope } from '@happier-dev/protocol';
import type { StoredCredentials } from '@/persistence';
import { getRandomBytes } from '@/api/encryption';
import { readAccountEncryptionModeOnce } from '@/api/client/accountEncryptionMode';
import { configuration } from '@/configuration';

/** Host transport/key custody only. Organization display policy lives in protocol. */
export async function captureSessionOrganizationDisplayHost(params: Readonly<{
  token: string;
  credentials?: StoredCredentials;
  serverHttpBaseUrl: string;
  isCurrent?: () => boolean | Promise<boolean>;
  signal?: AbortSignal;
}>) {
  const assertCurrent = async () => {
    if (params.signal?.aborted || (params.isCurrent && !await params.isCurrent())) {
      throw Object.assign(new Error('action_account_scope_changed'), { code: 'action_account_scope_changed' });
    }
  };
  await assertCurrent();
  const mode = await readAccountEncryptionModeOnce({ request: () => axios.get<unknown>(
    `${params.serverHttpBaseUrl}/v1/account/encryption`, {
      headers: { Authorization: `Bearer ${params.token}` },
      timeout: configuration.sessionControlHttpTimeoutMs,
      ...(params.signal ? { signal: params.signal } : {}), validateStatus: () => true,
    }) });
  await assertCurrent();
  if (mode.kind !== 'resolved') throw Object.assign(new Error('account_encryption_mode_unavailable'), {
    code: 'account_encryption_mode_unavailable',
  });
  const material: AccountScopedCryptoMaterial | null = mode.mode === 'e2ee'
    && params.credentials?.token === params.token ? params.credentials.encryption : null;
  const prepare = (envelope: SessionOrganizationContentEnvelope | null) =>
    prepareSessionOrganizationDisplayEnvelopeForAccountModeV1({ envelope, accountMode: mode.mode,
      material, randomBytes: getRandomBytes });
  const project = (envelope: SessionOrganizationContentEnvelope | null) => {
    if (envelope && envelope.t !== (mode.mode === 'e2ee' ? 'encrypted' : 'plain')) {
      throw Object.assign(new Error('storage_mode_mismatch'), { code: 'storage_mode_mismatch' });
    }
    return projectSessionOrganizationDisplayEnvelopeForReadV1({ envelope, material });
  };
  return {
    assertCurrent,
    prepareInput: (actionId: HomeDomainActionIdV1, input: unknown): unknown => {
      if (actionId === 'session.folders.create' || actionId === 'session.folders.rename') {
        const parsed = CreateOrUpdateSessionOrganizationFolderRequestSchema.parse(input);
        return { ...parsed, display: prepare(parsed.display) };
      }
      if (actionId === 'session.tags.create' || actionId === 'session.tags.rename') {
        const parsed = CreateOrUpdateSessionOrganizationTagRequestSchema.parse(input);
        return { ...parsed, display: prepare(parsed.display) };
      }
      return input;
    },
    projectOutput: (actionId: HomeDomainActionIdV1, output: unknown): unknown => {
      if (actionId === 'session.folders.create' || actionId === 'session.folders.rename') {
        const { folder } = CreateOrUpdateSessionOrganizationFolderResponseSchema.parse(output);
        return { folder: { ...folder, display: folder.displayState ? folder.display : project(folder.display) } };
      }
      if (actionId === 'session.tags.create' || actionId === 'session.tags.rename') {
        const { tag } = CreateOrUpdateSessionOrganizationTagResponseSchema.parse(output);
        return { tag: { ...tag, display: tag.displayState ? tag.display : project(tag.display) } };
      }
      const { snapshot } = SessionOrganizationSnapshotResponseSchema.parse(output);
      return { snapshot: { ...snapshot,
        folders: snapshot.folders.map(row => ({ ...row, display: row.displayState ? row.display : project(row.display) })),
        tags: snapshot.tags.map(row => ({ ...row, display: row.displayState ? row.display : project(row.display) })),
        labels: snapshot.labels.map(row => ({ ...row, display: row.displayState ? row.display : project(row.display) })),
      } };
    },
  };
}
