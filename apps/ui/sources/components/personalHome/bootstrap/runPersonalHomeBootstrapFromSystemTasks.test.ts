import type { HomeConnectionDescriptorV1} from '@happier-dev/protocol/auth/accountDirectory';
import type { SystemTaskJsonObject, SystemTaskResult } from '@happier-dev/protocol/system/tasks/spec';
import { describe, expect, it } from 'vitest';

import {
    PersonalHomeDescriptorUnverifiedError,
    PersonalHomeExistingRuntimeConflictError,
    runPersonalHomeBootstrapFromSystemTasks,
    type PersonalHomeBootstrapSystemTaskDeps,
    type PersonalHomeBootstrapTaskKind,
    type PersonalHomeBootstrapTaskOptions,
} from './runPersonalHomeBootstrapFromSystemTasks';

type RuntimeState = {
    installed: boolean;
    dataPresent: boolean;
    healthy: boolean;
    signup: 'enabled' | 'disabled';
    purpose: 'personal-home' | 'generic' | null;
};

function taskResult(taskId: string, data: SystemTaskJsonObject): SystemTaskResult {
    return {
        protocolVersion: 1,
        taskId,
        ok: true,
        data,
    };
}

function createHarness(options: Readonly<{
    initiallyInstalled?: boolean;
    initiallyStopped?: boolean;
    initialPurpose?: RuntimeState['purpose'];
    refusalVerified?: boolean;
    initialSignupPolicyKnown?: boolean;
    persistedSignupPolicyKnownAfterClosureUpdate?: boolean;
    storagePolicy?: 'required_e2ee' | 'optional' | 'plaintext_only';
    seedCredentials?: string;
    homeAcceptedToken?: string;
    failFirstAdoption?: boolean;
    failProfilePreflight?: boolean;
    dataPresent?: boolean;
    /** Simulates an explicit erase/uninstall winning immediately after this install mutation. */
    eraseAfterInstallNumber?: number;
    /** Simulates an explicit lifecycle operation winning after credentials but before closure. */
    interruptBeforeClosure?: 'erase' | 'uninstall';
    /** /v1/features descriptor published by the endpoint probes (as parsed by the probe owner). */
    homeConnectionDescriptor?: HomeConnectionDescriptorV1;
    suppressDescriptor?: boolean;
}> = {}) {
    const canonicalServerUrl = 'http://127.0.0.1:43123';
    const runtime: RuntimeState = {
        installed: options.initiallyInstalled === true || options.initiallyStopped === true,
        dataPresent: options.dataPresent
            ?? (options.initiallyInstalled === true || options.initiallyStopped === true),
        healthy: options.initiallyStopped === true ? false : options.initiallyInstalled === true,
        signup: 'enabled',
        purpose: options.initialPurpose ?? null,
    };
    const homeAcceptedToken = options.homeAcceptedToken ?? options.seedCredentials ?? 'home-b-token';
    const calls: string[] = [];
    const taskCalls: Array<Readonly<{ kind: PersonalHomeBootstrapTaskKind; options: PersonalHomeBootstrapTaskOptions }>> = [];
    let credentials: Readonly<{ token: string }> | null = options.seedCredentials
        ? { token: options.seedCredentials }
        : null;
    let accountCreations = 0;
    let adoptionAttempts = 0;
    const adoptedInputs: Array<Parameters<PersonalHomeBootstrapSystemTaskDeps['adoptCompletedProfile']>[0]> = [];
    let refusalVerified = options.refusalVerified !== false;
    let hasManagedSignupUpdate = false;
    let hasClosedSignupUpdate = false;
    let pendingSeedAvailable = false;
    let installCount = 0;
    let completionSource: string | null = null;
    const focusedHome = { id: 'home-a' };

    const statusData = (): SystemTaskJsonObject => {
        const purpose: SystemTaskJsonObject | null = runtime.purpose === 'personal-home'
            ? { kind: 'personal-home', canonicalServerUrl }
            : runtime.purpose === 'generic'
                ? { kind: 'generic' }
                : null;
        return {
            installed: runtime.installed,
            dataPresent: runtime.dataPresent,
            version: runtime.installed ? '0.3.0-test' : null,
            relayUrl: canonicalServerUrl,
            healthy: runtime.healthy,
            service: {
                active: runtime.installed ? runtime.healthy : null,
                enabled: runtime.installed ? true : null,
            },
            ...(purpose ? { purpose } : {}),
            ...(runtime.purpose === 'personal-home' ? { canonicalServerUrl } : {}),
            anonymousSignupEnabled: runtime.purpose === 'personal-home'
                && (
                    runtime.signup === 'disabled' && hasClosedSignupUpdate
                        ? options.persistedSignupPolicyKnownAfterClosureUpdate !== false
                        : hasManagedSignupUpdate || options.initialSignupPolicyKnown !== false
                )
                ? runtime.signup === 'enabled'
                : null,
        };
    };

    const defaultDescriptor: HomeConnectionDescriptorV1 = {
        v: 1,
        homeServerIdentityId: 'home-b-identity',
        canonicalServerUrl,
        revision: 1,
        endpoints: [{ kind: 'iroh', endpointId: 'a'.repeat(64) }],
    };
    const deps: PersonalHomeBootstrapSystemTaskDeps = {
        runRelayTask: async (kind, taskOptions) => {
            taskCalls.push({ kind, options: taskOptions });
            calls.push(`task:${kind}:${taskOptions.anonymousSignupEnabled ?? 'unset'}`);
            if (kind === 'relay.runtime.installOrUpdate.v1') {
                installCount += 1;
                runtime.installed = true;
                runtime.dataPresent = true;
                runtime.healthy = true;
                runtime.purpose = 'personal-home';
                runtime.signup = taskOptions.anonymousSignupEnabled === false ? 'disabled' : 'enabled';
                hasManagedSignupUpdate = true;
                if (taskOptions.anonymousSignupEnabled === false) hasClosedSignupUpdate = true;
                if (installCount === options.eraseAfterInstallNumber) {
                    runtime.installed = false;
                    runtime.dataPresent = false;
                    runtime.healthy = false;
                    runtime.purpose = null;
                }
            } else if (kind === 'relay.runtime.start.v1' || kind === 'relay.runtime.restart.v1') {
                runtime.healthy = true;
            }
            return taskResult(`task-${taskCalls.length}`, statusData());
        },
        probeEndpoint: async () => {
            calls.push('probe:endpoint');
            if (!runtime.installed || !runtime.healthy) return { status: 'unreachable' };
            return {
                status: 'ready',
                serverIdentityId: 'home-b-identity',
                storagePolicy: options.storagePolicy ?? 'plaintext_only',
                anonymousSignup: runtime.signup,
                ...(!options.suppressDescriptor && options.homeConnectionDescriptor === undefined
                    ? { homeConnectionDescriptor: defaultDescriptor }
                    : options.homeConnectionDescriptor
                        ? { homeConnectionDescriptor: options.homeConnectionDescriptor }
                        : {}),
            };
        },
        readCredentials: async (input) => {
            calls.push(`credentials:read:${input.serverIdentityId}`);
            return credentials;
        },
        createLocalAccount: async (input) => {
            calls.push(`account:create:${input.serverIdentityId}`);
            accountCreations += 1;
            return { token: 'home-b-token' };
        },
        preparePendingBootstrapSeed: async (input) => {
            calls.push(`seed:prepare:${input.serverIdentityId ?? 'url'}:${input.allowCreate ? 'create' : 'reuse'}`);
            if (input.allowCreate) pendingSeedAvailable = true;
            return pendingSeedAvailable;
        },
        persistCredentials: async (input) => {
            calls.push(`credentials:persist:${input.serverIdentityId}`);
            credentials = input.credentials;
            if (options.interruptBeforeClosure === 'erase') {
                runtime.dataPresent = false;
                runtime.healthy = false;
            } else if (options.interruptBeforeClosure === 'uninstall') {
                runtime.installed = false;
                runtime.healthy = false;
            }
            return true;
        },
        verifyAuthenticatedAccess: async (input) => {
            calls.push(`auth:verify:${input.token}`);
            return runtime.healthy && input.token === homeAcceptedToken;
        },
        clearPendingBootstrapSeed: async (input) => {
            calls.push(`seed:clear:${input.serverUrl}:${input.serverIdentityId}`);
            pendingSeedAvailable = false;
            return true;
        },
        preflightCompletedProfile: () => {
            calls.push('profile:preflight');
            if (options.failProfilePreflight) throw new Error('Home identity conflicts with URL');
        },
        probeAnonymousSignupRefused: async () => {
            calls.push('signup:refusal');
            return runtime.signup === 'disabled' && refusalVerified;
        },
        adoptCompletedProfile: async (input) => {
            calls.push('profile:adopt');
            adoptionAttempts += 1;
            adoptedInputs.push(input);
            if (options.failFirstAdoption === true && adoptionAttempts === 1) {
                throw new Error('profile source temporarily unavailable');
            }
            completionSource = 'personal-home';
            return { id: 'home-b-profile' };
        },
    };

    return {
        accountCreations: () => accountCreations,
        adoptedInputs: () => adoptedInputs,
        adoptionAttempts: () => adoptionAttempts,
        calls,
        canonicalServerUrl,
        completionSource: () => completionSource,
        credentials: () => credentials,
        deps,
        focusedHome,
        runtime,
        setRefusalVerified(value: boolean) {
            refusalVerified = value;
        },
        taskCalls,
    };
}

describe('runPersonalHomeBootstrapFromSystemTasks', () => {
    it('surfaces retained local data through existing-runtime recovery before install or account mutation', async () => {
        const freshAttempt = createHarness({ dataPresent: true });

        await expect(runPersonalHomeBootstrapFromSystemTasks({
            deps: freshAttempt.deps,
        })).rejects.toBeInstanceOf(PersonalHomeExistingRuntimeConflictError);

        expect(freshAttempt.taskCalls.map((entry) => entry.kind)).toEqual(['relay.runtime.status.v1']);
        expect(freshAttempt.accountCreations()).toBe(0);
        expect(freshAttempt.adoptionAttempts()).toBe(0);
        expect(freshAttempt.credentials()).toBeNull();

        const recoveryAttempt = createHarness({ dataPresent: true });
        await expect(runPersonalHomeBootstrapFromSystemTasks({
            deps: recoveryAttempt.deps,
            existingRuntimeDisposition: 'use-this-local-home',
        })).rejects.toBeInstanceOf(PersonalHomeExistingRuntimeConflictError);
        expect(recoveryAttempt.taskCalls.map((entry) => entry.kind)).toEqual(['relay.runtime.status.v1']);
        expect(recoveryAttempt.accountCreations()).toBe(0);
    });

    it('reinstalls a safely uninstalled classified Personal Home with signup closed and the existing credential', async () => {
        const harness = createHarness({
            initialPurpose: 'personal-home',
            dataPresent: true,
            seedCredentials: 'existing-home-token',
        });

        const result = await runPersonalHomeBootstrapFromSystemTasks({
            deps: harness.deps,
        });

        expect(result.accountCreated).toBe(false);
        expect(harness.accountCreations()).toBe(0);
        expect(harness.adoptionAttempts()).toBe(1);
        expect(harness.taskCalls.map((entry) => [entry.kind, entry.options.anonymousSignupEnabled])).toEqual([
            ['relay.runtime.status.v1', undefined],
            ['relay.runtime.installOrUpdate.v1', false],
            ['relay.runtime.status.v1', undefined],
            ['relay.runtime.status.v1', undefined],
            ['relay.runtime.installOrUpdate.v1', false],
            ['relay.runtime.status.v1', undefined],
            ['relay.runtime.status.v1', undefined],
        ]);
        expect(harness.taskCalls[1]?.options.purpose).toEqual({
            kind: 'personal-home',
            canonicalServerUrl: harness.canonicalServerUrl,
        });
    });

    it('does not create an account over retained data when a classified Personal Home has no credential', async () => {
        const harness = createHarness({
            initiallyInstalled: true,
            initialPurpose: 'personal-home',
            dataPresent: true,
        });

        await expect(runPersonalHomeBootstrapFromSystemTasks({
            deps: harness.deps,
        })).rejects.toMatchObject({ code: 'personal_home_credentials_unverified' });

        expect(harness.accountCreations()).toBe(0);
        expect(harness.adoptionAttempts()).toBe(0);
        expect(harness.credentials()).toBeNull();
    });

    it('recreates an erased no-data Personal Home only when an explicit retry authorizes it', async () => {
        const harness = createHarness({
            initiallyInstalled: true,
            initialPurpose: 'personal-home',
            dataPresent: false,
            initialSignupPolicyKnown: false,
        });

        await expect(runPersonalHomeBootstrapFromSystemTasks({
            deps: harness.deps,
        })).rejects.toMatchObject({ code: 'personal_home_erased_retry_required' });
        expect(harness.taskCalls.map((entry) => entry.kind)).toEqual(['relay.runtime.status.v1']);

        harness.taskCalls.length = 0;
        const result = await runPersonalHomeBootstrapFromSystemTasks({
            deps: harness.deps,
            allowErasedRuntimeRecreate: true,
        });

        expect(result.profileId).toBe('home-b-profile');
        expect(harness.taskCalls.map((entry) => entry.kind)).toEqual([
            'relay.runtime.status.v1',
            'relay.runtime.installOrUpdate.v1',
            'relay.runtime.status.v1',
            'relay.runtime.status.v1',
            'relay.runtime.installOrUpdate.v1',
            'relay.runtime.status.v1',
            'relay.runtime.status.v1',
        ]);
        expect(harness.taskCalls.some((entry) => entry.kind === 'relay.runtime.start.v1' || entry.kind === 'relay.runtime.restart.v1')).toBe(false);
    });

    it('drives the production caller through canonical install/update readbacks, refusal/readback, token-only adoption, and leaves another Home focused', async () => {
        const harness = createHarness();
        const focusBefore = harness.focusedHome.id;

        const result = await runPersonalHomeBootstrapFromSystemTasks({
            deps: harness.deps,
        });

        expect(harness.taskCalls.map((entry) => [entry.kind, entry.options.anonymousSignupEnabled])).toEqual([
            ['relay.runtime.status.v1', undefined],
            ['relay.runtime.installOrUpdate.v1', true],
            ['relay.runtime.status.v1', undefined],
            ['relay.runtime.status.v1', undefined],
            ['relay.runtime.installOrUpdate.v1', false],
            ['relay.runtime.status.v1', undefined],
            ['relay.runtime.status.v1', undefined],
        ]);
        expect(harness.runtime.signup).toBe('disabled');
        expect(harness.credentials()).toEqual({ token: 'home-b-token' });
        expect(harness.completionSource()).toBe('personal-home');
        expect(harness.adoptedInputs()[0]?.connectionDescriptor).toEqual(expect.objectContaining({
            homeServerIdentityId: 'home-b-identity',
        }));
        expect(result.profileId).toBe('home-b-profile');
        expect(harness.focusedHome.id).toBe(focusBefore);
        expect(harness.calls.indexOf('signup:refusal')).toBeLessThan(harness.calls.indexOf('profile:adopt'));
        expect(harness.calls.lastIndexOf('auth:verify:home-b-token')).toBeLessThan(harness.calls.indexOf('profile:adopt'));
    });

    it('does not start after an explicit erase wins immediately after the initial install/update', async () => {
        const harness = createHarness({ eraseAfterInstallNumber: 1 });

        await expect(runPersonalHomeBootstrapFromSystemTasks({
            deps: harness.deps,
        })).rejects.toThrow('Personal Home runtime is not healthy after install/update.');

        expect(harness.taskCalls.map((entry) => entry.kind)).toEqual([
            'relay.runtime.status.v1',
            'relay.runtime.installOrUpdate.v1',
            'relay.runtime.status.v1',
        ]);
        expect(harness.accountCreations()).toBe(0);
    });

    it('does not restart after an explicit erase wins immediately after the signup-closure install/update', async () => {
        const harness = createHarness({ eraseAfterInstallNumber: 2 });

        await expect(runPersonalHomeBootstrapFromSystemTasks({
            deps: harness.deps,
        })).rejects.toThrow('Personal Home runtime is not healthy after install/update.');

        expect(harness.taskCalls.map((entry) => entry.kind)).toEqual([
            'relay.runtime.status.v1',
            'relay.runtime.installOrUpdate.v1',
            'relay.runtime.status.v1',
            'relay.runtime.status.v1',
            'relay.runtime.installOrUpdate.v1',
            'relay.runtime.status.v1',
        ]);
        expect(harness.accountCreations()).toBe(1);
    });

    it.each(['erase', 'uninstall'] as const)(
        'does not start the closure mutation after an explicit %s wins between bootstrap boundaries',
        async (interruption) => {
            const harness = createHarness({ interruptBeforeClosure: interruption });

            await expect(runPersonalHomeBootstrapFromSystemTasks({
                deps: harness.deps,
            })).rejects.toThrow('Personal Home runtime is not healthy after install/update.');

            expect(harness.taskCalls.map((entry) => entry.kind)).toEqual([
                'relay.runtime.status.v1',
                'relay.runtime.installOrUpdate.v1',
                'relay.runtime.status.v1',
                'relay.runtime.status.v1',
            ]);
            expect(harness.taskCalls.filter((entry) => entry.kind === 'relay.runtime.installOrUpdate.v1')).toHaveLength(1);
        },
    );

    it('refuses completion when final managed status cannot prove persisted signup closure', async () => {
        const harness = createHarness({ persistedSignupPolicyKnownAfterClosureUpdate: false });

        await expect(runPersonalHomeBootstrapFromSystemTasks({
            deps: harness.deps,
        })).rejects.toMatchObject({ code: 'personal_home_signup_closure_unverified' });

        expect(harness.runtime.signup).toBe('disabled');
        expect(harness.adoptionAttempts()).toBe(0);
        expect(harness.completionSource()).toBeNull();
    });

    it('carries the /v1/features Home descriptor through completion into canonical adoption', async () => {
        const descriptor: HomeConnectionDescriptorV1 = {
            v: 1,
            homeServerIdentityId: 'home-b-identity',
            canonicalServerUrl: 'http://127.0.0.1:43123',
            revision: 4,
            endpoints: [
                { kind: 'iroh', endpointId: 'a'.repeat(64), relayUrls: ['https://relay.example.test'] },
            ],
        };
        const harness = createHarness({ homeConnectionDescriptor: descriptor });

        const result = await runPersonalHomeBootstrapFromSystemTasks({
            deps: harness.deps,
        });

        expect(result.profileId).toBe('home-b-profile');
        // The exact parsed descriptor is forwarded as the canonical adoption input.
        expect(harness.adoptedInputs()[0]?.connectionDescriptor).toEqual(descriptor);
    });

    it('rejects completion when the published descriptor identity disagrees with the verified server identity', async () => {
        const descriptor: HomeConnectionDescriptorV1 = {
            v: 1,
            homeServerIdentityId: 'srv_other_home_identity',
            canonicalServerUrl: 'http://127.0.0.1:43123',
            revision: 4,
            endpoints: [
                { kind: 'iroh', endpointId: 'a'.repeat(64) },
            ],
        };
        const harness = createHarness({ homeConnectionDescriptor: descriptor });

        await expect(runPersonalHomeBootstrapFromSystemTasks({
            deps: harness.deps,
        })).rejects.toBeInstanceOf(PersonalHomeDescriptorUnverifiedError);

        expect(harness.adoptionAttempts()).toBe(0);
    });

    it('completes local bootstrap with a valid authenticated HTTPS descriptor before Iroh is available', async () => {
        const descriptor: HomeConnectionDescriptorV1 = {
            v: 1,
            homeServerIdentityId: 'home-b-identity',
            canonicalServerUrl: 'http://127.0.0.1:43123',
            revision: 4,
            endpoints: [{ kind: 'https', url: 'https://home.example.test' }],
        };
        const harness = createHarness({ homeConnectionDescriptor: descriptor });

        const result = await runPersonalHomeBootstrapFromSystemTasks({ deps: harness.deps });

        expect(result.profileId).toBe('home-b-profile');
        expect(harness.adoptedInputs()[0]?.connectionDescriptor).toEqual(descriptor);
    });

    it('admits an installed generic runtime only when it has no data', async () => {
        const harness = createHarness({ initiallyInstalled: true, initialPurpose: 'generic', dataPresent: false });

        const result = await runPersonalHomeBootstrapFromSystemTasks({ deps: harness.deps });

        expect(result.profileId).toBe('home-b-profile');
        expect(harness.accountCreations()).toBe(1);
        expect(harness.runtime.purpose).toBe('personal-home');
    });

    it('releases the pending bootstrap seed exactly once, only after the persisted credentials verified', async () => {
        const harness = createHarness();

        const result = await runPersonalHomeBootstrapFromSystemTasks({
            deps: harness.deps,
        });

        expect(result.accountCreated).toBe(true);
        const persistIndex = harness.calls.indexOf('credentials:persist:home-b-identity');
        const clearIndex = harness.calls.indexOf(`seed:clear:${harness.canonicalServerUrl}:home-b-identity`);
        expect(persistIndex).toBeGreaterThan(-1);
        expect(clearIndex).toBeGreaterThan(persistIndex);
        // Release happens at the first successful authenticated readback of the persisted
        // credential (post-restart), never before and never twice.
        expect(harness.calls.lastIndexOf('auth:verify:home-b-token')).toBeLessThan(clearIndex);
        expect(harness.calls.filter((entry) => entry.startsWith('seed:clear:'))).toHaveLength(1);
    });

    it('keeps the pending bootstrap seed when the run fails before verified credentials', async () => {
        const harness = createHarness({ refusalVerified: false });

        await expect(runPersonalHomeBootstrapFromSystemTasks({
            deps: harness.deps,
        })).rejects.toMatchObject({ code: 'personal_home_signup_closure_unverified' });

        expect(harness.calls.filter((entry) => entry.startsWith('seed:clear:'))).toEqual([]);
        expect(harness.calls.filter((entry) => entry.startsWith('auth:verify:'))).toEqual([]);
    });

    it('keeps a failed refusal retryable without creating a duplicate account or reopening signup', async () => {
        const harness = createHarness({ refusalVerified: false });

        await expect(runPersonalHomeBootstrapFromSystemTasks({
            deps: harness.deps,
        })).rejects.toMatchObject({ code: 'personal_home_signup_closure_unverified' });
        expect(harness.completionSource()).toBeNull();
        expect(harness.accountCreations()).toBe(1);

        harness.setRefusalVerified(true);
        harness.taskCalls.length = 0;
        const result = await runPersonalHomeBootstrapFromSystemTasks({
            deps: harness.deps,
        });

        expect(result.profileId).toBe('home-b-profile');
        expect(harness.accountCreations()).toBe(1);
        expect(harness.taskCalls
            .filter((entry) => entry.kind === 'relay.runtime.installOrUpdate.v1')
            .every((entry) => entry.options.anonymousSignupEnabled === false)).toBe(true);
    });

    it('refuses to relabel an installed generic runtime before any mutating task runs', async () => {
        const harness = createHarness({ initiallyInstalled: true, initialPurpose: 'generic' });

        await expect(runPersonalHomeBootstrapFromSystemTasks({
            deps: harness.deps,
        })).rejects.toBeInstanceOf(PersonalHomeExistingRuntimeConflictError);

        expect(harness.taskCalls.map((entry) => entry.kind)).toEqual(['relay.runtime.status.v1']);
        expect(harness.accountCreations()).toBe(0);
        expect(harness.completionSource()).toBeNull();
    });

    it('fails closed to existing-runtime recovery when a persisted Personal Home has no managed signup readback', async () => {
        const harness = createHarness({
            initiallyInstalled: true,
            initialPurpose: 'personal-home',
            initialSignupPolicyKnown: false,
            dataPresent: true,
        });

        await expect(runPersonalHomeBootstrapFromSystemTasks({
            deps: harness.deps,
        })).rejects.toBeInstanceOf(PersonalHomeExistingRuntimeConflictError);

        expect(harness.taskCalls.map((entry) => entry.kind)).toEqual(['relay.runtime.status.v1']);
        expect(harness.completionSource()).toBeNull();
    });

    it('explicit recovery of a healthy plaintext generic runtime adopts it with the existing verified token and never creates or persists credentials', async () => {
        const harness = createHarness({
            initiallyInstalled: true,
            initialPurpose: 'generic',
            seedCredentials: 'existing-home-token',
        });

        const result = await runPersonalHomeBootstrapFromSystemTasks({
            deps: harness.deps,
            existingRuntimeDisposition: 'use-this-local-home',
        });

        expect(harness.taskCalls.map((entry) => [entry.kind, entry.options.anonymousSignupEnabled])).toEqual([
            ['relay.runtime.status.v1', undefined],
            ['relay.runtime.installOrUpdate.v1', false],
            ['relay.runtime.status.v1', undefined],
            ['relay.runtime.status.v1', undefined],
            ['relay.runtime.installOrUpdate.v1', false],
            ['relay.runtime.status.v1', undefined],
            ['relay.runtime.status.v1', undefined],
        ]);
        expect(harness.runtime.purpose).toBe('personal-home');
        expect(harness.runtime.signup).toBe('disabled');
        expect(harness.accountCreations()).toBe(0);
        expect(harness.credentials()).toEqual({ token: 'existing-home-token' });
        expect(harness.calls.filter((entry) => entry.startsWith('credentials:persist'))).toEqual([]);
        expect(harness.completionSource()).toBe('personal-home');
        expect(result.profileId).toBe('home-b-profile');
        const adoptIndex = harness.calls.indexOf('profile:adopt');
        expect(harness.calls.indexOf('signup:refusal')).toBeLessThan(adoptIndex);
        expect(harness.calls.lastIndexOf('auth:verify:existing-home-token')).toBeLessThan(adoptIndex);
    });

    it('explicit recovery of a plaintext generic runtime with no stored credentials fails before install/update/adoption and never creates an account', async () => {
        const harness = createHarness({ initiallyInstalled: true, initialPurpose: 'generic' });

        await expect(runPersonalHomeBootstrapFromSystemTasks({
            deps: harness.deps,
            existingRuntimeDisposition: 'use-this-local-home',
        })).rejects.toMatchObject({ code: 'personal_home_credentials_unverified' });

        expect(harness.taskCalls.map((entry) => entry.kind)).toEqual(['relay.runtime.status.v1']);
        expect(harness.accountCreations()).toBe(0);
        expect(harness.completionSource()).toBeNull();
        expect(harness.runtime.purpose).toBe('generic');
    });

    it('explicit recovery of a plaintext generic runtime with invalid credentials fails before install/update/adoption and never creates an account', async () => {
        const harness = createHarness({
            initiallyInstalled: true,
            initialPurpose: 'generic',
            seedCredentials: 'stale-home-token',
            homeAcceptedToken: 'rotated-home-token',
        });

        await expect(runPersonalHomeBootstrapFromSystemTasks({
            deps: harness.deps,
            existingRuntimeDisposition: 'use-this-local-home',
        })).rejects.toMatchObject({ code: 'personal_home_credentials_unverified' });

        expect(harness.taskCalls.map((entry) => entry.kind)).toEqual(['relay.runtime.status.v1']);
        expect(harness.accountCreations()).toBe(0);
        expect(harness.completionSource()).toBeNull();
        expect(harness.runtime.purpose).toBe('generic');
    });

    it('explicit recovery refuses optional and required_e2ee generic runtimes before install/update/adoption', async () => {
        for (const storagePolicy of ['optional', 'required_e2ee'] as const) {
            const harness = createHarness({ initiallyInstalled: true, initialPurpose: 'generic', storagePolicy });

            await expect(runPersonalHomeBootstrapFromSystemTasks({
                deps: harness.deps,
                existingRuntimeDisposition: 'use-this-local-home',
            })).rejects.toBeInstanceOf(PersonalHomeExistingRuntimeConflictError);

            expect(harness.taskCalls.map((entry) => entry.kind)).toEqual(['relay.runtime.status.v1']);
            expect(harness.accountCreations()).toBe(0);
            expect(harness.completionSource()).toBeNull();
            expect(harness.runtime.purpose).toBe('generic');
        }
    });

    it('routes an existing-runtime identity conflict before runtime, credential, or profile mutation', async () => {
        const harness = createHarness({
            initiallyInstalled: true,
            initialPurpose: 'generic',
            seedCredentials: 'existing-home-token',
            failProfilePreflight: true,
        });

        await expect(runPersonalHomeBootstrapFromSystemTasks({
            deps: harness.deps,
            existingRuntimeDisposition: 'use-this-local-home',
        })).rejects.toBeInstanceOf(PersonalHomeExistingRuntimeConflictError);

        expect(harness.taskCalls.map((entry) => entry.kind)).toEqual(['relay.runtime.status.v1']);
        expect(harness.runtime.purpose).toBe('generic');
        expect(harness.credentials()).toEqual({ token: 'existing-home-token' });
        expect(harness.completionSource()).toBeNull();
    });

    it('explicit recovery of a stopped generic runtime starts it without Personal Home purpose and a failed preflight leaves it generic and unadopted', async () => {
        const harness = createHarness({ initiallyStopped: true, initialPurpose: 'generic' });

        await expect(runPersonalHomeBootstrapFromSystemTasks({
            deps: harness.deps,
            existingRuntimeDisposition: 'use-this-local-home',
        })).rejects.toMatchObject({ code: 'personal_home_credentials_unverified' });

        expect(harness.taskCalls.map((entry) => entry.kind)).toEqual([
            'relay.runtime.status.v1',
            'relay.runtime.start.v1',
            'relay.runtime.status.v1',
        ]);
        const lifecycleStart = harness.taskCalls[1];
        expect(lifecycleStart.options.purpose).toBeUndefined();
        expect(lifecycleStart.options.anonymousSignupEnabled).toBeUndefined();
        expect(harness.runtime.healthy).toBe(true);
        expect(harness.runtime.purpose).toBe('generic');
        expect(harness.accountCreations()).toBe(0);
        expect(harness.completionSource()).toBeNull();
    });

    it('explicit recovery failure stays retryable without duplicate account creation', async () => {
        const harness = createHarness({
            initiallyInstalled: true,
            initialPurpose: 'generic',
            seedCredentials: 'existing-home-token',
            refusalVerified: false,
        });

        await expect(runPersonalHomeBootstrapFromSystemTasks({
            deps: harness.deps,
            existingRuntimeDisposition: 'use-this-local-home',
        })).rejects.toMatchObject({ code: 'personal_home_signup_closure_unverified' });
        expect(harness.accountCreations()).toBe(0);
        expect(harness.completionSource()).toBeNull();
        expect(harness.credentials()).toEqual({ token: 'existing-home-token' });

        harness.setRefusalVerified(true);
        const result = await runPersonalHomeBootstrapFromSystemTasks({
            deps: harness.deps,
            existingRuntimeDisposition: 'use-this-local-home',
        });

        expect(result.profileId).toBe('home-b-profile');
        expect(harness.accountCreations()).toBe(0);
        expect(harness.credentials()).toEqual({ token: 'existing-home-token' });
        expect(harness.taskCalls
            .filter((entry) => entry.kind === 'relay.runtime.installOrUpdate.v1')
            .every((entry) => entry.options.anonymousSignupEnabled === false)).toBe(true);
    });

    it('explicit recovery adopts an already-classified Personal Home with unknown signup policy after successful preflight', async () => {
        const harness = createHarness({
            initiallyInstalled: true,
            initialPurpose: 'personal-home',
            initialSignupPolicyKnown: false,
            seedCredentials: 'existing-home-token',
        });

        const result = await runPersonalHomeBootstrapFromSystemTasks({
            deps: harness.deps,
            existingRuntimeDisposition: 'use-this-local-home',
        });

        expect(result.profileId).toBe('home-b-profile');
        expect(harness.accountCreations()).toBe(0);
        expect(harness.runtime.signup).toBe('disabled');
        expect(harness.taskCalls.find((entry) => entry.kind === 'relay.runtime.installOrUpdate.v1')?.options.anonymousSignupEnabled).toBe(false);
    });

    it('reuses a healthy classified Personal Home with proven signup closure through read-only verification only', async () => {
        const harness = createHarness({
            initiallyInstalled: true,
            initialPurpose: 'personal-home',
            seedCredentials: 'existing-home-token',
        });
        harness.runtime.signup = 'disabled';
        const focusBefore = harness.focusedHome.id;

        const result = await runPersonalHomeBootstrapFromSystemTasks({
            deps: harness.deps,
        });

        expect(harness.taskCalls.map((entry) => entry.kind)).toEqual([
            'relay.runtime.status.v1',
            'relay.runtime.status.v1',
        ]);
        expect(harness.accountCreations()).toBe(0);
        expect(harness.credentials()).toEqual({ token: 'existing-home-token' });
        expect(harness.calls.filter((entry) => entry.startsWith('credentials:persist'))).toEqual([]);
        expect(harness.completionSource()).toBe('personal-home');
        expect(result.accountCreated).toBe(false);
        expect(result.profileId).toBe('home-b-profile');
        expect(result.receipt.canonicalServerUrl).toBe(harness.canonicalServerUrl);
        expect(harness.focusedHome.id).toBe(focusBefore);
        const adoptIndex = harness.calls.indexOf('profile:adopt');
        expect(harness.calls.indexOf('signup:refusal')).toBeLessThan(adoptIndex);
        expect(harness.calls.lastIndexOf('auth:verify:existing-home-token')).toBeLessThan(adoptIndex);
    });

    it('starts an installed classified Personal Home that is stopped without reinstalling or re-closing proven closure', async () => {
        const harness = createHarness({
            initiallyStopped: true,
            initialPurpose: 'personal-home',
            seedCredentials: 'existing-home-token',
        });
        harness.runtime.signup = 'disabled';

        const result = await runPersonalHomeBootstrapFromSystemTasks({
            deps: harness.deps,
        });

        expect(harness.taskCalls.map((entry) => entry.kind)).toEqual([
            'relay.runtime.status.v1',
            'relay.runtime.start.v1',
            'relay.runtime.status.v1',
            'relay.runtime.status.v1',
        ]);
        const lifecycleStart = harness.taskCalls[1];
        expect(lifecycleStart.options.purpose).toBeUndefined();
        expect(lifecycleStart.options.anonymousSignupEnabled).toBeUndefined();
        expect(harness.runtime.healthy).toBe(true);
        expect(harness.accountCreations()).toBe(0);
        expect(harness.completionSource()).toBe('personal-home');
        expect(result.profileId).toBe('home-b-profile');
    });

    it('applies signup closure with install/update to a stopped classified Personal Home whose signup is still enabled', async () => {
        const harness = createHarness({
            initiallyStopped: true,
            initialPurpose: 'personal-home',
            seedCredentials: 'existing-home-token',
        });

        const result = await runPersonalHomeBootstrapFromSystemTasks({
            deps: harness.deps,
        });

        expect(harness.taskCalls.map((entry) => [entry.kind, entry.options.anonymousSignupEnabled])).toEqual([
            ['relay.runtime.status.v1', undefined],
            ['relay.runtime.start.v1', undefined],
            ['relay.runtime.status.v1', undefined],
            ['relay.runtime.status.v1', undefined],
            ['relay.runtime.installOrUpdate.v1', false],
            ['relay.runtime.status.v1', undefined],
            ['relay.runtime.status.v1', undefined],
        ]);
        expect(harness.runtime.signup).toBe('disabled');
        expect(harness.accountCreations()).toBe(0);
        expect(harness.completionSource()).toBe('personal-home');
        expect(result.profileId).toBe('home-b-profile');
    });

    it('keeps a retry after a failed completion receipt mutation-free, token-only, and account-stable', async () => {
        const harness = createHarness({ failFirstAdoption: true });

        await expect(runPersonalHomeBootstrapFromSystemTasks({
            deps: harness.deps,
        })).rejects.toThrow('profile source temporarily unavailable');
        expect(harness.adoptionAttempts()).toBe(1);
        expect(harness.accountCreations()).toBe(1);
        expect(harness.runtime.signup).toBe('disabled');
        expect(harness.completionSource()).toBeNull();

        harness.taskCalls.length = 0;
        harness.calls.length = 0;
        const result = await runPersonalHomeBootstrapFromSystemTasks({
            deps: harness.deps,
        });

        expect(harness.taskCalls.map((entry) => entry.kind)
            .filter((kind) => kind !== 'relay.runtime.status.v1')).toEqual([]);
        expect(harness.adoptionAttempts()).toBe(2);
        expect(harness.accountCreations()).toBe(1);
        expect(harness.credentials()).toEqual({ token: 'home-b-token' });
        expect(result.accountCreated).toBe(false);
        expect(result.profileId).toBe('home-b-profile');
        expect(harness.focusedHome.id).toBe('home-a');
        const adoptIndex = harness.calls.indexOf('profile:adopt');
        expect(harness.calls.indexOf('signup:refusal')).toBeLessThan(adoptIndex);
        expect(harness.calls.lastIndexOf('auth:verify:home-b-token')).toBeLessThan(adoptIndex);
    });
});
