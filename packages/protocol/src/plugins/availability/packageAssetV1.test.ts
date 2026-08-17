import { describe, expect, it } from 'vitest';

import {
  createPackageAssetArchiveV1,
  openPackageAssetArchiveV1,
} from './packageAssetV1.js';

function manifest(resources: readonly Record<string, unknown>[]): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id: 'com.acme.fixture',
    version: '1.2.3',
    displayName: 'Fixture',
    engines: { happier: '^1.0.0' },
    runtime: { apiVersion: 1 },
    contributes: { resources },
  };
}

describe('Package Asset archive v1', () => {
  it('admits only manifest-declared packaged assets in canonical order and opens only against an external descriptor', () => {
    const archive = createPackageAssetArchiveV1({
      manifest: manifest([
        { id: 'template', kind: 'template', path: 'templates/start.txt', contentType: 'text/plain' },
        { id: 'zeta', kind: 'asset', path: 'assets/zeta.png', contentType: 'image/png' },
        { id: 'live', source: 'dynamic', kind: 'asset', contentType: 'image/png' },
        { id: 'alpha', kind: 'asset', path: 'assets/alpha.svg', contentType: 'image/svg+xml' },
      ]),
      files: [
        { path: 'assets/zeta.png', bytes: new Uint8Array([9, 8, 7]) },
        { path: 'templates/start.txt', bytes: new Uint8Array([1]) },
        { path: 'assets/alpha.svg', bytes: new Uint8Array([4, 5]) },
      ],
    });

    expect(archive).not.toBeNull();
    expect(archive?.descriptor.resources).toEqual([
      expect.objectContaining({
        resourceId: 'alpha',
        path: 'assets/alpha.svg',
        mimeType: 'image/svg+xml',
        byteSize: 2,
      }),
      expect.objectContaining({
        resourceId: 'zeta',
        path: 'assets/zeta.png',
        mimeType: 'image/png',
        byteSize: 3,
      }),
    ]);
    expect(archive?.body.resources.map((resource) => resource.resourceId)).toEqual(['alpha', 'zeta']);

    expect(openPackageAssetArchiveV1({
      expectedDescriptor: archive!.descriptor,
      header: archive!.header,
      body: archive!.body,
    })).toEqual({
      resources: new Map([
        ['alpha', new Uint8Array([4, 5])],
        ['zeta', new Uint8Array([9, 8, 7])],
      ]),
    });
    expect(openPackageAssetArchiveV1({
      expectedDescriptor: {
        ...archive!.descriptor,
        archiveDigestSha256: `sha256:${'0'.repeat(64)}`,
      },
      header: archive!.header,
      body: archive!.body,
    })).toBeNull();
    expect(openPackageAssetArchiveV1({
      expectedDescriptor: archive!.descriptor,
      header: archive!.header,
      body: {
        ...archive!.body,
        resources: [
          { ...archive!.body.resources[0]!, bytesBase64: 'AAA=' },
          archive!.body.resources[1]!,
        ],
      },
    })).toBeNull();
  });

  it('refuses a manifest asset path outside the portable package-relative ABI', () => {
    expect(createPackageAssetArchiveV1({
      manifest: manifest([
        { id: 'outside', kind: 'asset', path: '../outside.png', contentType: 'image/png' },
      ]),
      files: [{ path: '../outside.png', bytes: new Uint8Array([1]) }],
    })).toBeNull();
  });
});
