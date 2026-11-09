import { describe, expect, it } from 'vitest';

import type { SessionSection } from '@/sync/domains/session/organization/sections';

import {
    buildSessionSectionMoveMenuItems,
    readSessionSectionMoveMenuChoice,
} from './sessionSectionMoveMenu';

function section(sectionId: string, name: string, extra: Partial<SessionSection> = {}): SessionSection {
    return {
        address: { serverId: 'home-a', sectionId },
        display: { status: 'available', value: { name, icon: null } },
        sortKey: null,
        ...extra,
    };
}

const opaqueLegacyLeads = section('legacy-leads', 'Leads', {
    legacyContext: { ancestors: [], workspace: { t: 'workspaceRef', serverId: 'home-a', workspaceRefId: 'ref-happier' } },
});

describe('Move to section menu (lab clsections:menu)', () => {
    it('lists this Home’s sections under Sections, then New section… and Back to the row’s project', () => {
        const items = buildSessionSectionMoveMenuItems({
            serverId: 'home-a',
            sections: [
                section('launch', 'Launch 0.3', { display: { status: 'available', value: { name: 'Launch 0.3', icon: 'rocket' } } }),
                section('reviews', 'Reviews'),
                { ...section('foreign', 'Elsewhere'), address: { serverId: 'home-b', sectionId: 'foreign' } },
                { ...section('locked', 'Hidden'), display: { status: 'locked', reason: 'account_key_unavailable' } },
            ],
            currentSectionIds: ['reviews'],
            projectTitle: 'website',
            iconColor: '#000',
            canCreate: true,
        });
        expect(items.map((item) => [item.title, item.category ?? '', item.checked ?? false, item.disabled ?? false])).toEqual([
            ['Launch 0.3', 'Sections', false, false],
            ['Reviews', 'Sections', true, false],
            ['New section…', '', false, false],
            ['Back to website', '', false, false],
        ]);
        expect(items.map((item) => readSessionSectionMoveMenuChoice(item.id))).toEqual([
            { kind: 'section', sectionId: 'launch' },
            { kind: 'section', sectionId: 'reviews' },
            { kind: 'new' },
            { kind: 'project' },
        ]);
    });

    it('dims Back to project when nothing chosen is in a section, and offers no New section without create', () => {
        const items = buildSessionSectionMoveMenuItems({
            serverId: 'home-a', sections: [section('launch', 'Launch 0.3')], currentSectionIds: [null, null],
            projectTitle: null, iconColor: '#000', canCreate: false,
        });
        expect(items.map((item) => [item.title, item.disabled ?? false])).toEqual([
            ['Launch 0.3', false],
            ['Back to project', true],
        ]);
    });

    it('names a section plainly unless another choice shares its name, retaining unavailable context without held facts', () => {
        const unique = buildSessionSectionMoveMenuItems({
            serverId: 'home-a', sections: [opaqueLegacyLeads, section('reviews', 'Reviews')], currentSectionIds: [null],
            projectTitle: 'happier', iconColor: '#000', canCreate: false,
        });
        expect(unique[0]?.title).toBe('Leads');
        const colliding = buildSessionSectionMoveMenuItems({
            serverId: 'home-a', sections: [opaqueLegacyLeads, section('leads', 'Leads')], currentSectionIds: [null],
            projectTitle: 'happier', iconColor: '#000', canCreate: false,
        });
        expect(colliding.slice(0, 2).map((item) => item.title)).toEqual(['Leads — Unavailable', 'Leads']);
    });

    it('reads no choice from another menu’s item ids', () => {
        expect(readSessionSectionMoveMenuChoice('session.rename')).toBeNull();
        expect(readSessionSectionMoveMenuChoice('session.section.move:section:')).toBeNull();
    });
});
