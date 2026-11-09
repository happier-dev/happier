import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { applyAccountSettingsSavedSecretMutation, resolveAccountSettingsPluginSecret, resolveAccountSettingsPluginSecretBinding } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { PluginDeclarativeProjectedModelV1Schema} from '@happier-dev/protocol/plugins/contributions/ui/declarativeProjectedModelV1';
import { PluginAccountAvailabilityIntentReadResponseV1Schema } from '@happier-dev/protocol/plugins/availability';
import { installRealActionExecutorModuleLoader, serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { t } from '@/text';
import { resolvePluginSurfaceStatePresentation } from '@/sync/domains/surfaces/copy/resolveReasonCopy';

import type { BoundPluginSurfaceController } from './boundPluginSurfaceController';
import type {
    ScopedPluginSettingsAdapter,
} from '@/sync/domains/plugins/settings/scopedPluginSettingsAdapter';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

const ordinarySettingsBoundary = vi.hoisted(() => ({
    read: vi.fn<ScopedPluginSettingsAdapter['read']>(),
    write: vi.fn<ScopedPluginSettingsAdapter['write']>(),
}));

vi.mock('@/sync/domains/plugins/settings/scopedPluginSettingsRuntime', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/domains/plugins/settings/scopedPluginSettingsRuntime')>();
    return {
        ...original,
        scopedPluginSettingsAdapter: Object.freeze({
            read: (...args: Parameters<typeof original.scopedPluginSettingsAdapter.read>) => (
                ordinarySettingsBoundary.read(...args)
            ),
            write: (...args: Parameters<typeof original.scopedPluginSettingsAdapter.write>) => (
                ordinarySettingsBoundary.write(...args)
            ),
        }),
    };
});

vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
const { DeclarativePluginSurface } = await import('./DeclarativePluginSurface');
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { renderScreen } from '@/dev/testkit';
import { HappierStateLine } from '@happier-dev/plugin-ui/presentation';
import { SurfaceStateSizeProvider } from '@/components/ui/surfaces/surfaceStateSize';
import {
    setServerProfileIdentityForUrl,
    setActiveServerId,
    upsertServerProfile,
} from '@/sync/domains/server/serverProfiles';

const ACCOUNT_TARGET = Object.freeze({
    kind: 'account' as const,
    serverIdentityId: 'srv_account_secret_surface',
});

function createAccountLifetime(): ActiveServerAccountScopeLifetime {
    return Object.freeze({
        scope: Object.freeze({ serverId: 'account-secret-surface', accountId: 'account-secret-test' }),
        isCurrent: () => true,
        onRetire: () => Object.freeze({ dispose: () => {} }),
    });
}

const accountSecretInventorySetting = Object.freeze({
    id: 'token',
    contributionId: 'token',
    qualifiedId: 'acme.account-secret/token',
    descriptor: Object.freeze({ id: 'token', title: 'API token', target: { kind: 'plugin' }, scope: 'account', secret: true, schema: Object.freeze({ type: 'string' }) }),
});

const model = Object.freeze({
    visible: true,
    requiredHostMethods: [],
    identity: Object.freeze({
        pluginId: 'acme.account-secret',
        localId: 'settings',
        qualifiedId: 'acme.account-secret/settings',
        occurrenceId: 'account-secret-occurrence',
    }),
    declarativeInventory: Object.freeze({
        actions: Object.freeze([]),
        destinations: Object.freeze([]),
        settings: Object.freeze([Object.freeze({
            pluginId: 'acme.account-secret',
            id: 'token',
            qualifiedId: 'acme.account-secret/token',
            schema: Object.freeze({ type: 'string' }),
            secret: true,
            setting: accountSecretInventorySetting,
        })]),
        uiQueries: Object.freeze([]),
    }),
    root: Object.freeze({
        kind: 'group',
        path: 'root',
        order: 0,
        children: Object.freeze([Object.freeze({
            kind: 'field',
            path: 'root.children[0]',
            order: 0,
            label: 'Account token',
            control: Object.freeze({ kind: 'secret', settingId: 'token' }),
            setting: accountSecretInventorySetting,
        })]),
    }),
});

const dispatchAction: BoundPluginSurfaceController['dispatchAction'] = async () => null;
const openSurface: BoundPluginSurfaceController['openSurface'] = async () => null;

beforeEach(async () => {
    ordinarySettingsBoundary.read.mockReset();
    ordinarySettingsBoundary.write.mockReset();
    const profile = await upsertServerProfile({
        serverUrl: 'https://account-secret-surface',
        name: 'Account secret surface',
    });
    expect(profile.id).toBe('account-secret-surface');
    await setActiveServerId(profile.id);
    expect(await setServerProfileIdentityForUrl(
        profile.serverUrl,
        ACCOUNT_TARGET.serverIdentityId,
    )).toMatchObject({ serverIdentityId: ACCOUNT_TARGET.serverIdentityId });
});

afterEach(() => {
    ordinarySettingsBoundary.read.mockReset();
    ordinarySettingsBoundary.write.mockReset();
});

describe('DeclarativePluginSurface Account secrets', () => {
    it('keeps a configured secret redacted and rejects an explicit empty Save without deleting its binding', async () => {
        const secretTarget = { pluginId: 'acme.account-secret', localId: 'token' };
        const seeded = applyAccountSettingsSavedSecretMutation({ secrets: [{ id: 'existing-token', name: 'Account token', kind: 'other',
            encryptedValue: { _isSecretValue: true, value: 'synthetic-redacted-token' }, createdAt: 1, updatedAt: 1 }] }, {
            kind: 'bindPluginSecret', target: secretTarget, expectedSecretId: null, expectedSecretUpdatedAt: null,
            secretId: 'existing-token',
        }).settings;
        const homes = await serveAccountHomes({ homes: [{ key: 'secret', serverUrl: 'https://account-secret-surface',
            serverIdentityId: ACCOUNT_TARGET.serverIdentityId, accountId: 'account-secret-test',
            settings: { ...seeded, actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'plugins.settings.secret.delete': ['ui'] } } } }],
            route: () => undefined });
        onTestFinished(() => homes.dispose());
        const restoreLoader = await installRealActionExecutorModuleLoader();
        onTestFinished(restoreLoader);
        const { storage } = await import('@/sync/domains/state/storage');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        expect(accountLifetime).not.toBeNull();
        const { replacePluginAccountAvailabilityProjection, clearPluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');
        onTestFinished(clearPluginAccountAvailabilityProjection);
        replacePluginAccountAvailabilityProjection({ scope: accountLifetime!.scope, snapshot: {
            availabilityCursor: 1, materializations: [], snapshots: [], intentReads: [{ pluginId: secretTarget.pluginId,
                response: PluginAccountAvailabilityIntentReadResponseV1Schema.parse({ availabilityCursor: 1,
                    hostingCapability: { enabled: false },
                    intent: { pluginId: secretTarget.pluginId, desiredVersion: '1.0.0', enabled: true,
                        offlineUiHosting: 'disabled', writableCollections: [], revision: 'intent-1' },
                    release: { ref: { pluginId: secretTarget.pluginId, version: '1.0.0' },
                        archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
                        normalizedManifest: { schemaVersion: 2, id: secretTarget.pluginId, version: '1.0.0',
                            displayName: 'Account secret', runtime: { apiVersion: 1 }, contributes: { settings: [{
                                id: 'token', title: 'Account token', scope: 'account', target: { kind: 'plugin' },
                                fields: [{ id: 'token', title: 'Account token', schema: { type: 'string' }, secret: { custody: 'account' } }],
                            }] } }, collectionContracts: [], uiSlots: [],
                        packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] },
                    }, packageAssets: [], uiArtifacts: [],
                }) }],
        } });
        const settingsWrites = () => homes.httpRequests.filter(request => request.path === '/v2/account/settings' && request.method === 'POST');

        const screen = await renderScreen(
            <DeclarativePluginSurface
                pluginId="acme.account-secret"
                model={PluginDeclarativeProjectedModelV1Schema.parse(model)}
                interactionEnabled={true}
                daemonInteractionEnabled={false}
                settingsScopesEnabled={{ account: true, daemon: false }}
                dispatchAction={dispatchAction}
                actionAvailable={false}
                openSurface={openSurface}
                openSurfaceAvailable={false}
                accountLifetime={accountLifetime}
            />,
        );
        await vi.waitFor(() => expect(screen.findByTestId('plugin-declarative-field-delete:root.children[0]')?.props.disabled).toBe(false));

        const saveTestId = 'plugin-declarative-field-save:root.children[0]';
        const deleteTestId = 'plugin-declarative-field-delete:root.children[0]';
        expect(screen.findByTestId('plugin-declarative-field:root.children[0]')?.props.value).toBe('');
        expect(screen.getTextContent()).not.toContain('synthetic-redacted-token');
        expect(screen.findByTestId(saveTestId)?.props.disabled).toBe(true);
        expect(screen.findByTestId(deleteTestId)?.props.disabled).toBe(false);
        expect(screen.findByTestId(saveTestId)?.props.accessibilityLabel).toBe(`${t('common.save')}: Account token`);
        expect(screen.findByTestId(deleteTestId)?.props.accessibilityLabel).toBe(`${t('settingsPlugins.secretFieldActions.delete')}: Account token`);

        await act(async () => {
            screen.pressByTestId(saveTestId);
        });
        expect(settingsWrites()).toHaveLength(0);

        await act(async () => {
            screen.changeTextByTestId('plugin-declarative-field:root.children[0]', '');
        });
        expect(screen.findByTestId(saveTestId)?.props.disabled).toBe(false);
        await act(async () => {
            screen.pressByTestId(saveTestId);
        });
        // Empty input is a failed replacement, never an implicit Delete. The
        // SavedSecret owner rejects it before the Account CAS can be issued.
        await vi.waitFor(() => expect(screen.findHostByTestId('plugin-declarative-settings-error')).not.toBeNull());
        expect(storage.getState().settingsVersion).toBe(1);
        expect(settingsWrites()).toHaveLength(0);
        const { sync } = await import('@/sync/sync');
        expect(sync.decryptSecretValue(resolveAccountSettingsPluginSecret(storage.getState().settings, secretTarget)?.secret.encryptedValue))
            .toBe('synthetic-redacted-token');
        expect(resolveAccountSettingsPluginSecretBinding(storage.getState().settings, secretTarget)?.savedSecretId).toBe('existing-token');
        expect(screen.findByTestId(deleteTestId)?.props.disabled).toBe(false);

        await act(async () => {
            screen.pressByTestId(deleteTestId);
        });
        await vi.waitFor(() => expect(storage.getState().settingsVersion).toBe(2));
        expect(settingsWrites()).toHaveLength(1);
        expect(settingsWrites()[0]?.body).toMatchObject({ expectedVersion: 1 });
        expect(resolveAccountSettingsPluginSecretBinding(storage.getState().settings, secretTarget)).toBeNull();
        await vi.waitFor(() => expect(screen.findHostByTestId(deleteTestId)).toBeNull());
    });
});

describe('DeclarativePluginSurface ordinary Settings', () => {
    it('keeps a replaced-source draft visible but inert until the replacement source edits it', async () => {
        ordinarySettingsBoundary.read
            .mockResolvedValueOnce({
                status: 'ready',
                snapshot: {
                    scope: { kind: 'account' },
                    target: ACCOUNT_TARGET,
                    revision: { kind: 'account', value: 1 },
                    values: { endpoint: 'Source A' },
                    secretStates: {},
                },
            })
            .mockResolvedValueOnce({
                status: 'ready',
                snapshot: {
                    scope: { kind: 'account' },
                    target: ACCOUNT_TARGET,
                    revision: { kind: 'account', value: 2 },
                    values: { endpoint: 'Source B' },
                    secretStates: {},
                },
            });
        ordinarySettingsBoundary.write.mockResolvedValue({ status: 'unavailable', reason: 'transport' });

        const ordinaryInventorySetting = Object.freeze({
            id: 'endpoint',
            contributionId: 'endpoint',
            qualifiedId: 'acme.ordinary-settings/endpoint',
            descriptor: Object.freeze({
                id: 'endpoint',
                title: 'Endpoint',
                target: Object.freeze({ kind: 'plugin' }),
                scope: 'account',
                schema: Object.freeze({ type: 'string' }),
            }),
        });
        const modelForOccurrence = (occurrenceId: string) => Object.freeze({
            visible: true,
            requiredHostMethods: [],
            identity: Object.freeze({
                pluginId: 'acme.ordinary-settings',
                localId: 'settings',
                qualifiedId: 'acme.ordinary-settings/settings',
                occurrenceId,
            }),
            declarativeInventory: Object.freeze({
                actions: Object.freeze([]),
                destinations: Object.freeze([]),
                settings: Object.freeze([Object.freeze({
                    pluginId: 'acme.ordinary-settings',
                    id: 'endpoint',
                    qualifiedId: 'acme.ordinary-settings/endpoint',
                    schema: Object.freeze({ type: 'string' }),
                    secret: false,
                    setting: ordinaryInventorySetting,
                })]),
                uiQueries: Object.freeze([]),
            }),
            root: Object.freeze({
                kind: 'group',
                path: 'root',
                order: 0,
                children: Object.freeze([Object.freeze({
                    kind: 'field',
                    path: 'root.children[0]',
                    order: 0,
                    label: 'Endpoint',
                    control: Object.freeze({ kind: 'text', settingId: 'endpoint' }),
                    setting: ordinaryInventorySetting,
                })]),
            }),
        });
        const accountLifetime = createAccountLifetime();
        const renderModel = (occurrenceId: string) => (
            <DeclarativePluginSurface
                pluginId="acme.ordinary-settings"
                model={PluginDeclarativeProjectedModelV1Schema.parse(modelForOccurrence(occurrenceId))}
                interactionEnabled={true}
                daemonInteractionEnabled={false}
                settingsScopesEnabled={{ account: true, daemon: false }}
                dispatchAction={dispatchAction}
                actionAvailable={false}
                openSurface={openSurface}
                openSurfaceAvailable={false}
                accountLifetime={accountLifetime}
            />
        );

        const screen = await renderScreen(renderModel('source-a'));
        await vi.waitFor(() => expect(ordinarySettingsBoundary.read).toHaveBeenCalledTimes(1));
        await act(async () => {
            screen.changeTextByTestId('plugin-declarative-field:root.children[0]', 'Source A draft');
        });

        // An equivalent publication is not a new Settings source: keep the
        // edit committable without another record read.
        await screen.update(renderModel('source-a'));
        expect(ordinarySettingsBoundary.read).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('plugin-declarative-field:root.children[0]')?.props.value).toBe('Source A draft');
        expect(screen.findByTestId('plugin-declarative-field-save:root.children[0]')?.props.disabled).toBe(false);

        await screen.update(renderModel('source-b'));
        await vi.waitFor(() => expect(ordinarySettingsBoundary.read).toHaveBeenCalledTimes(2));
        expect(screen.findByTestId('plugin-declarative-field:root.children[0]')?.props.value).toBe('Source A draft');
        expect(screen.findByTestId('plugin-declarative-field-save:root.children[0]')?.props.disabled).toBe(true);

        await act(async () => {
            screen.pressByTestId('plugin-declarative-field-save:root.children[0]');
        });
        expect(ordinarySettingsBoundary.write).not.toHaveBeenCalled();

        await act(async () => {
            screen.changeTextByTestId('plugin-declarative-field:root.children[0]', 'Source B draft');
        });
        expect(screen.findByTestId('plugin-declarative-field-save:root.children[0]')?.props.disabled).toBe(false);
    });
});

describe('DeclarativePluginSurface action continuity', () => {
    it('keeps an entered action pending across an equivalent source publication', async () => {
        let settle = () => {};
        const pending = new Promise<null>(resolve => { settle = () => resolve(null); });
        const execute = vi.fn<BoundPluginSurfaceController['dispatchAction']>(() => pending);
        const accountLifetime = createAccountLifetime();
        const render = () => {
            const action = { identity: { pluginId: 'acme.pending', localId: 'refresh' },
                qualifiedId: 'acme.pending/refresh', occurrenceId: 'pending-source' };
            const pendingModel = PluginDeclarativeProjectedModelV1Schema.parse({
                visible: true, requiredHostMethods: [],
                identity: { pluginId: 'acme.pending', localId: 'panel',
                    qualifiedId: 'acme.pending/panel', occurrenceId: 'pending-source' },
                declarativeInventory: { actions: [{ ...action, enabled: true }], destinations: [], settings: [], uiQueries: [] },
                root: { kind: 'action', path: 'root', order: 0, label: 'Refresh', action, enabled: true },
            });
            return <DeclarativePluginSurface pluginId="acme.pending" model={pendingModel}
                interactionEnabled={true} daemonInteractionEnabled={true}
                dispatchAction={execute} actionAvailable={true} openSurface={openSurface}
                openSurfaceAvailable={false} accountLifetime={accountLifetime} />;
        };
        const screen = await renderScreen(render());
        const testID = 'plugin-declarative-action:acme.pending/refresh';
        await act(async () => { screen.pressByTestId(testID); });
        expect(execute).toHaveBeenCalledTimes(1);
        await screen.update(render());
        expect(screen.findByTestId(testID)?.props.disabled).toBe(true);
        await act(async () => { screen.pressByTestId(testID); });
        expect(execute).toHaveBeenCalledTimes(1);
        await act(async () => { settle(); });
        await vi.waitFor(() => expect(screen.findByTestId(testID)?.props.disabled).toBe(false));
    });
});

describe('DeclarativePluginSurface action controls', () => {
    it('withdraws a live Action when its host publishes read-only access and restores it for Manage', async () => {
        const action = { identity: { pluginId: 'acme.manage', localId: 'save' },
            qualifiedId: 'acme.manage/save', occurrenceId: 'manage-source' };
        const actionModel = PluginDeclarativeProjectedModelV1Schema.parse({
            visible: true, requiredHostMethods: [],
            identity: { pluginId: 'acme.manage', localId: 'panel', qualifiedId: 'acme.manage/panel', occurrenceId: 'manage-source' },
            declarativeInventory: { actions: [{ ...action, enabled: true }], destinations: [], settings: [], uiQueries: [] },
            root: { kind: 'action', path: 'root', order: 0, label: 'Save', action, enabled: true },
        });
        const accountLifetime = createAccountLifetime();
        const render = (actionsReadOnly: boolean) => <DeclarativePluginSurface pluginId="acme.manage" model={actionModel}
            interactionEnabled={true} daemonInteractionEnabled={true} actionsReadOnly={actionsReadOnly}
            dispatchAction={dispatchAction} actionAvailable={true} openSurface={openSurface}
            openSurfaceAvailable={false} accountLifetime={accountLifetime} />;
        const screen = await renderScreen(render(false));
        const testID = 'plugin-declarative-action:acme.manage/save';
        expect(screen.findByTestId(testID)).not.toBeNull();
        await screen.update(render(true));
        expect(screen.findByTestId(testID)).toBeNull();
        await screen.update(render(false));
        expect(screen.findByTestId(testID)?.props.disabled).toBe(false);
    });
    // A touch target is a hit area, never a drawn size: the declarative action draws at the page
    // control height on every pointer and the shared pressable reaches the finger's target past it.
    it.each([
        ['ios', 44],
        ['android', 48],
    ] as const)('draws an action at the control height and reaches the %s target (%d) by hit area', async (platform, target) => {
        const { HAPPIER_PAGE_METRICS } = await import('@happier-dev/plugin-ui/presentation');
        const { HappierUiPlatformProvider } = await import('@happier-dev/plugin-ui/environment');
        const action = { identity: { pluginId: 'acme.sizes', localId: 'save' },
            qualifiedId: 'acme.sizes/save', occurrenceId: 'sizes-source' };
        const sizesModel = PluginDeclarativeProjectedModelV1Schema.parse({
            visible: true, requiredHostMethods: [],
            identity: { pluginId: 'acme.sizes', localId: 'panel',
                qualifiedId: 'acme.sizes/panel', occurrenceId: 'sizes-source' },
            declarativeInventory: { actions: [{ ...action, enabled: true }], destinations: [], settings: [], uiQueries: [] },
            root: { kind: 'action', path: 'root', order: 0, label: 'Save note', action, enabled: true },
        });
        const screen = await renderScreen(
            <HappierUiPlatformProvider platform={{ platform, colorScheme: 'light' }}>
                <DeclarativePluginSurface pluginId="acme.sizes" model={sizesModel}
                    interactionEnabled={true} daemonInteractionEnabled={true}
                    dispatchAction={dispatchAction} actionAvailable={true} openSurface={openSurface}
                    openSurfaceAvailable={false} accountLifetime={createAccountLifetime()} />
            </HappierUiPlatformProvider>,
        );
        const button = screen.findByTestId('plugin-declarative-action:acme.sizes/save');
        const drawn = button?.props.style({ focused: false, pressed: false, disabled: false });
        expect(drawn.minHeight).toBe(HAPPIER_PAGE_METRICS.controlHeightPx);
        expect(drawn.minWidth).toBeUndefined();
        const drawnHeight = HAPPIER_PAGE_METRICS.controlHeightPx;
        await act(async () => { button?.props.onLayout?.({ nativeEvent: { layout: { width: 176, height: drawnHeight } } }); });
        const hitSlop = screen.findByTestId('plugin-declarative-action:acme.sizes/save')?.props.hitSlop;
        expect(hitSlop.top + hitSlop.bottom + drawnHeight).toBe(target);
    });
});

describe('DeclarativePluginSurface document source feedback', () => {
    const textModel = PluginDeclarativeProjectedModelV1Schema.parse({
        visible: true,
        requiredHostMethods: [],
        identity: { pluginId: 'acme.counter', localId: 'count', qualifiedId: 'acme.counter/count', occurrenceId: 'counter-occurrence' },
        declarativeInventory: { actions: [], destinations: [], settings: [], uiQueries: [] },
        root: { kind: 'text', path: 'root', order: 0, text: 'Last value 3' },
    });
    const render = (state: 'refreshing' | 'stale') => renderScreen(
        <DeclarativePluginSurface
            pluginId="acme.counter"
            model={textModel}
            interactionEnabled={true}
            daemonInteractionEnabled={false}
            dispatchAction={dispatchAction}
            actionAvailable={false}
            openSurface={openSurface}
            openSurfaceAvailable={false}
            accountLifetime={createAccountLifetime()}
            documentSourcePresentation={{ presentation: resolvePluginSurfaceStatePresentation({ state, hasRetainedContent: true }) }}
        />,
    );

    it('keeps the last body and says nothing while a refresh runs, but still reports a stale source', async () => {
        const refreshing = await render('refreshing');
        expect(refreshing.getTextContent()).toContain('Last value 3');
        expect(refreshing.findByTestId('plugin-declarative-document-source-status:refreshing')).toBeNull();
        const stale = await render('stale');
        expect(stale.getTextContent()).toContain('Last value 3');
        expect(stale.findByTestId('plugin-declarative-document-source-status:stale')).toBeTruthy();
    });
});

describe('DeclarativePluginSurface states in a line container', () => {
    const loadingModel = PluginDeclarativeProjectedModelV1Schema.parse({
        visible: true,
        requiredHostMethods: [],
        identity: { pluginId: 'acme.counter', localId: 'count', qualifiedId: 'acme.counter/count', occurrenceId: 'counter-occurrence' },
        declarativeInventory: { actions: [], destinations: [], settings: [], uiQueries: [] },
        root: { kind: 'state', path: 'root', order: 0, state: 'loading', title: 'Loading conversations' },
    });
    const surface = () => (
        <DeclarativePluginSurface
            pluginId="acme.counter"
            model={loadingModel}
            interactionEnabled={true}
            daemonInteractionEnabled={false}
            dispatchAction={vi.fn()}
            actionAvailable={false}
            openSurface={vi.fn()}
            openSurfaceAvailable={false}
            accountLifetime={createAccountLifetime()}
        />
    );

    it('draws a state node as one quiet line inside an inspector section, and as the centred column elsewhere', async () => {
        const inSection = await renderScreen(<SurfaceStateSizeProvider size="line">{surface()}</SurfaceStateSizeProvider>);
        expect(inSection.getTextContent()).toContain('Loading conversations');
        expect(inSection.findAllByType(HappierStateLine)).toHaveLength(1);
        const whole = await renderScreen(surface());
        expect(whole.findAllByType(HappierStateLine)).toHaveLength(0);
        expect(whole.findByTestId('plugin-declarative-state:root')).toBeTruthy();
    });
});

describe('DeclarativePluginSurface settings rows', () => {
    it('draws a group of declared preferences as one settings section of rows with each setting\'s declared description', async () => {
        ordinarySettingsBoundary.read.mockResolvedValue({
            status: 'ready',
            snapshot: {
                scope: { kind: 'account' },
                target: ACCOUNT_TARGET,
                revision: { kind: 'account', value: 1 },
                values: { enabled: true, style: 'concise' },
                secretStates: {},
            },
        });
        ordinarySettingsBoundary.write.mockResolvedValue({ status: 'unavailable', reason: 'transport' });
        const setting = (id: string, title: string, description: string, schema: Record<string, unknown>) => Object.freeze({
            id,
            contributionId: 'preferences',
            qualifiedId: `acme.preferences/${id}`,
            descriptor: Object.freeze({ id, title, description, target: Object.freeze({ kind: 'plugin' }), scope: 'account', schema: Object.freeze(schema) }),
        });
        const enabled = setting('enabled', 'Review reminders', 'Receive a reminder when a review is ready.', { type: 'boolean' });
        const style = setting('style', 'Summary detail', 'Choose how much detail review summaries include.', { type: 'string', enum: ['concise', 'detailed'] });
        const inventory = (entry: typeof enabled, schema: Record<string, unknown>) => Object.freeze({
            pluginId: 'acme.preferences', id: entry.id, qualifiedId: entry.qualifiedId, schema: Object.freeze(schema), secret: false, setting: entry,
        });
        const parsed = PluginDeclarativeProjectedModelV1Schema.parse({
            visible: true,
            requiredHostMethods: [],
            identity: { pluginId: 'acme.preferences', localId: 'page', qualifiedId: 'acme.preferences/page', occurrenceId: 'preferences-occurrence' },
            declarativeInventory: {
                actions: [], destinations: [], uiQueries: [],
                settings: [inventory(enabled, { type: 'boolean' }), inventory(style, { type: 'string', enum: ['concise', 'detailed'] })],
            },
            root: {
                kind: 'group', path: 'root', order: 0, title: 'Review preferences',
                description: 'Choose when to hear about reviews and how their summaries read.',
                children: [
                    { kind: 'field', path: 'root.children[0]', order: 0, label: 'Review reminders', control: { kind: 'toggle', settingId: 'enabled' }, setting: enabled },
                    { kind: 'field', path: 'root.children[1]', order: 1, label: 'Summary detail', control: { kind: 'select', settingId: 'style', options: [
                        { value: 'concise', label: 'Concise' }, { value: 'detailed', label: 'Detailed' },
                    ] }, setting: style },
                ],
            },
        });
        const screen = await renderScreen(
            <DeclarativePluginSurface
                pluginId="acme.preferences"
                model={parsed}
                interactionEnabled={true}
                daemonInteractionEnabled={false}
                settingsScopesEnabled={{ account: true, daemon: false }}
                dispatchAction={dispatchAction}
                actionAvailable={false}
                openSurface={openSurface}
                openSurfaceAvailable={false}
                accountLifetime={createAccountLifetime()}
            />,
        );
        await vi.waitFor(() => expect(ordinarySettingsBoundary.read).toHaveBeenCalled());

        // The declared descriptions (written once, on the setting) read under each row's label.
        const text = screen.getTextContent();
        expect(text).toContain('Receive a reminder when a review is ready.');
        expect(text).toContain('Choose how much detail review summaries include.');
        // The group is one settings section, its rows inside it.
        const section = screen.findByTestId('plugin-declarative-settings-section:root');
        expect(section).not.toBeNull();
        expect(section?.findAll((node) => node.props.testID === 'plugin-declarative-field:root.children[0]:container').length).toBeGreaterThan(0);
        // Two short options are one segmented choice, not two stacked buttons.
        const segmented = screen.findAllByType(SegmentedTabBar);
        expect(segmented).toHaveLength(1);
        expect(segmented[0]?.props.role).toBe('radiogroup');
        expect(segmented[0]?.props.activeTabId).toBe('0');
    });
});
