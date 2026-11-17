import { SystemTaskResultSchema } from '@happier-dev/protocol/system/tasks/spec';
import * as React from 'react';
import { HomeGovernanceClaimResultV1Schema } from '@happier-dev/protocol/home/governance';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Imported from their own testkit modules rather than the `@/dev/testkit` barrel, so the barrel
 * cannot bind the real transports before `installHomeGovernanceBoundaries` replaces the network.
 */
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { homeGovernanceProjectionFixture } from '@/dev/testkit/fixtures/homeGovernanceFixtures';
import {
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
    waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { createSystemTaskRunner } from '@/components/systemTasks/createSystemTaskRunner';
import { createUnavailableSystemTaskBridge } from '@/components/systemTasks/createUnavailableSystemTaskBridge';
import type { SystemTaskRunner } from '@/components/systemTasks/types';

import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installSettingsViewCommonModuleMocks({
    storage: 'real',
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ confirmResult: true }).module;
    },
});
vi.mock('@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts', () => ({
    BUNDLED_PLUGIN_UI_APP_ARTIFACTS: [],
    BUNDLED_PLUGIN_UI_APP_DECLARATIONS: [],
}));

// Only the network and the device credential store are replaced; the claim operation, the Action
// executor, the governance engine and the local runtime controller below the screen are real.
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { HomeClaimSetup } = await import('./HomeClaimSetup');
await import('@/sync/ops/actions/defaultActionExecutor');

const CLAIM_PATH = '/v1/home/governance/claim';
const GOVERNANCE_PATH = '/v1/home/governance/get';
const PERSONAL_HOME_URL = 'http://127.0.0.1:43123';
/** 52 base32 characters, as `happier-server --print-home-claim-code` prints them: grouped by four. */
const CANONICAL_CODE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRST';
const PRINTED_CODE = CANONICAL_CODE.match(/.{1,4}/g)!.join('-');

/**
 * The desktop's system-task bridge is the boundary: it answers the runtime status with the
 * purpose it is given and holds every other task until the test settles it.
 */
function createDesktopBridge(purpose: Readonly<Record<string, unknown>> | null) {
    const listeners = new Map<string, (payload: unknown) => void>();
    const started: Array<{ kind: string; params: Record<string, unknown> }> = [];
    const runner: SystemTaskRunner = createSystemTaskRunner({
        bridge: {
            async start(spec: unknown) {
                const parsed = spec as { kind: string; params: Record<string, unknown> };
                started.push(parsed);
                return `task_${started.length}:${parsed.kind}`;
            },
            async subscribe(taskId, listenerSet) {
                listeners.set(taskId, listenerSet.onResult);
                if (taskId.endsWith('relay.runtime.status.v1')) {
                    listenerSet.onResult(SystemTaskResultSchema.parse({
                        protocolVersion: 1,
                        taskId,
                        ok: true,
                        data: {
                            installed: true,
                            version: '1',
                            relayUrl: typeof purpose?.canonicalServerUrl === 'string' ? purpose.canonicalServerUrl : PERSONAL_HOME_URL,
                            healthy: true,
                            dataPresent: true,
                            purpose,
                            anonymousSignupEnabled: false,
                            service: { active: true, enabled: true },
                        },
                    }));
                }
                return () => { listeners.delete(taskId); };
            },
            async cancel() {},
            async respond() {},
        },
    });
    return {
        runner,
        started,
        async settle(kind: string, data: unknown) {
            const index = started.findIndex((spec) => spec.kind === kind);
            const taskId = `task_${index + 1}:${kind}`;
            await act(async () => {
                listeners.get(taskId)?.({ protocolVersion: 1, taskId, ok: true, data });
            });
        },
    };
}

async function renderClaim(serverId: string, runner?: SystemTaskRunner) {
    const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
    // The scope names the Home the way the credential binding does: by its identity once it has one.
    const scopeServerId = resolveServerProfileScopeIdForIdentifier(serverId);
    return await renderScreen(
        <HomeClaimSetup scope={{ serverId: scopeServerId, accountId: 'owner' }} homeName="Personal Home" {...(runner ? { runner } : {})} />,
    );
}

async function addPersonalHome(): Promise<string> {
    const { adoptPersonalHomeProfileAndComplete } = await import('@/sync/domains/server/serverProfiles');
    await adoptPersonalHomeProfileAndComplete({
        descriptor: { serverUrl: PERSONAL_HOME_URL, canonicalServerUrl: PERSONAL_HOME_URL, homeServerIdentityId: 'srv_personal_home_1' },
        source: 'desktop-personal-home',
    });
    return await harness.addHome({ name: 'Personal Home', serverUrl: PERSONAL_HOME_URL, accountId: 'owner' });
}

beforeEach(async () => {
    await harness.reset();
    const { resetHomeGovernanceEngineForTests } = await import('@/sync/engine/home/governance/homeGovernanceEngine');
    const { resetHomeGovernanceSnapshotsForTests } = await import('@/sync/store/home/governance/homeGovernanceSnapshots');
    resetHomeGovernanceEngineForTests();
    resetHomeGovernanceSnapshotsForTests();
});
afterEach(() => {
    standardCleanup();
});

describe('HomeClaimSetup with a one-time code', () => {
    it('keeps Claim disabled until the text can be a code, then claims with the canonical code and re-reads the Home', async () => {
        const serverId = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'owner' });
        harness.answer(serverId, CLAIM_PATH, { body: HomeGovernanceClaimResultV1Schema.parse({ status: 'claimed' }) });
        harness.answer(serverId, GOVERNANCE_PATH, { body: homeGovernanceProjectionFixture() });
        const screen = await renderClaim(serverId);

        // The command is shown the way every CLI command is (the shared code block with Copy), never as a field.
        expect(screen.findByTestId('home-claim-command')).not.toBeNull();
        expect(screen.findByTestId('home-claim-command')?.props.onChangeText).toBeUndefined();
        expect(screen.getTextContent().replace(/[|\s]/g, '')).toContain('happier-server--print-home-claim-code');
        expect(screen.findByTestId('home-claim-submit')?.props.disabled).toBe(true);
        await act(async () => { screen.changeTextByTestId('home-claim-code-input', 'K7QM-2XRT'); });
        expect(screen.findByTestId('home-claim-submit')?.props.disabled).toBe(true);
        await act(async () => { screen.changeTextByTestId('home-claim-code-input', ` ${PRINTED_CODE.toLowerCase()} `); });
        expect(screen.findByTestId('home-claim-submit')?.props.disabled).toBe(false);

        await screen.pressByTestIdAsync('home-claim-submit');
        await waitForHomeGovernance(() => expect(harness.requestsFor(CLAIM_PATH)).toHaveLength(1));
        expect(harness.requestsFor(CLAIM_PATH)[0]?.input).toEqual({ code: CANONICAL_CODE });
        await waitForHomeGovernance(() => expect(harness.requestsFor(GOVERNANCE_PATH).length).toBeGreaterThan(0));
    });

    it('says the same thing for every refusal and clears it once the code is edited', async () => {
        const serverId = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'owner' });
        harness.answer(serverId, CLAIM_PATH, { status: 403, body: { error: 'home_claim_refused' } });
        const screen = await renderClaim(serverId);

        await act(async () => { screen.changeTextByTestId('home-claim-code-input', PRINTED_CODE); });
        await screen.pressByTestIdAsync('home-claim-submit');
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('homeGovernance.claim.refused'));
        expect(harness.requestsFor(GOVERNANCE_PATH)).toHaveLength(0);

        await act(async () => { screen.changeTextByTestId('home-claim-code-input', `${PRINTED_CODE}X`); });
        expect(screen.getTextContent()).not.toContain('homeGovernance.claim.refused');
    });

    it('offers no hosting-desktop claim on a device without a local runtime executor', async () => {
        const serverId = await addPersonalHome();
        // A browser or phone: the platform has no system-task executor.
        const screen = await renderClaim(serverId, createSystemTaskRunner({
            bridge: createUnavailableSystemTaskBridge(),
            mode: 'unavailable',
        }));

        expect(screen.findByTestId('home-claim-host')).toBeNull();
        expect(screen.findByTestId('home-claim-code-input')).not.toBeNull();
    });
});

describe('HomeClaimSetup on the hosting desktop', () => {
    it('makes the viewer the owner through the local claim task and re-reads the Home when it completes', async () => {
        const serverId = await addPersonalHome();
        harness.answer(serverId, GOVERNANCE_PATH, { body: homeGovernanceProjectionFixture() });
        const desktop = createDesktopBridge({ kind: 'personal-home', canonicalServerUrl: PERSONAL_HOME_URL });
        const screen = await renderClaim(serverId, desktop.runner);

        await waitForHomeGovernance(() => expect(screen.findByTestId('home-claim-host')).not.toBeNull());
        // No other claim path is shown on the hosting desktop.
        expect(screen.findByTestId('home-claim-code-input')).toBeNull();

        await act(async () => { screen.pressByTestId('home-claim-host-make-owner'); });
        await waitForHomeGovernance(() => expect(
            desktop.started.some((spec) => spec.kind === 'relay.runtime.personal_home.claim_owner.v1'),
        ).toBe(true));
        expect(desktop.started.find((spec) => spec.kind === 'relay.runtime.personal_home.claim_owner.v1')?.params).toMatchObject({
            accountId: 'owner',
            purpose: { kind: 'personal-home', canonicalServerUrl: PERSONAL_HOME_URL },
        });
        expect(harness.requestsFor(GOVERNANCE_PATH)).toHaveLength(0);

        await desktop.settle('relay.runtime.personal_home.claim_owner.v1', {
            v: 1,
            command: 'claim-home-owner',
            intent: 'initial_claim',
            homeServerIdentityId: 'srv_personal_home_1',
            targetAccountId: 'owner',
            result: { status: 'claimed', ownerAccountId: 'owner' },
        });
        await waitForHomeGovernance(() => expect(harness.requestsFor(GOVERNANCE_PATH).length).toBeGreaterThan(0));
        expect(harness.requestsFor(CLAIM_PATH)).toHaveLength(0);
        expect(screen.getTextContent()).not.toContain('homeGovernance.claim.hostFailed');
    });

    it('says the claim did not happen when the command refuses the Account, and still re-reads the Home', async () => {
        const serverId = await addPersonalHome();
        harness.answer(serverId, GOVERNANCE_PATH, { status: 409, body: { error: 'home_governance_setup_required' } });
        const desktop = createDesktopBridge({ kind: 'personal-home', canonicalServerUrl: PERSONAL_HOME_URL });
        const screen = await renderClaim(serverId, desktop.runner);
        await waitForHomeGovernance(() => expect(screen.findByTestId('home-claim-host')).not.toBeNull());

        await act(async () => { screen.pressByTestId('home-claim-host-make-owner'); });
        await waitForHomeGovernance(() => expect(
            desktop.started.some((spec) => spec.kind === 'relay.runtime.personal_home.claim_owner.v1'),
        ).toBe(true));
        await desktop.settle('relay.runtime.personal_home.claim_owner.v1', {
            v: 1,
            command: 'claim-home-owner',
            intent: 'initial_claim',
            homeServerIdentityId: 'srv_personal_home_1',
            targetAccountId: 'owner',
            result: { status: 'target_inactive' },
        });

        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('homeGovernance.claim.hostFailed'));
        await waitForHomeGovernance(() => expect(harness.requestsFor(GOVERNANCE_PATH).length).toBeGreaterThan(0));
    });

    it('keeps the code claim when the local runtime is not this Personal Home', async () => {
        const serverId = await addPersonalHome();
        const desktop = createDesktopBridge({ kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:43999' });
        const screen = await renderClaim(serverId, desktop.runner);

        await waitForHomeGovernance(() => expect(desktop.started.some((spec) => spec.kind === 'relay.runtime.status.v1')).toBe(true));
        expect(screen.findByTestId('home-claim-host')).toBeNull();
        expect(screen.findByTestId('home-claim-code-input')).not.toBeNull();
    });
});
