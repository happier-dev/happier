import { describe, expect, it } from 'vitest';

import {
    buildNewSessionLaunchRouteParams,
    buildMachinePickerRouteParams,
    buildProfilePickerRouteParams,
    buildSecretRequirementRouteParams,
    buildServerPickerRouteParams,
} from '@/components/sessions/new/navigation/newSessionRouteParams';

describe('buildNewSessionLaunchRouteParams', () => {
    it('includes machine, directory, worktree, and spawn target server params when provided', () => {
        expect(
            buildNewSessionLaunchRouteParams({
                directory: '/repo',
                draftId: 'draft-id',
                machineId: 'machine-1',
                targetServerId: 'server-2',
                worktree: 'new',
            }),
        ).toEqual({
            draftId: 'draft-id',
            machineId: 'machine-1',
            directory: '/repo',
            worktree: 'new',
            spawnServerId: 'server-2',
        });
    });

    it('omits empty optional params', () => {
        expect(
            buildNewSessionLaunchRouteParams({
                directory: '/repo',
                draftId: 'draft-id',
                machineId: null,
                targetServerId: '',
            }),
        ).toEqual({
            directory: '/repo',
            draftId: 'draft-id',
        });
    });
});

describe('buildMachinePickerRouteParams', () => {
    it('includes selected machine and target server params when provided', () => {
        expect(
            buildMachinePickerRouteParams({
                dataId: 'draft-1',
                draftId: 'draft-id',
                selectedMachineId: 'machine-1',
                targetServerId: 'server-2',
            }),
        ).toEqual({
            dataId: 'draft-1',
            draftId: 'draft-id',
            selectedId: 'machine-1',
            spawnServerId: 'server-2',
        });
    });

    it('omits empty params', () => {
        expect(
            buildMachinePickerRouteParams({
                dataId: '',
                selectedMachineId: '',
                targetServerId: '',
            }),
        ).toEqual({});
    });
});

describe('buildServerPickerRouteParams', () => {
    it('includes selected server when provided', () => {
        expect(
            buildServerPickerRouteParams({
                dataId: 'draft-1',
                draftId: 'draft-id',
                targetServerId: 'server-2',
            }),
        ).toEqual({
            dataId: 'draft-1',
            draftId: 'draft-id',
            selectedId: 'server-2',
            spawnServerId: 'server-2',
        });
    });

    it('omits optional params when missing', () => {
        expect(
            buildServerPickerRouteParams({
                dataId: null,
                targetServerId: null,
            }),
        ).toEqual({});
    });
});

describe('buildProfilePickerRouteParams', () => {
    it('includes selected profile, machine, and spawn target server params when provided', () => {
        expect(
            buildProfilePickerRouteParams({
                dataId: 'draft-1',
                draftId: 'draft-id',
                selectedProfileId: 'profile-1',
                selectedMachineId: 'machine-1',
                targetServerId: 'server-2',
            }),
        ).toEqual({
            dataId: 'draft-1',
            draftId: 'draft-id',
            selectedId: 'profile-1',
            machineId: 'machine-1',
            spawnServerId: 'server-2',
        });
    });

    it('omits optional params when missing', () => {
        expect(
            buildProfilePickerRouteParams({
                dataId: null,
                selectedProfileId: null,
                selectedMachineId: null,
                targetServerId: null,
            }),
        ).toEqual({});
    });
});

describe('buildSecretRequirementRouteParams', () => {
    it('includes new-session context, machine, and spawn target server params when provided', () => {
        expect(
            buildSecretRequirementRouteParams({
                dataId: 'draft-1',
                draftId: 'draft-id',
                selectedMachineId: 'machine-1',
                targetServerId: 'server-2',
            }),
        ).toEqual({
            dataId: 'draft-1',
            draftId: 'draft-id',
            machineId: 'machine-1',
            spawnServerId: 'server-2',
        });
    });

    it('omits optional params when missing', () => {
        expect(
            buildSecretRequirementRouteParams({
                dataId: null,
                selectedMachineId: null,
                targetServerId: null,
            }),
        ).toEqual({});
    });
});
