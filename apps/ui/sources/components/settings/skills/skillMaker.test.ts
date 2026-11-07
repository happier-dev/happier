import { describe, expect, it } from 'vitest';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { t } from '@/text';
import { presentSkillMaker } from './skillMaker';

const scope = { accountId: 'me', serverId: 'home' };
const agent = { kind: 'agent' as const, accountId: 'me', sessionId: 'bot-1' };
const bot = createSessionListRenderableSessionFixture({ id: 'bot-1', metadata: {
    path: '/project', name: 'Researcher', bot: { kind: 'bot' },
} });

describe('skill maker identity', () => {
    it('uses stable creator ids while current accessible Bot identity changes', () => {
        const first = presentSkillMaker({ creator: agent }, scope, bot);
        expect(first).toMatchObject({ kind: 'bot', label: 'Researcher', openSessionId: 'bot-1',
            filterValues: ['anyone', 'any-bot', 'session:bot-1'] });
        expect(first.face).not.toBeNull();
        const renamed = presentSkillMaker({ creator: agent }, scope, { ...bot,
            metadata: { ...bot.metadata!, name: 'Writer' } });
        expect(renamed.label).toBe('Writer');
        expect(renamed.filterValues).toEqual(first.filterValues);
    });

    it('distinguishes You from an ordinary, missing or unreadable creator Session and legacy absence', () => {
        expect(presentSkillMaker({ creator: { kind: 'person', accountId: 'me' } }, scope))
            .toMatchObject({ kind: 'you', filterValues: ['anyone', 'you'], openSessionId: null });
        expect(presentSkillMaker({ creator: { kind: 'person', accountId: 'other' } }, scope).kind).toBe('person');
        const ordinary = presentSkillMaker({ creator: agent }, scope, { ...bot,
            metadata: { path: '/project', name: 'Ordinary session' } });
        expect(ordinary).toMatchObject({ kind: 'session', label: 'Ordinary session',
            filterValues: ['anyone'], face: null, openSessionId: 'bot-1' });
        for (const session of [undefined, { ...bot, encryptedContentAvailability: 'encrypted_content_unavailable' as const }]) {
            expect(presentSkillMaker({ creator: agent }, scope, session)).toMatchObject({ kind: 'session',
                label: t('capabilities.skills.maker.session'), filterValues: ['anyone'], openSessionId: null, face: null });
        }
        expect(presentSkillMaker({ provenance: { kind: 'written' } }, scope))
            .toMatchObject({ kind: 'unknown', filterValues: ['anyone'], openSessionId: null });
    });

    it('groups registry origins without asserting that the installer wrote them', () => {
        const registry = presentSkillMaker({ provenance: { kind: 'wellKnown', indexUrl: 'https://skills.test/index.json',
            name: 'research', digest: `sha256:${'a'.repeat(64)}` } }, scope);
        expect(registry).toMatchObject({ kind: 'registry', filterValues: ['anyone', 'registries'], openSessionId: null });
        expect(presentSkillMaker({ provenance: { kind: 'upload', importedAt: 1 } }, scope).kind).toBe('unknown');
    });

    it('withdraws creator identity and navigation when held access no longer allows reading', () => {
        for (const session of [{ ...bot, access: null }, { ...bot, access: { ...bot.access!,
            capabilities: { ...bot.access!.capabilities, readTranscript: false } } }]) {
            expect(presentSkillMaker({ creator: agent }, scope, session)).toMatchObject({ kind: 'session',
                label: t('capabilities.skills.maker.session'), filterValues: ['anyone'], face: null, openSessionId: null });
        }
    });
});
