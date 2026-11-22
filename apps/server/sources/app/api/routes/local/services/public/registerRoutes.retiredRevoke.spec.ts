import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { LocalServicePreviewResourceV1 } from '@happier-dev/protocol';
import { createLocalServicePreviewRuntime } from '@/app/local/services/preview/runtime';
import { createLocalServicePublicRuntime } from '@/app/local/services/public/runtime';
import {
  registerLocalServicePublicRoutes,
  type RegisterLocalServicePublicRoutesOptions,
} from './registerRoutes';

const serviceTarget = {
  kind: 'managed_service' as const,
  machineId: 'machine_1',
  managedServiceId: 'instance_1',
  cwd: '/workspace/app',
  declaration: {
    workspaceRefId: 'workspace_1',
    selection: { kind: 'manifest' as const, name: 'web' },
  },
};

function servicePreview(previewId: string): LocalServicePreviewResourceV1 {
  return {
    previewId,
    machineId: 'machine_1',
    owner: { kind: 'user', id: 'owner' },
    serviceTarget,
    target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
    initialPath: { pathname: '/', search: '' },
    display: { title: 'Web', addressLabel: '127.0.0.1:5173' },
    originMode: 'host',
  };
}

/**
 * Real Fastify control routes over the real public-exposure runtime. Only the
 * Machine's current-Service admission (a daemon round trip) is replaced: it
 * admits the Service owner while the preview's Service is live.
 */
async function createHome() {
  const serviceAccess: string[] = [];
  const previews = new Map<string, LocalServicePreviewResourceV1>();
  // A stopped Service keeps its preview registered; the Machine refuses admission for everyone.
  const stopped = new Set<string>();
  const app = Fastify({ logger: false });
  // The authenticated caller is a system boundary; the test names it per request.
  app.addHook('onRequest', async (request) => {
    Object.assign(request, { userId: String(request.headers['x-test-user'] ?? ''), authAuthority: 'present_user' });
  });
  app.decorate('authenticate', async () => {});
  let nextId = 0;
  const runtime = createLocalServicePublicRuntime({
    publicBaseUrl: 'https://app.happier.test',
    hostOriginBaseDomain: 'preview.happier.test',
    tokenSecret: 'fixture-key',
    policy: {
      enabled: true,
      allowedModes: ['secret_link'],
      maxTtlMs: 60_000,
      dnsTlsRequired: false,
      auditRequired: true,
      rateLimitProfileIds: ['default'],
    },
    generateExposureId: () => `exposure_${++nextId}`,
    allowTestDevAuditSink: true,
    recordAuditEvent: () => {},
    checkRateLimit: () => true,
    resolvePreview: (previewId) => previews.get(previewId) ?? null,
  });
  const options: RegisterLocalServicePublicRoutesOptions = {
    retainMachineAccess: createLocalServicePreviewRuntime({
      tokenSecret: 'fixture-key',
      publicBaseUrl: 'https://app.happier.test',
      hostOriginBaseDomain: 'preview.happier.test',
    }).retainMachineAccess,
    resolvePreview: (previewId) => previews.get(previewId) ?? null,
    getStatus: (request) => runtime.getSnapshot(request),
    createExposure: (input) => runtime.createExposure(input),
    resolveExposure: (exposureId) => runtime.resolveExposure(exposureId),
    revokeExposure: (exposureId, input) =>
      runtime.revokeExposure(exposureId, input),
    isServiceLinkPerson: (exposureId, accountId) =>
      runtime.isServiceLinkPerson(exposureId, accountId),
    validateAccess: (input) => runtime.validateAccess(input),
    authorizeServiceAccess: ({ userId, preview }) => {
      serviceAccess.push(userId);
      return (userId === 'owner' || userId === 'guest')
        && !stopped.has(preview.previewId)
        && previews.get(preview.previewId) === preview;
    },
  };
  registerLocalServicePublicRoutes(app as never, options);
  await app.ready();
  const share = (previewId: string, actorId = 'owner') => {
    const preview = servicePreview(previewId);
    previews.set(previewId, preview);
    const created = runtime.createExposure({
      preview,
      requestedMode: 'secret_link',
      requestedTtlMs: 60_000,
      actorId,
      sessionAuthorized: true,
      dnsTlsValid: true,
      rateLimitProfileId: 'default',
    });
    if (!created.ok) throw new Error(created.reasonCode);
    return {
      previewId,
      exposureId: created.exposure.exposureId,
      retire: () => previews.delete(previewId),
      stop: () => stopped.add(previewId),
    };
  };
  const revoke = (
    user: string,
    link: { previewId: string; exposureId: string },
  ) =>
    app.inject({
      method: 'DELETE',
      url: `/v1/local-services/public/${link.exposureId}`,
      headers: { 'x-test-user': user },
      payload: {
        machineId: 'machine_1',
        serviceTarget,
        previewId: link.previewId,
        exposureId: link.exposureId,
      },
    });
  const status = (
    user: string,
    link: { previewId: string; exposureId: string },
  ) =>
    app.inject({
      method: 'POST',
      url: '/v1/local-services/public/status',
      headers: { 'x-test-user': user },
      payload: {
        machineId: 'machine_1',
        serviceTarget,
        previewId: link.previewId,
        exposureId: link.exposureId,
      },
    });
  return { app, runtime, share, revoke, status, serviceAccess };
}

describe('revoking a public link after its Service lifetime ended', () => {
  it('settles as ended for the link owner, and refuses everyone else exactly as before', async () => {
    const { app, runtime, share, revoke, status } = await createHome();
    try {
      const link = share('preview_retired');
      link.retire();
      const stranger = await revoke('stranger', link);
      expect(stranger.statusCode).toBe(403);
      expect(stranger.json()).toMatchObject({
        reasonCode: 'session_not_authorized',
      });
      expect(runtime.resolveExposure(link.exposureId)?.state).toBe('active');
      expect((await status('stranger', link)).json()).toMatchObject({
        reasonCode: 'preview_not_found',
      });

      const owner = await revoke('owner', link);
      expect(owner.json()).toEqual({ ok: true });
      const confirmed = await status('owner', link);
      expect(confirmed.statusCode).toBe(200);
      expect(confirmed.json().snapshot.exposures).toEqual([
        expect.objectContaining({
          exposureId: link.exposureId,
          state: 'revoked',
          revokedAt: expect.any(Number),
        }),
      ]);
      // Idempotent: the owner may settle the same ended link again.
      expect((await revoke('owner', link)).statusCode).toBe(200);
      // The stranger's answer did not change after the owner settled it.
      expect((await revoke('stranger', link)).json()).toMatchObject({
        reasonCode: 'session_not_authorized',
      });
      expect((await status('stranger', link)).json()).toMatchObject({
        reasonCode: 'preview_not_found',
      });
    } finally {
      await app.close();
    }
  });

  it('settles the link of a stopped Service for its creator and Service owner only', async () => {
    const { app, runtime, share, revoke, status } = await createHome();
    try {
      // The creator is a Machine guest; the Service owner stopped the Service.
      const link = share('preview_stopped', 'creator');
      const ownerLink = share('preview_stopped_owner');
      link.stop();
      ownerLink.stop();
      for (const user of ['stranger', 'guest']) {
        expect((await revoke(user, link)).json()).toMatchObject({ reasonCode: 'session_not_authorized' });
        expect((await status(user, link)).json()).toMatchObject({ reasonCode: 'session_not_authorized' });
      }
      expect(runtime.resolveExposure(link.exposureId)?.state).toBe('active');

      expect((await revoke('creator', link)).json()).toEqual({ ok: true });
      expect((await revoke('owner', ownerLink)).json()).toEqual({ ok: true });
      for (const [user, settled] of [['creator', link], ['owner', ownerLink]] as const) {
        const confirmed = await status(user, settled);
        expect(confirmed.statusCode).toBe(200);
        expect(confirmed.json().snapshot.exposures).toEqual([
          expect.objectContaining({ exposureId: settled.exposureId, state: 'revoked', revokedAt: expect.any(Number) }),
        ]);
        expect((await revoke(user, settled)).statusCode).toBe(200);
      }
      for (const user of ['stranger', 'guest']) {
        expect((await revoke(user, link)).json()).toMatchObject({ reasonCode: 'session_not_authorized' });
        expect((await status(user, link)).json()).toMatchObject({ reasonCode: 'session_not_authorized' });
      }
    } finally {
      await app.close();
    }
  });

  it('still revokes a live link through current Service admission', async () => {
    const { app, runtime, share, revoke, serviceAccess } = await createHome();
    try {
      const link = share('preview_live');
      expect((await revoke('stranger', link)).statusCode).toBe(403);
      const revoked = await revoke('owner', link);
      expect(serviceAccess).toEqual(['stranger', 'owner']);
      expect(revoked.json()).toEqual({ ok: true });
      expect(runtime.resolveExposure(link.exposureId)?.state).toBe('revoked');
    } finally {
      await app.close();
    }
  });
});
