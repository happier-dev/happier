import { describe, expect, it } from 'vitest';

import {
  PluginInstallationManifestPublisherProofV1Schema,
  createPluginInstallationManifestPublisherSigningInputV1,
  stringifyPluginInstallationManifestCanonicalJsonV1,
} from '../../index.js';

describe('plugin installation manifest contracts', () => {
  it('keeps publisher signing identity strict and signature-free', () => {
    const proof = {
      v: 1,
      alg: 'ed25519-machine-installation-v1',
      machineId: 'machine_1',
      installationId: 'install_1',
      issuedAt: 1,
      nonce: 'nonce_1',
      method: 'POST',
      path: '/v1/plugins/permissions/grants/request',
      bodySha256Base64Url: 'body-digest',
      signatureBase64Url: 'signature',
    } as const;

    expect(PluginInstallationManifestPublisherProofV1Schema.parse(proof)).toEqual(proof);
    expect(PluginInstallationManifestPublisherProofV1Schema.safeParse({
      ...proof,
      xFutureManifestRoot: { preservedByManifestSchema: true },
    }).success).toBe(false);

    const signingInput = new TextDecoder().decode(createPluginInstallationManifestPublisherSigningInputV1({
      proof: {
        v: proof.v,
        alg: proof.alg,
        machineId: proof.machineId,
        installationId: proof.installationId,
        issuedAt: proof.issuedAt,
        nonce: proof.nonce,
        method: proof.method,
        path: proof.path,
        bodySha256Base64Url: proof.bodySha256Base64Url,
      },
    }));

    expect(signingInput).toContain('happier.pluginInstallationManifestPublisher.v1\u0000');
    expect(signingInput).toContain('"bodySha256Base64Url":"body-digest"');
    expect(signingInput).not.toContain('signatureBase64Url');
    expect(signingInput).not.toContain('xFutureManifestRoot');
  });

  it('canonicalizes hash inputs deterministically without adding undefined fields', () => {
    expect(stringifyPluginInstallationManifestCanonicalJsonV1({
      z: undefined,
      b: 2,
      a: {
        d: Number.NaN,
        c: true,
      },
    })).toBe('{"a":{"c":true,"d":null},"b":2}');
  });
});
