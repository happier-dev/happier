import { describe, expect, it } from 'vitest';

import { readDirectSessionLink } from './readDirectSessionLink';

describe('readDirectSessionLink', () => {
    it('ignores absent links and still validates present links', () => {
        for (const metadata of [undefined, null, {}, { directSessionV1: null }, { directSessionV1: {} }]) {
            expect(readDirectSessionLink(metadata)).toBeNull();
        }
        const link = {
            v: 1,
            providerId: 'claude',
            machineId: 'machine-1',
            remoteSessionId: 'remote-1',
            source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
        };
        expect(readDirectSessionLink({ directSessionV1: link })).toEqual(link);
        expect(readDirectSessionLink({ directSessionV1: { ...link, machineId: '' } })).toBeNull();
    });
});
