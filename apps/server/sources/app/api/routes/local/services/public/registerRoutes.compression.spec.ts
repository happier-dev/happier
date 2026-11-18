import Fastify from 'fastify';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type {
  LocalServicePublicExposureV1,
  LocalServicePublicPreviewSnapshotV1,
} from '@happier-dev/protocol';
import { enableApiCompression } from '@/app/api/utils/enableApiCompression';
import { createLocalServicePreviewRuntime } from '@/app/local/services/preview/runtime';
import { registerLocalServicePublicRoutes } from './registerRoutes';

// Many retained exposures make a snapshot larger than the compressor's largest synchronous
// threshold (64 KiB), so the streamed compression path is taken on every host.
const exposures: LocalServicePublicExposureV1[] = Array.from(
  { length: 200 },
  (_, index) => ({
    exposureId: `exposure-${index}`,
    previewId: 'preview_1',
    sessionId: 'session_1',
    machineId: 'machine_1',
    mode: 'people',
    audience: [{ kind: 'account', accountId: 'friend' }],
    state: 'revoked',
    publicUrl: `https://app.happier.test/preview-link/exposure-${index}`,
    issuedAt: 1,
    expiresAt: 2,
    revokedAt: 2,
    auditEventIds: [`audit-${index}`],
    rateLimitProfileId: 'default',
  }),
);

const snapshot: LocalServicePublicPreviewSnapshotV1 = {
  v: 1,
  machineId: 'machine_1',
  sessionId: 'session_1',
  generatedAt: 3,
  refreshState: 'idle',
  policy: {
    enabled: true,
    allowedModes: ['people'],
    dnsTlsRequired: true,
    auditRequired: true,
    rateLimitProfileIds: ['default'],
  },
  exposures,
  diagnostics: [],
};

describe('local service public control routes behind API compression', () => {
  it('delivers a large compressed status snapshot instead of an empty body', async () => {
    const app = Fastify();
    try {
      await enableApiCompression(app);
      // The authentication boundary: a signed-in person.
      app.decorate(
        'authenticate',
        async (request: {
          userId?: string;
          authAuthority?: string;
          authTokenKind?: string;
        }) => {
          request.userId = 'user_1';
          request.authAuthority = 'present_user';
          request.authTokenKind = 'account';
        },
      );
      const runtime = createLocalServicePreviewRuntime({
        tokenSecret: 'public-route-test-secret',
        publicBaseUrl: 'https://app.happier.test',
        hostOriginBaseDomain: 'preview.happier.test',
      });
      registerLocalServicePublicRoutes(app as never, {
        retainMachineAccess: runtime.retainMachineAccess,
        resolvePreview: () => null,
        createExposure: () => ({ ok: false, reasonCode: 'invalid_policy' }),
        revokeExposure: () => ({ ok: true }),
        validateAccess: () => ({ ok: false, reasonCode: 'exposure_not_found' }),
        authorizeSessionAccess: async () => true,
        getStatus: () => snapshot,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/v1/local-services/public/status',
        headers: { 'accept-encoding': 'gzip' },
        payload: { machineId: 'machine_1', sessionId: 'session_1' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-encoding']).toBe('gzip');
      expect(JSON.parse(gunzipSync(response.rawPayload).toString())).toEqual({
        protocolVersion: 1,
        snapshot,
      });
    } finally {
      await app.close();
    }
  });
});
