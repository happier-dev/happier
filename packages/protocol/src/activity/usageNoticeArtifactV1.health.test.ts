import { describe, expect, it } from 'vitest';
import { AccountNoticeArtifactBodyV1Schema, AccountNoticeArtifactHeaderV1Schema,
    ACCOUNT_NOTICE_ARTIFACT_KIND_V1, readAccountNoticeArtifactV1, normalizeAccountNoticeArtifactV1, projectAccountNoticeInboxItemV1 } from './usageNoticeArtifactV1.js';
import { withArtifactExcerptV1 } from '../artifacts/artifactExcerptV1.js';

it.each([undefined, 'Design review'])('projects only authored notice text after the Artifact writer adds its JSON excerpt (%s)', body => {
    const content = AccountNoticeArtifactBodyV1Schema.parse({ v: 1,
        source: { kind: 'plugin', pluginId: 'happier.channels', itemId: 'conversation-a' },
        type: 'update', resolved: false, ...(body === undefined ? {} : { body }) });
    const serialized = JSON.stringify(content);
    const header = withArtifactExcerptV1({ ...content, kind: ACCOUNT_NOTICE_ARTIFACT_KIND_V1,
        title: 'External conversation', status: 'open' }, serialized);
    const admitted = readAccountNoticeArtifactV1({ header, body: serialized });
    expect(admitted).not.toBeNull();
    const item = projectAccountNoticeInboxItemV1({ artifactId: 'notice-a', serverId: 'home-a', createdAt: 1,
        pageRoute: '/inbox', header: admitted! });
    expect(item).toMatchObject({ context: body ?? null, excerpt: body ?? null });
});

it('keeps plugin identity on Inbox projections without inventing it for host notices', () => {
    const header = AccountNoticeArtifactHeaderV1Schema.parse({ v: 1, kind: ACCOUNT_NOTICE_ARTIFACT_KIND_V1,
        source: { kind: 'plugin', pluginId: 'happier.triage', itemId: 'task-a' },
        type: 'update', resolved: false, title: 'Review the change', status: 'open' });
    const input = { artifactId: 'notice-a', serverId: 'home-a', createdAt: 1, pageRoute: '/inbox', header };
    expect(projectAccountNoticeInboxItemV1(input)?.source).toMatchObject({ pluginId: 'happier.triage' });
    const hostHeader = AccountNoticeArtifactHeaderV1Schema.parse({ ...header, source: { kind: 'host', topic: 'connected_service_usage' },
        notice: { topic: 'connected_service_usage', kind: 'credit_expiry', serviceId: 'happier.agent.codex', profileId: 'profile-a',
            issueFingerprint: 'credit-a', evidence: { recordId: 'paug_v1_record_a', creditId: 'credit-a', expiresAtMs: 9000,
                observedAtMs: 2000, previousObservedAtMs: 1000 } } });
    expect(projectAccountNoticeInboxItemV1({ ...input, header: hostHeader })?.source).not.toHaveProperty('pluginId');
});

describe('C1 typed Environment health evidence', () => {
    it('retains strict platform ordering evidence only on the matching platform condition', () => {
        const content = { v: 1, source: { kind: 'host', topic: 'service_health', subject: { kind: 'platformTarget',
            environmentId: 'environment-a', targetLinkId: 'link-a' } }, type: 'update', resolved: false, healthPhase: 'recovered',
            platformTransition: { transitionId: 'recovery', observedAtMs: 200 },
            page: { kind: 'host', page: 'environment', targetLinkId: 'link-a',
                environment: { serverId: 'home', projectSourceId: 'source-a', environmentId: 'environment-a' } } };
        const header = AccountNoticeArtifactHeaderV1Schema.parse({ ...content, kind: ACCOUNT_NOTICE_ARTIFACT_KIND_V1,
            title: 'Recovered', status: 'open' });
        expect(readAccountNoticeArtifactV1({ header, body: JSON.stringify(content) })).toHaveProperty('platformTransition', content.platformTransition);
        expect(AccountNoticeArtifactBodyV1Schema.safeParse({ ...content, platformTransition: { ...content.platformTransition, generation: 3 } }).success).toBe(false);
        expect(AccountNoticeArtifactBodyV1Schema.safeParse({ ...content, source: { ...content.source, subject: { kind: 'environment',
            environmentId: 'environment-a', targetLinkId: 'link-a', condition: 'deployment_failed' } } }).success).toBe(false);
    });

    it('retains the producer aggregate only on its exact Environment health condition', () => {
        const environmentHealth = { v: 1, environmentId: 'environment-a', targetLinkId: 'link-a', protection: 'production',
            status: 'degraded', n: 2, down: 1, degraded: 0, unknown: 0,
            members: [{ machineId: 'machine-a', roles: ['runtime'], status: 'up', evidence: [{ role: 'runtime', status: 'up', source: 'native' }] },
                { machineId: 'machine-b', roles: ['runtime'], status: 'down', evidence: [{ role: 'runtime', status: 'down', source: 'native' }] }],
            affectedMachineIds: ['machine-b'], edgeUnreachable: false, authoritativeRecovery: false };
        const content = { v: 1, source: { kind: 'host', topic: 'service_health', subject: { kind: 'environment',
            environmentId: 'environment-a', targetLinkId: 'link-a', condition: 'health' } },
            type: 'blocked', resolved: false, healthPhase: 'open', environmentHealth,
            page: { kind: 'host', page: 'environment', targetLinkId: 'link-a',
                environment: { serverId: 'home', projectSourceId: 'source-a', environmentId: 'environment-a' } } };
        expect(AccountNoticeArtifactBodyV1Schema.parse(content)).toHaveProperty('environmentHealth', environmentHealth);
        const header = AccountNoticeArtifactHeaderV1Schema.parse({ ...content, kind: ACCOUNT_NOTICE_ARTIFACT_KIND_V1,
            title: '1 of 2 servers down', status: 'open' });
        expect(header).toHaveProperty('environmentHealth', environmentHealth);
        expect(normalizeAccountNoticeArtifactV1(header)).toBe(header);
        expect(readAccountNoticeArtifactV1({ header, body: JSON.stringify(content) })).toHaveProperty('environmentHealth', environmentHealth);
        expect(readAccountNoticeArtifactV1({ header, body: JSON.stringify({ ...content,
            environmentHealth: { ...environmentHealth, down: 2 } }) })).toBeNull();
        for (const mismatch of [{ environmentId: 'another' }, { targetLinkId: 'another' }]) {
            expect(AccountNoticeArtifactBodyV1Schema.safeParse({ ...content, environmentHealth: { ...environmentHealth, ...mismatch } }).success).toBe(false);
        }
        expect(AccountNoticeArtifactBodyV1Schema.safeParse({ ...content,
            source: { ...content.source, subject: { ...content.source.subject, condition: 'deployment_failed' } } }).success).toBe(false);
        expect(AccountNoticeArtifactBodyV1Schema.safeParse({ ...content, source: { kind: 'plugin', pluginId: 'fixture', itemId: 'fixture' }, page: undefined }).success).toBe(false);
        expect(AccountNoticeArtifactBodyV1Schema.safeParse({ ...content, environmentHealth: { ...environmentHealth, nativePayload: {} } }).success).toBe(false);
        expect(AccountNoticeArtifactBodyV1Schema.safeParse({ ...content, healthPhase: 'recovered', type: 'update' }).success).toBe(false);
        expect(AccountNoticeArtifactBodyV1Schema.safeParse({ ...content, environmentHealth: undefined }).success).toBe(true);
    });
});
