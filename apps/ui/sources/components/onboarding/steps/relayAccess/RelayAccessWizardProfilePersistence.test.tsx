import * as React from 'react';
import { createBuiltinRelayAccessSelection } from '@happier-dev/cli-common/relayAccess/catalog';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installMachinesSettingsCommonModuleMocks } from '@/components/settings/machines/machinesSettingsTestHelpers';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { getActiveServerId, getServerProfileById, removeServerProfile, setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';

type WizardPrimaryState = {
    onPress: (() => void) | (() => Promise<void>);
    disabled: boolean;
} | null;

let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>> | undefined;
let previousServerId = '';
let activeProfileId = '';
let candidateProfileId = '';
const cloudflareCredentialRefs = [{ purpose: 'tunnel.manage', credentialRef: { kind: 'connectedAccount' as const,
    account: { service: { pluginId: 'happier.deploy.cloudflare', localId: 'cloudflare' }, accountId: 'work' } } }];

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

installMachinesSettingsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Platform: {
                OS: 'web',
                select: (options: Record<string, unknown>) => options?.web ?? options?.default,
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    textSecondary: 'gray',
                    surface: 'surface',
                    overlay: {
                        scrimWizard: 'scrimWizard',
                    },
                },
            },
        });
    },
});

beforeEach(async () => {
    browser = await installBrowserRuntimeForTests({ url: 'https://app.example.test' });
    previousServerId = getActiveServerId();
    activeProfileId = (await upsertServerProfile({ serverUrl: 'https://relay.example.test', name: 'Active Home' })).id;
    candidateProfileId = (await upsertServerProfile({ serverUrl: 'http://127.0.0.1:3005', name: 'Candidate Home' })).id;
    await setActiveServerId(activeProfileId);
});
afterEach(async () => {
    standardCleanup();
    await setActiveServerId(previousServerId);
    await removeServerProfile(candidateProfileId);
    await removeServerProfile(activeProfileId);
    browser?.restore();
    browser = undefined;
});

function createRunnerHarness() {
    return import('@/components/systemTasks/createSystemTaskRunner').then(async ({ createSystemTaskRunner }) => {
        const { SystemTaskSpecSchema} = await import('@happier-dev/protocol/system/tasks/spec');
        let nextTaskId = 1;
        const listeners = new Map<string, {
            onEvent: (payload: unknown) => void;
            onResult: (payload: unknown) => void;
        }>();
        const startedSpecs: unknown[] = [];

        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) {
                    SystemTaskSpecSchema.parse(spec);
                    startedSpecs.push(spec);
                    const kind = typeof (spec as { kind?: unknown })?.kind === 'string'
                        ? String((spec as { kind: string }).kind)
                        : 'unknown';
                    return `task_${nextTaskId++}:${kind}`;
                },
                async subscribe(taskId, listenerSet) {
                    listeners.set(taskId, listenerSet);
                    return () => {
                        listeners.delete(taskId);
                    };
                },
                async cancel() {},
                async respond() {},
            },
        });

        return {
            listeners,
            runner,
            startedSpecs,
        };
    });
}

describe('relay access wizard detail steps', () => {
    it('prefills the existing LAN URL and advances without rerunning configure when relay access is already configured', async () => {
        const { SYSTEM_TASK_PROTOCOL_VERSION} = await import('@happier-dev/protocol/system/tasks/spec');
        const { RelayAccessConfigFieldsStep } = await import('./RelayAccessConfigFieldsStep');
        const definition = (await import('./relayAccessConfigStepCatalog')).relayAccessConfigStepCatalog.lan;
        const harness = await createRunnerHarness();
        let primary: WizardPrimaryState = null;
        const onRequestAdvance = vi.fn();

        const screen = await renderScreen(
            React.createElement(RelayAccessConfigFieldsStep, {
                definition,
                runner: harness.runner,
                upstreamUrl: 'http://127.0.0.1:3005/',
                serverProfileId: candidateProfileId,
                onWizardPrimaryChange: (state) => {
                    primary = state as typeof primary;
                },
                onRequestAdvance,
            }),
        );

        await vi.waitFor(() => expect(harness.listeners.has('task_1:relay.access.status.v1')).toBe(true));
        await renderer.act(async () => {
            harness.listeners.get('task_1:relay.access.status.v1')?.onResult({
                protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                taskId: 'task_1:relay.access.status.v1',
                ok: true,
                data: {
                    configured: true,
                    providerId: 'lan',
                    selection: createBuiltinRelayAccessSelection('lan', { url: 'https://relay.lan.example.test' }),
                    status: {
                        state: 'enabled',
                        shareUrl: 'https://relay.lan.example.test',
                        details: null,
                    },
                },
            });
        });
        await renderer.act(async () => {});

        expect(screen.findByTestId('relay-access-lan-url')?.props.value).toBe('https://relay.lan.example.test');
        expect((primary as WizardPrimaryState)?.disabled).toBe(false);

        await renderer.act(async () => {
            await primary?.onPress?.();
        });

        expect(harness.startedSpecs).toHaveLength(1);
        expect(onRequestAdvance).toHaveBeenCalledTimes(1);
    });

    it('persists the LAN share URL onto the candidate relay profile', async () => {
        const { SYSTEM_TASK_PROTOCOL_VERSION} = await import('@happier-dev/protocol/system/tasks/spec');
        const { RelayAccessConfigFieldsStep } = await import('./RelayAccessConfigFieldsStep');
        const definition = (await import('./relayAccessConfigStepCatalog')).relayAccessConfigStepCatalog.lan;
        const harness = await createRunnerHarness();
        let primary: WizardPrimaryState = null;

        const screen = await renderScreen(
            React.createElement(RelayAccessConfigFieldsStep, {
                definition,
                runner: harness.runner,
                upstreamUrl: 'http://127.0.0.1:3005/',
                serverProfileId: candidateProfileId,
                onWizardPrimaryChange: (state) => {
                    primary = state as typeof primary;
                },
            }),
        );

        await renderer.act(async () => {});

        await renderer.act(async () => {
            harness.listeners.get('task_1:relay.access.status.v1')?.onResult({
                protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                taskId: 'task_1:relay.access.status.v1',
                ok: true,
                data: {
                    configured: false,
                    providerId: null,
                    selection: null,
                    status: {
                        state: 'disabled',
                        shareUrl: null,
                        details: null,
                    },
                },
            });
        });
        await renderer.act(async () => {});

        const input = screen.findByTestId('relay-access-lan-url');
        expect(input).toBeTruthy();
        await renderer.act(async () => {
            input?.props.onChangeText?.('https://relay.lan.example.test');
        });
        await renderer.act(async () => {});

        expect((primary as WizardPrimaryState)?.disabled).toBe(false);
        await renderer.act(async () => {
            await primary?.onPress?.();
        });

        expect(harness.startedSpecs[1]).toEqual({
            protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
            kind: 'relay.access.configure.v1',
            params: {
                target: { kind: 'local' },
                config: createBuiltinRelayAccessSelection('lan', { url: 'https://relay.lan.example.test' }),
                upstreamUrl: 'http://127.0.0.1:3005/',
            },
        });

        const taskId = 'task_2:relay.access.configure.v1';
        await renderer.act(async () => {
            harness.listeners.get(taskId)?.onResult({
                protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                taskId,
                ok: true,
                data: {
                    configured: true,
                    providerId: 'lan',
                    selection: createBuiltinRelayAccessSelection('lan', { url: 'https://relay.lan.example.test' }),
                    status: {
                        state: 'enabled',
                        shareUrl: 'https://relay.lan.example.test',
                        details: null,
                    },
                },
            });
        });
        await renderer.act(async () => {});

        expect(getServerProfileById(candidateProfileId)).toMatchObject({
            shareableServerUrl: 'https://relay.lan.example.test',
            shareableServerUrlValidatedAgainstServerUrl: 'http://127.0.0.1:3005',
        });
        expect(getActiveServerId()).toBe(activeProfileId);
        expect(getServerProfileById(activeProfileId)?.shareableServerUrl ?? null).toBeNull();
    });

    it('advances after saving the LAN relay access URL', async () => {
        const { SYSTEM_TASK_PROTOCOL_VERSION} = await import('@happier-dev/protocol/system/tasks/spec');
        const { RelayAccessConfigFieldsStep } = await import('./RelayAccessConfigFieldsStep');
        const definition = (await import('./relayAccessConfigStepCatalog')).relayAccessConfigStepCatalog.lan;
        const harness = await createRunnerHarness();
        let primary: WizardPrimaryState = null;
        const onRequestAdvance = vi.fn();

        const screen = await renderScreen(
            React.createElement(RelayAccessConfigFieldsStep, {
                definition,
                runner: harness.runner,
                upstreamUrl: 'http://127.0.0.1:3005/',
                serverProfileId: candidateProfileId,
                onWizardPrimaryChange: (state) => {
                    primary = state as typeof primary;
                },
                onRequestAdvance,
            }),
        );

        await renderer.act(async () => {
            harness.listeners.get('task_1:relay.access.status.v1')?.onResult({
                protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                taskId: 'task_1:relay.access.status.v1',
                ok: true,
                data: {
                    configured: false,
                    providerId: null,
                    selection: null,
                    status: {
                        state: 'disabled',
                        shareUrl: null,
                        details: null,
                    },
                },
            });
        });
        await renderer.act(async () => {});

        await renderer.act(async () => {
            screen.findByTestId('relay-access-lan-url')?.props.onChangeText?.('https://relay.lan.example.test');
        });
        await renderer.act(async () => {
            await primary?.onPress?.();
        });

        const taskId = 'task_2:relay.access.configure.v1';
        await renderer.act(async () => {
            harness.listeners.get(taskId)?.onResult({
                protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                taskId,
                ok: true,
                data: {
                    configured: true,
                    providerId: 'lan',
                    selection: createBuiltinRelayAccessSelection('lan', { url: 'https://relay.lan.example.test' }),
                    status: {
                        state: 'enabled',
                        shareUrl: 'https://relay.lan.example.test',
                        details: null,
                    },
                },
            });
        });
        await renderer.act(async () => {});

        expect(onRequestAdvance).toHaveBeenCalledTimes(1);
    });

    it('prefills the existing Cloudflare hostname and advances without rerunning configure when relay access is already configured', async () => {
        const { SYSTEM_TASK_PROTOCOL_VERSION} = await import('@happier-dev/protocol/system/tasks/spec');
        const { RelayAccessConfigFieldsStep } = await import('./RelayAccessConfigFieldsStep');
        const definition = (await import('./relayAccessConfigStepCatalog')).relayAccessConfigStepCatalog.cloudflareNamed;
        const harness = await createRunnerHarness();
        let primary: WizardPrimaryState = null;
        const onRequestAdvance = vi.fn();

        const screen = await renderScreen(
            React.createElement(RelayAccessConfigFieldsStep, {
                definition,
                runner: harness.runner,
                upstreamUrl: 'http://127.0.0.1:3005/',
                serverProfileId: candidateProfileId,
                onWizardPrimaryChange: (state) => {
                    primary = state as typeof primary;
                },
                onRequestAdvance,
            }),
        );

        await vi.waitFor(() => expect(harness.listeners.has('task_1:relay.access.status.v1')).toBe(true));
        await renderer.act(async () => {
            harness.listeners.get('task_1:relay.access.status.v1')?.onResult({
                protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                taskId: 'task_1:relay.access.status.v1',
                ok: true,
                data: {
                    configured: true,
                    providerId: 'cloudflareNamed',
                    selection: createBuiltinRelayAccessSelection('cloudflareNamed', { hostname: 'relay.example.com' }, cloudflareCredentialRefs),
                    status: {
                        state: 'enabled',
                        shareUrl: 'https://relay.example.com',
                        details: {
                            managed: false,
                        },
                    },
                },
            });
        });
        await renderer.act(async () => {});

        expect(screen.findByTestId('relay-access-cloudflare-hostname')?.props.value).toBe('relay.example.com');
        expect(screen.findByTestId('relay-access-cloudflare-token')).toBeNull();
        expect((primary as WizardPrimaryState)?.disabled).toBe(false);

        await renderer.act(async () => {
            await primary?.onPress?.();
        });

        expect(harness.startedSpecs).toHaveLength(1);
        expect(onRequestAdvance).toHaveBeenCalledTimes(1);
    });

    it('persists the Cloudflare share URL onto the candidate relay profile', async () => {
        const { SYSTEM_TASK_PROTOCOL_VERSION} = await import('@happier-dev/protocol/system/tasks/spec');
        const { RelayAccessConfigFieldsStep } = await import('./RelayAccessConfigFieldsStep');
        const definition = (await import('./relayAccessConfigStepCatalog')).relayAccessConfigStepCatalog.cloudflareNamed;
        const harness = await createRunnerHarness();
        let primary: WizardPrimaryState = null;

        const screen = await renderScreen(
            React.createElement(RelayAccessConfigFieldsStep, {
                definition,
                runner: harness.runner,
                upstreamUrl: 'http://127.0.0.1:3005/',
                serverProfileId: candidateProfileId,
                onWizardPrimaryChange: (state) => {
                    primary = state as typeof primary;
                },
            }),
        );

        await renderer.act(async () => {});

        await renderer.act(async () => {
            harness.listeners.get('task_1:relay.access.status.v1')?.onResult({
                protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                taskId: 'task_1:relay.access.status.v1',
                ok: true,
                data: {
                    configured: true,
                    providerId: 'cloudflareNamed',
                    selection: createBuiltinRelayAccessSelection('cloudflareNamed', { hostname: 'previous.example.com' }, cloudflareCredentialRefs),
                    status: {
                        state: 'disabled',
                        shareUrl: null,
                        details: null,
                    },
                },
            });
        });
        await renderer.act(async () => {});

        await renderer.act(async () => {
            screen.findByTestId('relay-access-cloudflare-hostname')?.props.onChangeText?.('relay.example.com');
        });
        await renderer.act(async () => {});

        expect((primary as WizardPrimaryState)?.disabled).toBe(false);
        await renderer.act(async () => {
            await primary?.onPress?.();
        });

        expect(harness.startedSpecs[1]).toEqual({
            protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
            kind: 'relay.access.configure.v1',
            params: {
                target: { kind: 'local' },
                config: createBuiltinRelayAccessSelection('cloudflareNamed', { hostname: 'relay.example.com' }, cloudflareCredentialRefs),
                upstreamUrl: 'http://127.0.0.1:3005/',
            },
        });

        const taskId = 'task_2:relay.access.configure.v1';
        await renderer.act(async () => {
            harness.listeners.get(taskId)?.onResult({
                protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                taskId,
                ok: true,
                data: {
                    configured: true,
                    providerId: 'cloudflareNamed',
                    selection: createBuiltinRelayAccessSelection('cloudflareNamed', { hostname: 'relay.example.com' }, cloudflareCredentialRefs),
                    status: {
                        state: 'enabled',
                        shareUrl: 'https://relay.example.com',
                        details: null,
                    },
                },
            });
        });
        await renderer.act(async () => {});

        expect(getServerProfileById(candidateProfileId)).toMatchObject({
            shareableServerUrl: 'https://relay.example.com',
            shareableServerUrlValidatedAgainstServerUrl: 'http://127.0.0.1:3005',
        });
        expect(getActiveServerId()).toBe(activeProfileId);
        expect(getServerProfileById(activeProfileId)?.shareableServerUrl ?? null).toBeNull();
    });
});
