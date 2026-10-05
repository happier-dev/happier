import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { resolveServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { getFeatureBuildPolicyDecision } from '@/sync/domains/features/featureBuildPolicy';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { resolveServerProfileScopeId, updateHomeViewState } from '@/sync/domains/server/serverProfiles';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storageStore';
import { SessionGettingStartedGuidance } from './SessionGettingStartedGuidance';

// Translation is a UI boundary; guidance, Home selection and storage remain real.
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

describe('SessionGettingStartedGuidance (feature gate)', () => {
    let previousState: ReturnType<typeof storage.getState>;
    let previousDeny: string | undefined;
    let previousAllow: string | undefined;
    let previousPolicyEnv: string | undefined;

    beforeEach(() => {
        previousState = storage.getState();
        previousDeny = process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
        previousAllow = process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_ALLOW;
        previousPolicyEnv = process.env.EXPO_PUBLIC_HAPPIER_FEATURE_POLICY_ENV;
        delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_ALLOW;
        delete process.env.EXPO_PUBLIC_HAPPIER_FEATURE_POLICY_ENV;
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = 'app.ui.sessionGettingStartedGuidance';
    });

    afterEach(() => {
        standardCleanup();
        storage.getState().clearSessionLocalStateScope();
        storage.getState().clearProfileScope();
        storage.setState(previousState);
        if (previousDeny === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
        else process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = previousDeny;
        if (previousAllow === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_ALLOW;
        else process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_ALLOW = previousAllow;
        if (previousPolicyEnv === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_FEATURE_POLICY_ENV;
        else process.env.EXPO_PUBLIC_HAPPIER_FEATURE_POLICY_ENV = previousPolicyEnv;
    });

    it('denies guidance by build policy but renders loaded-session guidance when allowed', async () => {
        const denied = await renderScreen(<SessionGettingStartedGuidance variant="sidebar" />);
        expect(denied.tree.toJSON()).toBeNull();

        const home = await upsertAndActivateServer({ serverUrl: 'https://guidance.example.test', name: 'Guidance Home' });
        const serverId = resolveServerProfileScopeId(home);
        const accountId = 'guidance-account';
        const token = 'header.' + Buffer.from(JSON.stringify({ sub: accountId })).toString('base64') + '.signature';
        expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId }, { token })).toBe(true);
        const binding = await resolveServerCredentialAccountScope(serverId);
        if (binding.kind !== 'bound') throw new Error('The Home credential fixture was not bound');
        expect(binding.scope.accountId).toBe(accountId);
        await updateHomeViewState(() => ({
            version: 1,
            groups: [],
            activeTargetKind: 'server',
            activeTargetId: serverId,
        }));
        storage.getState().activateProfileScope(binding.scope);
        storage.getState().applyProfileForScope(binding.scope, { ...profileDefaults, id: accountId });
        storage.getState().activateSessionLocalStateScope(binding.scope);
        storage.setState({
            sessions: {},
            sessionListRowsByServerId: {},
            ordinarySessionListMembershipByServerId: {},
            archivedSessionListMembershipByServerId: {},
            sessionListIndexByServerId: {},
            isDataReady: true,
        });
        const session = createSessionFixture({ id: 'guidance-session', serverId });
        storage.getState().applySessions([session]);
        storage.getState().applyServerScopedSessionListRows(serverId, [
            buildSessionListRenderableFromSession(storage.getState().sessions[session.id]),
        ], { source: 'ordinary', mode: 'replace' });
        expect(storage.getState().sessionListIndexByServerId[serverId]).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'session', sessionId: session.id }),
        ]));

        delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_ALLOW = 'app.ui.sessionGettingStartedGuidance';
        expect(getFeatureBuildPolicyDecision('app.ui.sessionGettingStartedGuidance')).toBe('allow');
        const allowed = await renderScreen(<SessionGettingStartedGuidance variant="sidebar" />);
        expect(allowed.findHostByTestId('session-getting-started-kind-select_session')).not.toBeNull();
    });
});
