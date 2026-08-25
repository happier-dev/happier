import { describe, expect, it } from 'vitest';

import { buildProfileEditPickerRouteParams } from './buildProfileEditPickerRouteParams';

describe('buildProfileEditPickerRouteParams', () => {
    it('preserves draft context and canonical backend params for profile-edit picker routes', () => {
        expect(buildProfileEditPickerRouteParams({
            backendTargetRouteParams: {
                agentType: 'customAcp',
                backendTarget: '{"kind":"backend","backendId":"review-bot","configuredBackendId":"review-bot"}',
                backendTargetKey: 'backend:review-bot:configured:review-bot',
            },
            dataId: 'draft-1',
            draftId: 'draft-id',
            machineId: 'machine-1',
            spawnServerId: 'server-2',
            nextParams: {
                cloneFromProfileId: 'profile-1',
            },
        })).toEqual({
            agentType: 'customAcp',
            backendTarget: '{"kind":"backend","backendId":"review-bot","configuredBackendId":"review-bot"}',
            backendTargetKey: 'backend:review-bot:configured:review-bot',
            cloneFromProfileId: 'profile-1',
            dataId: 'draft-1',
            draftId: 'draft-id',
            machineId: 'machine-1',
            spawnServerId: 'server-2',
        });
    });

    it('omits optional draft context values when they are absent', () => {
        expect(buildProfileEditPickerRouteParams({
            backendTargetRouteParams: {
                agentType: 'codex',
            },
            dataId: undefined,
            machineId: undefined,
            spawnServerId: undefined,
            nextParams: {
                profileId: 'profile-2',
            },
        })).toEqual({
            agentType: 'codex',
            profileId: 'profile-2',
        });
    });
});
