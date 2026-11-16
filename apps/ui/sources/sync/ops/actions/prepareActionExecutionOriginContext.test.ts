import { afterEach, expect, it } from 'vitest';
import { getStorage } from '@/sync/domains/state/storage';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createUiActionExecutionOriginContextPreparer } from './prepareActionExecutionOriginContext';

const initialState = getStorage().getState();
afterEach(() => getStorage().setState(initialState, true));

it('retains only the exact Home Project context from admitted Session rows', async () => {
    getStorage().setState({ sessionListRowsByServerId: {
        'home-a': { same: createSessionListRenderableSessionFixture({ id: 'same', projectKey: 'project-a' }) },
        'home-b': { same: createSessionListRenderableSessionFixture({ id: 'same', projectKey: 'project-b' }) },
    } });
    const prepare = createUiActionExecutionOriginContextPreparer({ serverId: 'home-b', serverIdentityId: 'identity-b' });
    expect(await prepare({ targetSessionId: 'same' })).toMatchObject({ automationSubjects: [
        { role: 'context', subject: { kind: 'project', serverId: 'identity-b', projectKey: 'project-b' } },
        { role: 'context', subject: { kind: 'machine', serverId: 'identity-b', machineId: 'machine-1' } },
    ] });
    expect(await prepare({ targetSessionId: 'missing' })).not.toHaveProperty('automationSubjects');
    expect(await prepare({ targetSessionId: null })).not.toHaveProperty('automationSubjects');
});
