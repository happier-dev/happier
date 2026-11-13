import { afterEach, describe, expect, it, vi } from 'vitest';
import { isRecord } from '@happier-dev/protocol/common/records';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createPlatformFailureNoticeFixture } from './platformFailureNotices.testkit';
import { createPlatformFailureNotices } from './platformFailureNotices';

afterEach(() => vi.restoreAllMocks());

describe('generic receipt outcomes through the private C1 owner', () => {
    it('opens provisioned failure and updates the same item from a succeeded receipt with private provider evidence', async () => {
        const f = createPlatformFailureNoticeFixture();
        expect(await f.consume()).toMatchObject({ kind: 'consumed', changed: true });
        const header = () => decodePlainArtifactStoredContent(String([...f.rows.values()][0]!.header));
        expect(header()).toMatchObject({ type: 'blocked', source: { kind: 'host', topic: 'service_health',
            subject: { kind: 'platformTarget', environmentId: 'environment-staging', targetLinkId: 'target-link' } } });
        await f.consume(f.observation('failed', 150));
        expect(f.rows.size).toBe(1);
        await f.consume(f.observation('succeeded', 200));
        expect(header()).toMatchObject({ type: 'update', healthPhase: 'recovered', resolved: false, title: 'Staging: deployment succeeded' });
        const body = decodePlainArtifactStoredContent(String([...f.rows.values()][0]!.body));
        expect(body).toMatchObject({ body: expect.stringContaining('provider-deployment-200') });
        expect(body).toMatchObject({ body: expect.stringContaining('https://provider.example/deployment') });
        expect(body).toMatchObject({ body: expect.stringContaining('provider-log') });
        expect(body).toMatchObject({ body: expect.stringContaining('a'.repeat(40)) });
        expect(header()).not.toHaveProperty('readAt');
        const writes = f.writes.mock.calls.length;
        await f.consume(f.observation('failed', 100));
        expect(f.writes.mock.calls.length).toBe(writes);
        expect(header()).toMatchObject({ type: 'update', healthPhase: 'recovered' });
    });

    it('ignores the retired provider-specific Event without reading private receipt content', async () => {
        const f = createPlatformFailureNoticeFixture();
        const readReceipt = vi.spyOn(f.host, 'readReceipt');
        const eventRef = { pluginId: 'happier.deploy.cloudflare', localId: 'production-deployment-transition' };
        const consume = createPlatformFailureNotices(f.host);
        expect(await consume({ caller: { ...f.caller, pluginId: eventRef.pluginId }, definition: { ...f.definition, eventRef },
            observation: { ...f.observation('failed', 100), eventRef }, signal: new AbortController().signal })).toEqual({ kind: 'notApplicable' });
        expect(readReceipt).not.toHaveBeenCalled();
        expect(f.writes).not.toHaveBeenCalled();
    });

    it('leaves an Environment-wide generic observer outside the private platform projection', async () => {
        const f = createPlatformFailureNoticeFixture();
        const readReceipt = vi.spyOn(f.host, 'readReceipt');
        const consume = createPlatformFailureNotices(f.host);
        expect(await consume({ caller: f.caller, definition: { ...f.definition,
            sourceConfig: { v: 1, serverId: 'home', environmentId: 'environment-staging', observingSince: 1 } },
            observation: f.observation('failed', 100), signal: new AbortController().signal })).toEqual({ kind: 'notApplicable' });
        expect(readReceipt).not.toHaveBeenCalled();
        expect(f.writes).not.toHaveBeenCalled();
    });

    it('rejects a mismatched current link principal before any notice write', async () => {
        const f = createPlatformFailureNoticeFixture();
        f.changeEnvironment(value => ({ ...value, targetLinks: value.targetLinks.map(row => ({ ...row, content: row.content && {
            ...row.content, credentialPrincipal: { ...f.credentialPrincipal, accountId: 'other' } } })) }));
        await expect(f.consume()).rejects.toMatchObject({ code: 'target_mismatch' });
        expect(f.writes).not.toHaveBeenCalled();
    });

    it('accepts the same current credential principal in a null-prototype JSON carrier', async () => {
        const f = createPlatformFailureNoticeFixture();
        f.changeEnvironment(value => ({ ...value, targetLinks: value.targetLinks.map(row => ({ ...row, content: row.content && {
            ...row.content, credentialPrincipal: Object.setPrototypeOf({ ...f.credentialPrincipal }, null) } })) }));
        expect(await f.consume()).toMatchObject({ kind: 'consumed', changed: true });
        expect(f.rows.size).toBe(1);
    });

    it('rejects payload routing outside the enrolled link before any notice write', async () => {
        const f = createPlatformFailureNoticeFixture();
        const event = f.observation('failed', 100);
        if (!isRecord(event.payload)) throw new Error('Expected an object receipt payload');
        await expect(f.consume({ ...event, payload: { ...event.payload, targetLinkId: 'foreign-link' } }))
            .rejects.toMatchObject({ code: 'target_mismatch' });
        expect(f.writes).not.toHaveBeenCalled();
    });

    it('uses the current non-production classification for a configured link', async () => {
        const f = createPlatformFailureNoticeFixture();
        f.changeEnvironment(value => ({ ...value, environment: { ...value.environment, protection: 'nonProduction' },
            targetLinks: value.targetLinks.map(row => ({ ...row, targetLink: { ...row.targetLink, state: 'configured' } })) }));
        const event = f.observation('failed', 100);
        await f.consume(event);
        expect(decodePlainArtifactStoredContent(String([...f.rows.values()][0]!.header))).toMatchObject({ type: 'update', healthPhase: 'open' });
    });

    it('rejects a different Event and a malformed closed failure payload', async () => {
        const f = createPlatformFailureNoticeFixture();
        const consume = createPlatformFailureNotices(f.host);
        const event = f.observation('failed', 100);
        if (!isRecord(event.payload)) throw new Error('Expected an object receipt payload');
        await expect(consume({ caller: f.caller, definition: f.definition, signal: new AbortController().signal,
            observation: { ...event, eventRef: { ...event.eventRef, localId: 'different-event' } } }))
            .rejects.toMatchObject({ code: 'target_mismatch' });
        await expect(f.consume({ ...event, payload: { ...event.payload, unknownAuthority: true } }))
            .rejects.toMatchObject({ code: 'invalid_parameters' });
        expect(f.writes).not.toHaveBeenCalled();
    });

    it('rejects an observation after the current Environment moves to another controller', async () => {
        const f = createPlatformFailureNoticeFixture();
        f.changeEnvironment(value => ({ ...value, environment: { ...value.environment, controllerMachineId: 'new-controller' } }));
        await expect(f.consume()).rejects.toMatchObject({ code: 'target_mismatch' });
        expect(f.writes).not.toHaveBeenCalled();
    });
});
