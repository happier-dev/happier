import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { adoptHomeProfile, setActiveServerId } from '@/sync/domains/server/serverProfiles';

installApprovalCommonModuleMocks({ storage: original => original() });
const { storage } = await import('@/sync/domains/state/storage');
const { resolveUiAccountActionFallbackMachineId } = await import('./accountActionDeps');
const { createUiAccountActionTransport } = await import('./accountActionTransport');
import type { PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
const initialState = storage.getState();
let scope: { serverId: string; accountId: string };

beforeEach(async () => {
    const home = await adoptHomeProfile({ source: 'manual', descriptor: { v: 1,
        homeServerIdentityId: 'srv_account_carrier', canonicalServerUrl: 'https://account-carrier.test', revision: 1,
        endpoints: [{ kind: 'https', url: 'https://account-carrier.test' }] } });
    await setActiveServerId(home.id);
    scope = { serverId: home.id, accountId: 'carrier-owner' };
    const access = { custodian: { accountId: scope.accountId, displayName: 'Owner' },
        role: 'manage' as const, resourceMode: 'plain' as const, accessState: 'ready' as const };
    const machines = [createMachineFixture({ id: 'general', activeAt: Date.now(), createdAt: 3, access }),
        createMachineFixture({ id: 'supplier', activeAt: Date.now(), createdAt: 2, access }),
        createMachineFixture({ id: 'offline', active: false, activeAt: 0, access })];
    await publishMachineInventoryForTest(scope, machines);
});
afterEach(() => storage.setState(initialState, true));

describe('Account Action carrier selection', () => {
    const pluginId = 'acme.account-options';
    const optionsRequest = { optionsSourceId: `plugin-input:${pluginId}/account` };
    function receiver(compiled: boolean | undefined): PluginProjectionV2 {
        return { v: 2, generation: 1, installedPackagesById: {}, agentsById: {}, actionsById: {}, settingsById: {}, diagnostics: [],
            familiesById: { inputTypes: { family: 'inputTypes', entriesById: { [`${pluginId}/account`]: {
                id: `${pluginId}/account`, pluginId, pluginVersion: '1.0.0', occurrenceId: `${pluginId}:31`, definition: {
                    id: 'account', title: 'Account', semantic: 'account', valueSchema: { type: 'string' },
                    options: { resource: 'target-options' },
                },
            } } } },
            resourcesById: compiled === false ? {} : { [`${pluginId}/target-options`]: {
                id: 'target-options', pluginId, resourceKind: 'config', scope: 'global',
                execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
                ...(compiled === undefined ? {} : { accountRuntimeDeclared: compiled }),
            } },
        };
    }

    it.each([false, true])('selects an available Account Action receiver and refuses when absent (%s)', async usable => {
        const action = { pluginId: 'acme.account', localId: 'read' };
        const base = receiver(false);
        const declaration: PluginProjectionV2['actionsById'][string] = {
            id: action.localId, pluginId: action.pluginId, occurrenceId: 'acme.account:1', title: 'Read',
            scopes: ['global'], surfaces: ['ui'], dangerLevel: 'safe',
            execution: { target: 'account', account: { artifactId: 'account', exportName: 'activate' } }, available: true,
        };
        const receiverProjections = new Map<string, PluginProjectionV2>([
            ['general', { ...base, actionsById: { 'acme.account/read': { ...declaration, available: false } } }],
            ['supplier', { ...base, actionsById: usable ? { 'acme.account/read': declaration } : {} }],
            ['offline', { ...base, actionsById: { 'acme.account/read': declaration } }],
        ]);
        const execute = createUiAccountActionTransport({ account: { ...scope, assertCurrent() {}, assertResultCurrent() {} },
            resolveFallbackMachineId: () => resolveUiAccountActionFallbackMachineId(scope, { action, receiverProjections }),
            transport: async input => ({ selected: input.machineId }),
        });
        expect(await execute({ actionId: 'action.invoke', input: { action, input: {} },
            context: { ...scope, runtimeAccountId: scope.accountId, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } },
        })).toEqual(usable ? { selected: 'supplier' } : { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable', details: { code: 'target_unavailable', diagnostic: { reason: 'own_reachable_machine_absent' } } });
    });

    it('skips the stale first receiver with zero compiled Resources and chooses the current second receiver', () => {
        expect(resolveUiAccountActionFallbackMachineId(scope, { optionsRequest,
            receiverProjections: new Map([['general', receiver(false)], ['supplier', receiver(true)]]),
        })).toBe('supplier');
    });

    it('returns the existing typed refusal without dispatch when no reachable receiver declares the Resource', async () => {
        const projections = new Map([['general', receiver(false)], ['supplier', receiver(undefined)], ['offline', receiver(true)]]);
        const execute = createUiAccountActionTransport({ account: { ...scope, assertCurrent() {}, assertResultCurrent() {} },
            resolveFallbackMachineId: () => resolveUiAccountActionFallbackMachineId(scope, { optionsRequest, receiverProjections: projections }),
            transport: async () => { throw new Error('No receiver is eligible; transport must not run'); },
        });
        expect(await execute({ actionId: 'action.options.resolve', input: optionsRequest,
            context: { ...scope, runtimeAccountId: scope.accountId, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } },
        })).toEqual({ ok: false, errorCode: 'target_unavailable', error: 'target_unavailable', details: { code: 'target_unavailable', diagnostic: { reason: 'own_reachable_machine_absent' } } });
    });

    it('never uses a shared or unqualified Machine as an automatic Account host, while preserving explicit native targets', async () => {
        const access = (accountId: string, role: 'manage' | 'use' = 'manage') => ({
            custodian: { accountId, displayName: accountId }, role, resourceMode: 'plain' as const, accessState: 'ready' as const,
        });
        const shared = createMachineFixture({ id: 'shared', activeAt: Date.now(), createdAt: 6, access: access('other-owner') });
        const sharedUse = createMachineFixture({ id: 'shared-use', activeAt: Date.now(), createdAt: 5, access: access('other-owner', 'use') });
        const unqualified = createMachineFixture({ id: 'unqualified', activeAt: Date.now(), createdAt: 4 });
        const own = createMachineFixture({ id: 'own', activeAt: Date.now(), createdAt: 3, access: access(scope.accountId) });
        const machines = [shared, sharedUse, unqualified, own];
        await publishMachineInventoryForTest(scope, machines);
        expect(resolveUiAccountActionFallbackMachineId(scope)).toBe('own');
        expect(resolveUiAccountActionFallbackMachineId(scope, { candidateMachineIds: ['shared', 'shared-use', 'unqualified'] })).toBeNull();
        expect(resolveUiAccountActionFallbackMachineId(scope, { candidateMachineIds: ['shared'], allowUnreachableFallback: true })).toBeNull();
        expect(resolveUiAccountActionFallbackMachineId(scope, { target: { kind: 'machine', machineId: 'shared' } })).toBe('shared');
    });

    it('constrains automatic selection to the caller candidates without falling back to an offline carrier', () => {
        expect(resolveUiAccountActionFallbackMachineId(scope)).toBe('general');
        expect(resolveUiAccountActionFallbackMachineId(scope, { candidateMachineIds: ['supplier'] })).toBe('supplier');
        expect(resolveUiAccountActionFallbackMachineId(scope, { candidateMachineIds: ['offline'] })).toBeNull();
        expect(resolveUiAccountActionFallbackMachineId(scope, { candidateMachineIds: [] })).toBeNull();
    });

    it('honors an explicit visible target, including recovery, but never escapes the candidate set', () => {
        expect(resolveUiAccountActionFallbackMachineId(scope, { target: { kind: 'machine', machineId: 'supplier' } })).toBe('supplier');
        expect(resolveUiAccountActionFallbackMachineId(scope, { target: { kind: 'machine', machineId: 'offline' } })).toBe('offline');
        expect(resolveUiAccountActionFallbackMachineId(scope, { candidateMachineIds: ['supplier'],
            target: { kind: 'machine', machineId: 'general' } })).toBeNull();
        expect(resolveUiAccountActionFallbackMachineId(scope, { target: { kind: 'machine', machineId: 'missing' } })).toBeNull();
    });

    it('selects a captured non-active Home carrier from that Home\'s own Machines', async () => {
        const retained = await adoptHomeProfile({ source: 'manual', descriptor: { v: 1,
            homeServerIdentityId: 'srv_retained_carrier', canonicalServerUrl: 'https://retained-carrier.test', revision: 1,
            endpoints: [{ kind: 'https', url: 'https://retained-carrier.test' }] } });
        const retainedMachine = createMachineFixture({ id: 'retained', activeAt: Date.now(), access: {
            custodian: { accountId: scope.accountId, displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready',
        } });
        await publishMachineInventoryForTest({ ...scope, serverId: retained.id }, [retainedMachine]);
        expect(resolveUiAccountActionFallbackMachineId({ serverId: retained.id, accountId: 'carrier-owner' })).toBe('retained');
        expect(resolveUiAccountActionFallbackMachineId(scope)).toBe('general');
    });

    it('allows Registry manual retry, without leaking a carrier across Homes', () => {
        expect(resolveUiAccountActionFallbackMachineId(scope, { candidateMachineIds: ['offline'], allowUnreachableFallback: true })).toBe('offline');
        expect(resolveUiAccountActionFallbackMachineId({ ...scope, serverId: 'other-home' }, {
            target: { kind: 'machine', machineId: 'general' }, allowUnreachableFallback: true })).toBeNull();
    });
});
