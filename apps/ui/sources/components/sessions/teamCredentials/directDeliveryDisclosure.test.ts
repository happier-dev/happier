import { describe, expect, it } from 'vitest';

import { describeDirectDeliveryVisibility, presentDirectDeliveryDisclosure } from './directDeliveryDisclosure';

const translate = (key: string) => key;
const describe_ = (target: Parameters<typeof presentDirectDeliveryDisclosure>[0]) => {
    const disclosure = presentDirectDeliveryDisclosure(target);
    return describeDirectDeliveryVisibility(disclosure.visibility, translate, disclosure.placement).split('\n\n');
};
const k = 'teams.credentials.directUse';

describe('Direct delivery says where agents run on the target now (MI-2)', () => {
    it('separate users observed effective: their own user, and what was shared before may still be visible', () => {
        expect(describe_({ platform: 'linux', isolationPolicy: { enabled: true, memberProvisioning: 'linuxUsersV1' },
            isolation: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' } }))
            .toEqual([`${k}.ownerVisibility`, `${k}.separatePlacement`, `${k}.sharedBeforeSeparation`]);
    });

    it('a shared agent user: their agents run as you, with no separate-users warning', () => {
        expect(describe_({ platform: 'linux', isolationPolicy: { enabled: true },
            isolation: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' } }))
            .toEqual([`${k}.ownerVisibility`, `${k}.sharedPlacement`]);
    });

    it('separate users asked for but not observed effective, or no target: both warnings stay', () => {
        const both = [`${k}.ownerVisibility`, `${k}.sharedUserVisibility`];
        expect(describe_({ platform: 'linux', isolationPolicy: { enabled: true, memberProvisioning: 'linuxUsersV1' },
            isolation: { kind: 'applying', phase: 'account' } })).toEqual(both);
        expect(describe_(null)).toEqual(both);
    });
});
