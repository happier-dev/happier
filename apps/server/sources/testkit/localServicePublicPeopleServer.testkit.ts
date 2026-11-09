import { randomUUID } from 'node:crypto';
import type { LocalServicePreviewResourceV1 } from '@happier-dev/protocol/local/services/preview/v1';
import type { LocalServicePublicExposureAudienceV1 } from '@happier-dev/protocol/local/services/public/v1';
import { auth } from '@/app/auth/auth';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerLocalServicePublicRoutes } from '@/app/api/routes/local/services/public/registerRoutes';
import { createLocalServiceRouteSessionAccessAuthorizer } from '@/app/api/routes/local/services/registerRoutes';
import { createLocalServicePreviewRuntime } from '@/app/local/services/preview/runtime';
import { createLocalServicePublicRuntime } from '@/app/local/services/public/runtime';
import { isLocalServicePublicAudienceEligible } from '@/app/local/services/public/peopleAudience';
import { db } from '@/storage/db';
import { createLightSqliteHarness } from './lightSqliteHarness';
import { makeShareEligibleForTest } from './shareEligibility.testkit';

/** Real bearer authentication, Session access, audience eligibility and exposure routes for cross-app callers. */
export async function createLocalServicePublicPeopleServer() {
    const sqlite = await createLightSqliteHarness({ tempDirPrefix: 'happier-ui-preview-people-', initAuth: true });
    const app = createAuthenticatedTestApp({ authentication: 'real' });
    const close = async () => { try { await app.close(); } finally { await sqlite.close(); } };
    try {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const recipient = await db.account.create({ data: { encryptionMode: 'plain' } });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        await makeShareEligibleForTest(owner.id, recipient.id);
        const team = await db.team.create({ data: { name: 'People preview audience' } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: owner.id, role: 'owner' },
            { teamId: team.id, accountId: recipient.id, role: 'member' },
        ] });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: 'Preview viewers', nameKey: 'preview-viewers' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}' } });
        const preview: LocalServicePreviewResourceV1 = { previewId: 'preview_people', sessionId: session.id,
            machineId: 'machine_people', owner: { kind: 'session', id: session.id },
            target: { scheme: 'http', host: '127.0.0.1', port: 42515 }, initialPath: { pathname: '/', search: '' },
            display: { title: 'Web', addressLabel: '127.0.0.1:42515' }, originMode: 'host' };
        const privateRuntime = createLocalServicePreviewRuntime({ tokenSecret: 'fixture-private-preview',
            publicBaseUrl: 'https://home.example.test', hostOriginBaseDomain: 'preview.example.test' });
        const registered = privateRuntime.registerPreview({ resource: preview, accountId: owner.id });
        if (!registered.ok) throw new Error(registered.reasonCode);
        const resolvePreview = privateRuntime.resolvePreview;
        const runtime = createLocalServicePublicRuntime({ publicBaseUrl: 'https://home.example.test',
            hostOriginBaseDomain: 'preview.example.test', tokenSecret: 'fixture-public-preview', resolvePreview,
            policy: { enabled: true, allowedModes: ['people', 'secret_link'], maxTtlMs: 600_000,
                dnsTlsRequired: false, auditRequired: true, rateLimitProfileIds: ['default'] },
            // Audit storage and ingress rate limiting are external host ports;
            // no viewer traffic is issued by this create-payload contract.
            allowTestDevAuditSink: true, recordAuditEvent: () => {}, checkRateLimit: () => true });
        registerLocalServicePublicRoutes(app, { ...runtime, resolvePreview,
            retainMachineAccess: privateRuntime.retainMachineAccess, getStatus: runtime.getSnapshot,
            authorizeSessionAccess: createLocalServiceRouteSessionAccessAuthorizer(),
            validateAudience: isLocalServicePublicAudienceEligible,
            resolveLandingBaseUrl: async () => 'https://app.example.test', dnsTlsValid: true });
        await app.ready();
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const audience: LocalServicePublicExposureAudienceV1 = [
            { kind: 'account', accountId: recipient.id }, { kind: 'team', teamId: team.id },
            { kind: 'group', teamId: team.id, groupId: group.id },
        ];
        return { ownerAccountId: owner.id, preview, audience,
            ineligibleAudience: [{ kind: 'account', accountId: outsider.id }] satisfies LocalServicePublicExposureAudienceV1,
            async post(path: string, body: unknown) {
                const reply = await app.inject({ method: 'POST', url: path, payload: JSON.stringify(body),
                    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
                return { status: reply.statusCode, data: reply.json() as unknown };
            }, close };
    } catch (error) { await close(); throw error; }
}
