import { afterEach, expect, it } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { storage } from '@/sync/domains/state/storage';
import type { SessionGettingStartedDecisionKind } from '@/components/sessions/guidance/gettingStartedModel';
import { useHomeHubGuidanceKind } from './useHomeHubGuidanceKind';

let home: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
afterEach(async () => {
    standardCleanup();
    retireActiveServerAccountScopeLifetime();
    await home?.dispose();
    home = undefined;
});

it('keeps first-Machine setup on Home while open and releases offline guidance when closed', async () => {
    type Input = { kind: SessionGettingStartedDecisionKind; machineSetupOpen: boolean };
    const hook = await renderHook<ReturnType<typeof useHomeHubGuidanceKind>, Input>(
        ({ kind, machineSetupOpen }) => useHomeHubGuidanceKind(kind, false, machineSetupOpen),
        { initialProps: { kind: 'connect_machine', machineSetupOpen: false } satisfies Input },
    );
    expect(hook.getCurrent()).toBe('connect_machine');
    await hook.rerender({ kind: 'connect_machine', machineSetupOpen: true });
    await hook.rerender({ kind: 'start_daemon', machineSetupOpen: true });
    expect(hook.getCurrent()).toBe('connect_machine');
    await hook.rerender({ kind: 'start_daemon', machineSetupOpen: false });
    expect(hook.getCurrent()).toBe('start_daemon');
});

it('retains only this Account lifetime’s committed hub during a reach failure and preserves fresh setup', async () => {
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://home-continuity.test', accountId: 'account-a' }], route: () => undefined });
    const server = home.homes.a!;
    publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
    storage.setState({ profileScope: { serverId: server.id, accountId: 'account-a' } });
    type Input = { kind: SessionGettingStartedDecisionKind; unavailable: boolean };
    const hook = await renderHook<ReturnType<typeof useHomeHubGuidanceKind>, Input>(({ kind, unavailable }) => useHomeHubGuidanceKind(kind, unavailable),
        { initialProps: { kind: 'start_daemon', unavailable: true } satisfies Input });
    expect(hook.getCurrent()).toBe('start_daemon');
    await hook.rerender({ kind: 'select_session', unavailable: false });
    expect(hook.getCurrent()).toBe('select_session');
    await hook.rerender({ kind: 'start_daemon', unavailable: true });
    expect(hook.getCurrent()).toBe('select_session');
    await hook.rerender({ kind: 'loading', unavailable: true });
    expect(hook.getCurrent()).toBe('select_session');
    // Explicit retirement is an authority boundary, even for the same Account.
    retireActiveServerAccountScopeLifetime();
    await hook.rerender({ kind: 'start_daemon', unavailable: true });
    expect(hook.getCurrent()).toBe('start_daemon');
});
