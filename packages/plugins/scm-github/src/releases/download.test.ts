import { describe, expect, it } from 'vitest';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { FileDownloadResultV1ProtocolSchema, type FileDownloadResultV1 } from '@happier-dev/plugin-sdk/protocol';
import { executeGithubReleaseOperationV1 } from './operations.js';
import { createStubGithubTransport } from '../triage/testkit/githubTriage.test-support.js';

const repository = { kind: 'github', deployment: 'https://github.com', repository: 'acme/widgets' } as const;
const input = { repository, repositoryId: '42', releaseId: '7', assetId: '9', destination: { destinationId: 'opaque-receiver' } };
const bytes = new Uint8Array([0, 255, 128, 1]);
const asset = { id: 9, name: 'release.zip', label: null, content_type: 'application/zip', size: bytes.length, state: 'uploaded' };
const receipt: FileDownloadResultV1 = { success: true, status: 'accepted', operationId: 'host-operation', destinationId: input.destination.destinationId,
  prepared: { transferId: 'host-transfer', name: asset.name, sizeBytes: bytes.length,
    manifestHash: `sha256:${'a'.repeat(64)}`, expiresAt: 1, endpointCandidates: [] } };
function harness(options: { redirect?: boolean; member?: boolean; size?: number; publicationError?: boolean; signal?: AbortSignal } = {}) {
  const published: Array<Parameters<PluginInvocationContext['services']['fs']['prepareDownload']>[0]> = [];
  const h = createStubGithubTransport({ signal: options.signal,
    nativeMaterialization: { kind: 'httpHeaders', headers: { authorization: 'Bearer fixture' } },
    respond: request => {
      const url = new URL(request.url);
      if (url.pathname === '/repos/acme/widgets') return { status: 200, body: { id: 42, full_name: 'acme/widgets', private: true } };
      if (url.pathname === '/repos/acme/widgets/releases/7') return { status: 200, body: {
        id: 7, tag_name: 'v7', target_commitish: 'main', name: 'Release', body: 'Notes', draft: true, prerelease: false,
        created_at: '2026-10-24T10:00:00Z', published_at: null, html_url: 'https://github.com/acme/widgets/releases/7', assets: [],
      } };
      if (url.pathname === '/repos/acme/widgets/releases/7/assets') return { status: 200, body: options.member === false ? [] : [{ ...asset, size: options.size ?? asset.size }] };
      if (url.pathname === '/repos/acme/widgets/releases/assets/9') return options.redirect
        ? { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/download/opaque?signature=fixture' } }
        : { status: 200, rawBody: bytes };
      if (url.origin === 'https://release-assets.githubusercontent.com') return { status: 200, rawBody: bytes };
      throw new Error('Unexpected provider request');
    } });
  const context: PluginInvocationContext = { ...h.context, services: { ...h.context.services, fs: { ...h.context.services.fs,
    async prepareDownload(acquired) {
      published.push(acquired);
      if (options.publicationError) throw new Error('Publication response lost');
      return receipt;
    },
  } } };
  return { ...h, context, published };
}

describe('release asset acquisition consumes canonical file custody', () => {
  it.each([false, true])('passes binary bytes and the opaque destination through the canonical receipt (%s redirect)', async redirect => {
    const h = harness({ redirect });
    expect(await executeGithubReleaseOperationV1('downloadAsset', input, h.context)).toEqual(receipt);
    expect(FileDownloadResultV1ProtocolSchema.safeParse(receipt).success).toBe(true);
    expect(h.published).toEqual([{ name: asset.name, bytes, destination: input.destination }]);
    expect(h.requests.filter(request => request.url.includes('/releases/assets/9'))).toHaveLength(1);
    expect(h.requests.find(request => request.url.includes('/releases/assets/9'))?.headers.Accept).toBe('application/octet-stream');
    const storage = h.requests.find(request => new URL(request.url).origin === 'https://release-assets.githubusercontent.com');
    if (redirect) expect(Object.keys(storage!.headers).some(name => name.toLowerCase() === 'authorization')).toBe(false);
    expect(JSON.stringify(receipt)).not.toContain('signature=');
  });

  it('refuses a non-member asset or wrong byte size before publishing to the receiver', async () => {
    for (const options of [{ member: false }, { size: 5 }]) {
      const h = harness(options);
      expect(await executeGithubReleaseOperationV1('downloadAsset', input, h.context)).toMatchObject({ success: false, status: 'failed',
        errorCode: 'member' in options ? 'github_release_asset_not_found' : 'github_release_asset_size_changed' });
      expect(h.published).toHaveLength(0);
      if ('member' in options) expect(h.requests.some(request => request.url.includes('/releases/assets/9'))).toBe(false);
    }
  });

  it('does not reinterpret uncertain publication as a safe acquisition failure or replay it', async () => {
    const h = harness({ publicationError: true });
    await expect(executeGithubReleaseOperationV1('downloadAsset', input, h.context)).rejects.toThrow('Publication response lost');
    expect(h.published).toHaveLength(1);
  });
});
