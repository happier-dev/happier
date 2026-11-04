import { describe, expect, it, vi } from 'vitest';

import { localSettingsDefaults, type LocalSettings } from '@/sync/domains/settings/localSettings';
import { navigationPlacementStorageBinding as binding } from './navigationPlacementSettingBinding';

describe('navigation placement binding', () => {
    it('merges missing detail addresses and phone position once without replacing Session desktop preferences', () => {
        const sessionRail = { orderedIds: ['files'], placements: {} };
        let local: LocalSettings = { ...localSettingsDefaults, navigationSurfacePlacementsV1: { sessionRail } };
        const write = vi.fn((delta: Partial<LocalSettings>) => { local = { ...local, ...delta }; });
        const parsed = binding.parse({ detailPages: { session: { desktop: { pages: {} } }, machine: { phone: { items: {} } } }, pageTabs: { session: 'top' } });
        expect(parsed.success).toBe(true);
        if (!parsed.success) return;
        binding.commit(local, parsed.value, write);
        expect(local.navigationSurfacePlacementsV1.sessionRail).toBe(sessionRail);
        expect(local.navigationSurfacePlacementsV1).toMatchObject({ pageTabs: { session: 'top' }, detailPages: { machine: { phone: { items: { orderedIds: [], placements: {} } } } } });
        binding.commit(local, parsed.value, write);
        expect(write).toHaveBeenCalledTimes(1);
    });
    it('admits a Project-only patch through the same local owner without replacing another surface', () => {
        if (!('kind' in binding) || binding.kind !== 'localOwner') throw new Error('Expected the local placement owner');
        const composer = { orderedIds: ['goal'], placements: { goal: 'hidden' as const } };
        let local: LocalSettings = { ...localSettingsDefaults, navigationSurfacePlacementsV1: { composer } };
        const write = vi.fn((delta: Partial<LocalSettings>) => { local = { ...local, ...delta }; });
        const parsed = binding.parse({ projectTabBar: { orderedIds: ['plugin:external:page', 'overview'], placements: { 'plugin:external:page': 'overflow' } } });
        expect(parsed.success).toBe(true);
        if (!parsed.success) return;
        binding.commit(local, parsed.value, write);
        expect(local.navigationSurfacePlacementsV1.composer).toBe(composer);
        expect(binding.read(local)).toMatchObject({ projectTabBar: { orderedIds: ['plugin:external:page', 'overview'], placements: { 'plugin:external:page': 'overflow' } } });
        binding.commit(local, parsed.value, write);
        expect(write).toHaveBeenCalledTimes(1);
    });

    it('merges admitted patches per surface, preserves nested identity and publishes no equal replay', () => {
        if (!('kind' in binding) || binding.kind !== 'localOwner') throw new Error('Expected the local placement owner');
        const composer = { orderedIds: ['goal'], placements: { goal: 'hidden' as const } };
        const sessionRail = { orderedIds: ['terminal'], placements: { terminal: 'pinned' as const } };
        let local: LocalSettings = { ...localSettingsDefaults, navigationSurfacePlacementsV1: { composer, sessionRail } };
        const write = vi.fn((delta: Partial<LocalSettings>) => { local = { ...local, ...delta }; });
        const commit = (value: unknown) => {
            const parsed = binding.parse(value);
            expect(parsed.success).toBe(true);
            if (parsed.success) binding.commit(local, parsed.value, write);
        };
        commit({ composer: { orderedIds: ['goal'], placements: { goal: 'hidden' } } });
        expect(write).not.toHaveBeenCalled();
        commit({ sessionRail: { orderedIds: [], placements: {} } });
        expect(local.navigationSurfacePlacementsV1.composer).toBe(composer);
        expect(write).toHaveBeenCalledTimes(1);
        const rail = local.navigationSurfacePlacementsV1.sessionRail;
        commit({ composer: {} });
        expect(local.navigationSurfacePlacementsV1).toEqual({ composer: { orderedIds: [], placements: {} }, sessionRail: { orderedIds: [], placements: {} } });
        expect(local.navigationSurfacePlacementsV1.sessionRail).toBe(rail);
        commit({ composer: {} });
        expect(write).toHaveBeenCalledTimes(2);
        expect(binding.read(local)).toMatchObject(local.navigationSurfacePlacementsV1);
    });
});
