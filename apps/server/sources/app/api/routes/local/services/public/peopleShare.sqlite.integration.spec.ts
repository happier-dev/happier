import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LocalServicePreviewResourceV1 } from '@happier-dev/protocol/local/services/preview/v1';
import {
  LocalServicePublicExposureV1Schema,
  LocalServicePublicPreviewAdmissionResponseV1Schema,
} from '@happier-dev/protocol/local/services/public/v1';
import { db } from '@/storage/db';
import { auth } from '@/app/auth/auth';
import type { Fastify } from '@/app/api/types';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import {
  createLightSqliteHarness,
  type LightSqliteHarness,
} from '@/testkit/lightSqliteHarness';
import { createLocalServicePublicRuntime } from '@/app/local/services/public/runtime';
import {
  isLocalServicePublicAudienceEligible,
  isLocalServicePublicAudienceMember,
} from '@/app/local/services/public/peopleAudience';
import { registerLocalServicePublicRoutes } from './registerRoutes';

const preview: LocalServicePreviewResourceV1 = {
  previewId: 'preview_people',
  sessionId: 'session_people',
  machineId: 'machine_a',
  owner: { kind: 'session', id: 'session_people' },
  target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
  initialPath: { pathname: '/', search: '' },
  display: { title: 'Web', addressLabel: '127.0.0.1:5173' },
  originMode: 'host',
};

/**
 * A shares one running Service with a Team. B (Team member, never admitted to A's Machine)
 * opens it signed in; C (outside the audience) and a signed-out browser do not; after revoke
 * B's next request is denied. Real bearer auth, real Team rows and the canonical membership
 * owner; only the Machine/daemon (the sharer's Service) and the upstream app are boundaries.
 */
describe('people Service preview share through real routes (SQLite)', () => {
  let harness: LightSqliteHarness;
  beforeAll(async () => {
    harness = await createLightSqliteHarness({
      tempDirPrefix: 'happier-preview-people-',
      initAuth: true,
    });
  }, 180_000);
  afterAll(async () => {
    await harness?.close();
  });

  it('admits a signed-in audience member without Machine access and nobody else, until revoke', async () => {
    const account = async () => {
      const row = await db.account.create({
        data: { encryptionMode: 'plain' },
      });
      const token = await auth.createToken(row.id, undefined, {
        kind: 'account',
        authority: 'present_user',
      });
      return { id: row.id, headers: { authorization: `Bearer ${token}` } };
    };
    const a = await account();
    const b = await account();
    const c = await account();
    const team = await db.team.create({ data: { name: 'Preview audience' } });
    await db.teamMembership.createMany({
      data: [
        { teamId: team.id, accountId: a.id, role: 'owner' },
        { teamId: team.id, accountId: b.id, role: 'member' },
      ],
    });
    // Only a declared Service consults the Machine boundary; this share is a Session preview.
    let previewRegistered = true;
    const upstreamHits: string[] = [];
    const runtime = createLocalServicePublicRuntime({
      publicBaseUrl: 'https://home.example.test',
      hostOriginBaseDomain: 'preview.example.test',
      tokenSecret: 'fixture-key',
      policy: {
        enabled: true,
        allowedModes: ['people', 'secret_link'],
        maxTtlMs: 60_000,
        dnsTlsRequired: false,
        auditRequired: true,
        rateLimitProfileIds: ['default'],
      },
      generateExposureId: () => 'people-1',
      allowTestDevAuditSink: true,
      recordAuditEvent: () => {},
      checkRateLimit: () => true,
      resolvePreview: () => (previewRegistered ? preview : null),
      peopleAdmission: {
        isInAudience: isLocalServicePublicAudienceMember,
        sharerHoldsService: async () => true,
      },
    });
    const register = (app: Fastify) =>
      registerLocalServicePublicRoutes(app, {
        ...runtime,
        retainMachineAccess: () => ({
          signal: new AbortController().signal,
          release: () => {},
        }),
        resolvePreview: () => (previewRegistered ? preview : null),
        getStatus: runtime.getSnapshot,
        // The Session belongs to A; this is the existing control-plane owner, not under test.
        authorizeSessionAccess: ({ userId }) => userId === a.id,
        validateAudience: isLocalServicePublicAudienceEligible,
        resolveLandingBaseUrl: async () => 'https://app.example.test',
        dnsTlsValid: true,
        proxyHttp: async ({ request, response }) => {
          upstreamHits.push(request.path);
          response.writeHead(200, 'OK', { 'content-type': 'text/plain' });
          response.end();
          return { ok: true };
        },
      });
    await withAuthenticatedTestApp(
      register,
      async (app: Fastify) => {
        const created = await app.inject({
          method: 'POST',
          url: '/v1/local-services/public',
          headers: a.headers,
          payload: {
            machineId: preview.machineId,
            sessionId: preview.sessionId,
            previewId: preview.previewId,
            mode: 'people',
            audience: [{ kind: 'team', teamId: team.id }],
            ttlMs: 60_000,
            confirmation: { acknowledged: true },
          },
        });
        expect(created.statusCode).toBe(201);
        const exposure = LocalServicePublicExposureV1Schema.parse(
          created.json().exposure,
        );
        expect(exposure.publicUrl).toBe(
          'https://app.example.test/preview-link/people-1',
        );

        // An audience naming someone the sharer cannot share with is refused at create.
        const outsiderShare = await app.inject({
          method: 'POST',
          url: '/v1/local-services/public',
          headers: a.headers,
          payload: {
            machineId: preview.machineId,
            sessionId: preview.sessionId,
            previewId: preview.previewId,
            mode: 'people',
            audience: [{ kind: 'account', accountId: c.id }],
            ttlMs: 60_000,
            confirmation: { acknowledged: true },
          },
        });
        expect(outsiderShare.json()).toEqual({
          error: 'public_preview_denied',
          reasonCode: 'audience_not_eligible',
        });

        const admit = (headers?: Record<string, string>) =>
          app.inject({
            method: 'POST',
            url: '/v1/local-services/public-admission/people-1',
            ...(headers ? { headers } : {}),
          });
        const host = 'people-1.preview.example.test';
        const dataPlane = (cookie?: string) =>
          app.inject({
            method: 'GET',
            url: '/v1/local-services/public/people-1/',
            headers: { host, ...(cookie ? { cookie } : {}) },
          });

        // Signed out: no admission, and the preview origin admits nothing without it.
        expect((await admit()).statusCode).toBe(401);
        expect((await dataPlane()).json()).toEqual({
          error: 'public_preview_access_denied',
          reasonCode: 'admission_required',
        });

        // Outside the audience: a typed no-access answer.
        const denied = await admit(c.headers);
        expect(denied.statusCode).toBe(403);
        expect(denied.json()).toEqual({
          error: 'public_preview_admission_denied',
          reasonCode: 'not_in_audience',
        });

        // B has no grant or admission on machine_a; Team membership is the whole decision.
        expect(
          await db.machineAccountGrant.count({ where: { accountId: b.id } }),
        ).toBe(0);
        const admitted = await admit(b.headers);
        expect(admitted.statusCode).toBe(200);
        const admissionUrl = new URL(
          LocalServicePublicPreviewAdmissionResponseV1Schema.parse(
            admitted.json(),
          ).admissionUrl,
        );
        expect(admissionUrl.host).toBe(host);
        const exchanged = await app.inject({
          method: 'GET',
          url: `${admissionUrl.pathname}${admissionUrl.search}`,
          headers: { host },
        });
        expect(exchanged.statusCode).toBe(303);
        expect(String(exchanged.headers.location)).not.toContain('publicToken');
        const cookie = String(exchanged.headers['set-cookie']).split(';')[0]!;
        // The admission URL is one-use.
        expect(
          (
            await app.inject({
              method: 'GET',
              url: `${admissionUrl.pathname}${admissionUrl.search}`,
              headers: { host },
            })
          ).statusCode,
        ).toBe(403);

        expect((await dataPlane(cookie)).statusCode).toBe(200);
        expect(upstreamHits).toHaveLength(1);

        // A Session preview stands on its current registration: once it is gone, admission refuses.
        previewRegistered = false;
        expect((await admit(b.headers)).json()).toEqual({
          error: 'public_preview_admission_denied',
          reasonCode: 'service_unavailable',
        });
        previewRegistered = true;

        const revoked = await app.inject({
          method: 'DELETE',
          url: '/v1/local-services/public/people-1',
          headers: a.headers,
          payload: {
            machineId: preview.machineId,
            sessionId: preview.sessionId,
            previewId: preview.previewId,
            exposureId: 'people-1',
          },
        });
        expect(revoked.statusCode).toBe(200);
        expect((await dataPlane(cookie)).json()).toEqual({
          error: 'public_preview_access_denied',
          reasonCode: 'revoked',
        });
        expect(upstreamHits).toHaveLength(1);
      },
      { authentication: 'real' },
    );
  });
});
