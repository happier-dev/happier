import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { sharePrincipalKey } from './sharePrincipalPresentation';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { readSharePrincipalNames } = await import('./sharePrincipalNames');
let serverId: string;
beforeEach(async () => {
    installHomeGovernanceBoundaries(homes);
    await homes.reset();
    serverId = await homes.addHome({ name: 'Principal labels', serverUrl: 'https://principal-labels.test',
        accountId: 'viewer', currentAccount: true });
});
afterEach(async () => { await homes.reset(); });

const subject = { kind: 'group', teamId: 'team', groupId: 'builders' } as const;
describe('share principal names', () => {
    it.each([
        { kind: 'available', label: { content: { t: 'plain', v: 'Builders' }, recipientEnvelope: null, legacyPlaintext: true } },
        { kind: 'unavailable' },
    ] as const)('opens the authorized Group label without displaying its opaque projection: $kind', async name => {
        homes.answer(serverId, 'POST /v1/session-access/principals/resolve', { body: { v: 1, principals: [
            { ...subject, name, teamName: 'Acme' },
        ] } });
        const names = await readSharePrincipalNames([subject], { serverId, accountId: 'viewer' });
        expect(homes.requests.filter(request => request.path === '/v1/session-access/principals/resolve')).toHaveLength(1);
        expect(names.get(sharePrincipalKey(subject))).toBe(name.kind === 'available' ? 'Builders, Acme' : undefined);
    });
});
