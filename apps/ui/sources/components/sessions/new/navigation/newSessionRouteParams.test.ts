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
                selectedMachineId: 'machine-1',
                targetServerId: 'server-2',
            }),
        ).toEqual({
            selectedId: 'machine-1',
            spawnServerId: 'server-2',
        });
    });

    it('omits empty params', () => {
        expect(
            buildMachinePickerRouteParams({
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
                targetServerId: 'server-2',
            }),
        ).toEqual({
            selectedId: 'server-2',
        });
    });

    it('omits optional params when missing', () => {
        expect(
            buildServerPickerRouteParams({
                targetServerId: null,
            }),
        ).toEqual({});
    });
});

describe('buildProfilePickerRouteParams', () => {
    it('includes selected profile, machine, and spawn target server params when provided', () => {
        expect(
            buildProfilePickerRouteParams({
                selectedProfileId: 'profile-1',
                selectedMachineId: 'machine-1',
                targetServerId: 'server-2',
            }),
        ).toEqual({
            selectedId: 'profile-1',
            machineId: 'machine-1',
            spawnServerId: 'server-2',
        });
    });

    it('omits optional params when missing', () => {
        expect(
            buildProfilePickerRouteParams({
                selectedProfileId: null,
                selectedMachineId: null,
                targetServerId: null,
            }),
        ).toEqual({});
    });
});
