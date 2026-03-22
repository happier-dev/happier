import { describe, expect, it } from 'vitest';

import {
    buildMachinePickerRouteParams,
    buildProfilePickerRouteParams,
    buildServerPickerRouteParams,
} from '@/components/sessions/new/navigation/newSessionRouteParams';

describe('buildMachinePickerRouteParams', () => {
    it('includes selected machine and target server params when provided', () => {
        expect(
            buildMachinePickerRouteParams({
                dataId: 'draft-1',
                selectedMachineId: 'machine-1',
                targetServerId: 'server-2',
            }),
        ).toEqual({
            dataId: 'draft-1',
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
                targetServerId: 'server-2',
            }),
        ).toEqual({
            dataId: 'draft-1',
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
                selectedProfileId: 'profile-1',
                selectedMachineId: 'machine-1',
                targetServerId: 'server-2',
            }),
        ).toEqual({
            dataId: 'draft-1',
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
