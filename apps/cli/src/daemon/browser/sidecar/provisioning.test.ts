import { describe, expect, it, vi } from 'vitest';

import { createBrowserAutomationRuntimeProvisioner } from './provisioning';

type Candidate = Awaited<ReturnType<typeof import('./source')['resolveManagedBrowserSidecarCandidate']>>;

const NOT_INSTALLED = {
    source: 'managedBrowserPackage',
    discoveryKind: 'managedRuntime',
    available: false,
    disabledReason: 'Managed Chrome-for-Testing is not installed.',
} as unknown as Candidate;

const INSTALLED = {
    source: 'managedBrowserPackage',
    discoveryKind: 'managedRuntime',
    available: true,
    executablePath: '/tmp/chrome',
} as unknown as Candidate;

function deferred() {
    let resolve: (value: { ok: true; executablePath: string; pinnedVersion: string; integrityDigest: string }) => void = () => {};
    const promise = new Promise<{ ok: true; executablePath: string; pinnedVersion: string; integrityDigest: string }>((r) => { resolve = r; });
    return { promise, resolve };
}

describe('managed browser runtime provisioner', () => {
    it('starts one install for the first dispatch and reports it as in flight', async () => {
        const gate = deferred();
        const install = vi.fn(() => gate.promise);
        const refreshRouteOwners = vi.fn(async () => {});
        const provisioner = createBrowserAutomationRuntimeProvisioner({
            refreshRouteOwners,
            resolveManagedCandidate: vi.fn(async () => NOT_INSTALLED),
            installManagedBrowserChromium: install,
        });

        await expect(provisioner.provision()).resolves.toBe('provisioning');
        expect(install).toHaveBeenCalledOnce();
        // It must NOT block the dispatch on a ~150MB download.
        expect(refreshRouteOwners).not.toHaveBeenCalled();

        gate.resolve({ ok: true, executablePath: '/tmp/chrome', pinnedVersion: '1', integrityDigest: 'd' });
        await vi.waitFor(() => expect(refreshRouteOwners).toHaveBeenCalledOnce());
    });

    it('single-flights concurrent dispatches instead of starting a second download', async () => {
        const gate = deferred();
        const install = vi.fn(() => gate.promise);
        const provisioner = createBrowserAutomationRuntimeProvisioner({
            refreshRouteOwners: async () => {},
            resolveManagedCandidate: vi.fn(async () => NOT_INSTALLED),
            installManagedBrowserChromium: install,
        });

        const outcomes = await Promise.all([
            provisioner.provision(),
            provisioner.provision(),
            provisioner.provision(),
        ]);

        expect(outcomes).toEqual(['provisioning', 'provisioning', 'provisioning']);
        expect(install).toHaveBeenCalledOnce();
        gate.resolve({ ok: true, executablePath: '/tmp/chrome', pinnedVersion: '1', integrityDigest: 'd' });
    });

    it('reports a failed download once, then lets a later request try again', async () => {
        const install = vi.fn()
            .mockResolvedValueOnce({ ok: false, errorMessage: 'network' })
            .mockResolvedValueOnce({ ok: true, executablePath: '/tmp/chrome', pinnedVersion: '1', integrityDigest: 'd' });
        const refreshRouteOwners = vi.fn(async () => {});
        const provisioner = createBrowserAutomationRuntimeProvisioner({
            refreshRouteOwners,
            resolveManagedCandidate: vi.fn(async () => NOT_INSTALLED),
            installManagedBrowserChromium: install as never,
        });

        expect(await provisioner.provision()).toBe('provisioning');
        await vi.waitFor(() => expect(install).toHaveBeenCalledOnce());

        // The failure is surfaced distinguishably rather than silently re-downloading.
        expect(await provisioner.provision()).toBe('failed');
        // Reporting it does not schedule anything: nothing retries on its own.
        expect(install).toHaveBeenCalledOnce();

        // A later dispatch is a fresh request from a human or agent, so it may try again.
        expect(await provisioner.provision()).toBe('provisioning');
        await vi.waitFor(() => expect(install).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(refreshRouteOwners).toHaveBeenCalledOnce());
    });

    it('never downloads when the platform cannot be provisioned at all', async () => {
        const install = vi.fn();
        const provisioner = createBrowserAutomationRuntimeProvisioner({
            refreshRouteOwners: async () => {},
            resolveManagedCandidate: vi.fn(async () => null),
            installManagedBrowserChromium: install as never,
        });

        expect(await provisioner.provision()).toBe('unavailable');
        expect(install).not.toHaveBeenCalled();
    });

    it('never downloads when the artifact is already installed — a missing route is not a provisioning problem', async () => {
        const install = vi.fn();
        const provisioner = createBrowserAutomationRuntimeProvisioner({
            refreshRouteOwners: async () => {},
            resolveManagedCandidate: vi.fn(async () => INSTALLED),
            installManagedBrowserChromium: install as never,
        });

        expect(await provisioner.provision()).toBe('unavailable');
        expect(install).not.toHaveBeenCalled();
    });

    it('reports a returned install failure to onError, not only a thrown one', async () => {
        // F-BROWSER-2: a `{ ok: false }` install result set `unreportedFailure` and returned, so the
        // reason (an extractor rejection, a bad digest, a 404) never reached the daemon log. The
        // dispatch answer alone is 'failed' — it carries no cause.
        const onError = vi.fn();
        const provisioner = createBrowserAutomationRuntimeProvisioner({
            refreshRouteOwners: async () => {},
            resolveManagedCandidate: vi.fn(async () => NOT_INSTALLED),
            installManagedBrowserChromium: vi.fn(async () => ({
                ok: false as const,
                errorMessage: '[release-runtime] archive entry type is not supported',
            })),
            onError,
        });

        expect(await provisioner.provision()).toBe('provisioning');
        await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
        expect(String(onError.mock.calls[0]?.[0])).toContain(
            '[release-runtime] archive entry type is not supported',
        );
        expect(await provisioner.provision()).toBe('failed');
    });

    it('treats a thrown installer as a reportable failure, not an unhandled rejection', async () => {
        const onError = vi.fn();
        const provisioner = createBrowserAutomationRuntimeProvisioner({
            refreshRouteOwners: async () => {},
            resolveManagedCandidate: vi.fn(async () => NOT_INSTALLED),
            installManagedBrowserChromium: vi.fn(async () => { throw new Error('disk full'); }),
            onError,
        });

        expect(await provisioner.provision()).toBe('provisioning');
        await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
        expect(await provisioner.provision()).toBe('failed');
    });
});
