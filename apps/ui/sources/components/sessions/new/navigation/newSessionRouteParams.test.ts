import { describe, expect, it } from 'vitest';

import {
    buildNewSessionLaunchRouteParams,
    buildMachinePickerRouteParams,
    buildProfilePickerRouteParams,
    buildServerPickerRouteParams,
} from '@/components/sessions/new/navigation/newSessionRouteParams';

describe('buildNewSessionLaunchRouteParams', () => {
    it('carries the explicit draft identity with every seeded launch selection', () => {
        expect(buildNewSessionLaunchRouteParams({
            draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
            machineId: 'machine-1',
            directory: '/repo',
            worktree: 'new',
            targetServerId: 'server-2',
        })).toEqual({
            draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
            machineId: 'machine-1',
            directory: '/repo',
            worktree: 'new',
            spawnServerId: 'server-2',
        });
    });
});

describe('buildMachinePickerRouteParams', () => {
    it('includes selected machine and target server params when provided', () => {
        expect(
            buildMachinePickerRouteParams({
                dataId: 'draft-1',
                draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
                selectedMachineId: 'machine-1',
                targetServerId: 'server-2',
            }),
        ).toEqual({
            dataId: 'draft-1',
            draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
            selectedId: 'machine-1',
            spawnServerId: 'server-2',
        });
    });

    it('omits empty params', () => {
        expect(
            buildMachinePickerRouteParams({
                dataId: '',
                draftId: '',
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
                draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
                targetServerId: 'server-2',
            }),
        ).toEqual({
            dataId: 'draft-1',
            draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
            selectedId: 'server-2',
            spawnServerId: 'server-2',
        });
    });

    it('omits optional params when missing', () => {
        expect(
            buildServerPickerRouteParams({
                dataId: null,
                draftId: null,
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
                draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
                selectedProfileId: 'profile-1',
                selectedMachineId: 'machine-1',
                targetServerId: 'server-2',
            }),
        ).toEqual({
            dataId: 'draft-1',
            draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
            selectedId: 'profile-1',
            machineId: 'machine-1',
            spawnServerId: 'server-2',
        });
    });

    it('omits optional params when missing', () => {
        expect(
            buildProfilePickerRouteParams({
                dataId: null,
                draftId: null,
                selectedProfileId: null,
                selectedMachineId: null,
                targetServerId: null,
            }),
        ).toEqual({});
    });
});
