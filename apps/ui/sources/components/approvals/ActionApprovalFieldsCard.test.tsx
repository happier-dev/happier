import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it } from 'vitest';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { storage } from '@/sync/domains/state/storage';
import { removeServerProfile, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { ActionApprovalFieldsCard } from './ActionApprovalFieldsCard';
import type { ApprovalActionFieldsPresentation } from './approvalFieldValues';
import { describeUnnamedApprovalSession } from './approvalRequesterLabels';

const initialState = storage.getState();
const profiles: string[] = [];

afterEach(async () => {
    await standardCleanup();
    storage.setState(initialState);
    for (const id of profiles.splice(0)) await removeServerProfile(id);
});

it('the approval Details page preserves an exact remote host id when a session has the same id', async () => {
    const profile = await upsertServerProfile({ name: 'Approval Home', serverUrl: 'https://approval-reference.test' });
    profiles.push(profile.id);
    const otherHome = await upsertServerProfile({ name: 'Unrelated Home', serverUrl: 'https://unrelated-approval-reference.test' });
    profiles.push(otherHome.id);
    const hostId = 'exact-remote-host';
    const session = createSessionFixture();
    if (!session.metadata) throw new Error('Missing Session metadata fixture');
    await act(async () => {
        storage.getState().applySessions([
            createSessionFixture({ id: hostId, serverId: profile.id,
                metadata: { ...session.metadata, name: 'Unrelated same-id session' } }),
            createSessionFixture({ id: profile.id, serverId: profile.id,
                metadata: { ...session.metadata, name: 'Session sharing Home token' } }),
        ]);
    });
    const presentation = { rows: [
        { kind: 'value', path: 'hostId', title: 'Remote host', value: hostId },
        { kind: 'value', path: 'operation.kind', title: 'Operation', value: 'disable' },
    ], unrepresentable: null } satisfies ApprovalActionFieldsPresentation;
    const details = await renderScreen(<ActionApprovalFieldsCard presentation={presentation} anatomy="page" serverId={profile.id} />);
    expect(details.getTextContent()).toContain(hostId);
    expect(details.getTextContent()).not.toContain('Unrelated same-id session');

    // Save/duplicate and relay Address admit any nonempty literal host identity,
    // including text that happens to resemble a structured Session reference.
    const structuredLookingHostId = JSON.stringify({ kind: 'host', id: hostId });
    const structuredLookingHost = await renderScreen(<ActionApprovalFieldsCard anatomy="page" serverId={profile.id} presentation={{
        rows: [{ kind: 'value', path: 'hostId', title: 'Remote host', value: structuredLookingHostId }],
        unrepresentable: null,
    }} />);
    expect(structuredLookingHost.getTextContent()).toContain(structuredLookingHostId);
    expect(structuredLookingHost.getTextContent()).not.toContain('Unrelated same-id session');

    // The renderer consumes Protocol's typed reference projection, not path/value guesses.
    // describeApprovalReference emits these shapes for declared Session and serverId fields.
    const references = await renderScreen(<ActionApprovalFieldsCard anatomy="page" serverId={profile.id} presentation={{
        rows: [
            { kind: 'value', path: 'sessionId', title: 'Session', value: hostId,
                reference: { kind: 'session', id: hostId } },
            { kind: 'value', path: 'serverId', title: 'Home', value: profile.id,
                reference: { kind: 'home', id: profile.id } },
            { kind: 'value', path: 'parentSessionId', title: 'Unavailable session', value: otherHome.id,
                reference: { kind: 'session', id: otherHome.id } },
        ], unrepresentable: null,
    }} />);
    expect(references.getTextContent()).toContain('Unrelated same-id session');
    expect(references.getTextContent()).toContain('Approval Home');
    expect(references.getTextContent()).not.toContain('Session sharing Home token');
    expect(references.getTextContent()).not.toContain('Unrelated Home');
    expect(references.getTextContent()).toContain(describeUnnamedApprovalSession('Approval Home'));
});
