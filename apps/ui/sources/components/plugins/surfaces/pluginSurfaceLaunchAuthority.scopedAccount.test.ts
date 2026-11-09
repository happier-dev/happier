import { describe, expect, it, onTestFinished } from 'vitest';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';
import { PluginMachineExecutionOriginV1Schema } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import type { PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';
import { isSamePluginSurfaceLaunchAuthority, resolveSelectedPluginSurfaceLaunchAuthority, resolvePluginSurfaceLaunchAuthority } from './pluginSurfaceLaunchAuthority';
import { activateStorageAccountScope } from '@/dev/testkit/runtime/storageRuntime';
import { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { readPluginUiAccountExecutableOrigin } from '@/sync/domains/plugins/ui/projectionOrigins';

const pluginId = 'acme.scoped-account';
const machineId = 'scope-machine';
const serverId = 'scope-home';
const binding = normalizePluginUiDestinationBindingV1({
    pluginId,
    destinationId: 'notes',
    rendererId: 'notes-renderer',
    container: 'rightPane',
    target: { kind: 'session' },
});
if (!binding) throw new Error('The canonical destination schema refused the authority fixture');
const executionOrigin = PluginMachineExecutionOriginV1Schema.parse({
    serverIdentityId: 'srv_scoped_home',
    materializationRef: { pluginId, machineId, materializationId: 'scope-install' },
});
const directPlacement = {
    id: 'surfacePlacement:acme.scoped-account:notes',
    pluginId,
    occurrenceId: 'scope-occurrence',
    contributionKind: 'surfacePlacement',
    descriptorId: 'notes',
    binding,
    target: binding.target,
    renderer: { kind: 'hostedWeb', contributionId: 'notes-renderer' },
    display: { developerFallback: 'Notes' },
    availability: { state: 'available', reason: 'available', diagnostics: [] },
    headerActions: [],
    ...executionOrigin,
} satisfies PluginUiSurfacePlacementProjection;
const selectedPlacement = {
    ...directPlacement,
    hostOrigin: {
        machineId,
        serverId,
        phase: 'current',
        interactionEnabled: true,
        executionOrigin,
    },
} satisfies PluginUiSurfacePlacementProjection;

describe('plugin surface exact scoped Account authority', () => {
    it.each([
        ['direct projection', directPlacement],
        ['selected-origin projection', selectedPlacement],
    ] as const)('refuses %s launch input when its exact Home has no credential lifetime', (_, placement) => {
        expect(resolvePluginSurfaceLaunchAuthority({
            placement,
            accountLifetime: null,
            scoped: { machineId, serverId, interactionEnabled: true },
        })).toBeNull();
    });

    it('preserves selected-origin authority without an exact Session or Project scope', () => {
        expect(resolvePluginSurfaceLaunchAuthority({
            placement: selectedPlacement,
            accountLifetime: null,
        })).toMatchObject({ machineId, serverId, executionOrigin });
    });
});

const accountPlacement = {
    ...directPlacement,
    occurrenceId: 'portable-custody',
    hostAccountOrigin: { serverId, accountId: 'account-a', custodyId: 'portable-custody',
        sourceCustody: { kind: 'account_release', pluginId, version: '1.0.0', archiveDigestSha256: `sha256:${'a'.repeat(64)}` } },
} satisfies PluginUiSurfacePlacementProjection;

async function admitAccount() {
    const runtime = await activateStorageAccountScope({ serverId, accountId: 'account-a' });
    onTestFinished(() => runtime.dispose());
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Expected current Account fixture');
    return lifetime;
}

it('admits Account-owned renderer launch custody without borrowing a Machine origin', async () => {
    const accountLifetime = await admitAccount();
    expect(readPluginUiAccountExecutableOrigin(accountPlacement)).not.toBeNull();
    const authority = resolveSelectedPluginSurfaceLaunchAuthority({ placement: accountPlacement, accountLifetime });
    expect(authority).toMatchObject({ serverId, machineId: null, occurrenceId: 'portable-custody', executionOrigin: null, accountLifetime });
    expect(resolvePluginSurfaceLaunchAuthority({ placement: accountPlacement, accountLifetime,
        scoped: { serverId, machineId: null, interactionEnabled: true } })).toEqual(authority);
    const withMachineSupply = resolveSelectedPluginSurfaceLaunchAuthority({
        placement: { ...accountPlacement, hostOrigin: selectedPlacement.hostOrigin }, accountLifetime,
    });
    if (!authority || !withMachineSupply) throw new Error('Expected exact Account authority');
    expect(isSamePluginSurfaceLaunchAuthority(authority, withMachineSupply)).toBe(true);
    expect(isSamePluginSurfaceLaunchAuthority(authority, resolveSelectedPluginSurfaceLaunchAuthority({
        placement: { ...accountPlacement, occurrenceId: 'replacement-custody',
            hostAccountOrigin: { ...accountPlacement.hostAccountOrigin, custodyId: 'replacement-custody' } }, accountLifetime,
    })!)).toBe(false);
});

it.each([
    { accountId: 'account-b' },
    { serverId: 'other-home' },
    { custodyId: 'not-this-occurrence' },
    { custodyId: '' },
])('refuses mismatched Account renderer custody %j even with a usable Machine stamp', async changed => {
    const accountLifetime = await admitAccount();
    const placement = { ...accountPlacement, hostOrigin: selectedPlacement.hostOrigin,
        hostAccountOrigin: { ...accountPlacement.hostAccountOrigin, ...changed } };
    expect(resolveSelectedPluginSurfaceLaunchAuthority({ placement, accountLifetime })).toBeNull();
});

it('withdraws Account renderer launch custody when its Account lifetime retires', async () => {
    const accountLifetime = await admitAccount();
    const authority = resolveSelectedPluginSurfaceLaunchAuthority({ placement: accountPlacement, accountLifetime });
    expect(authority).not.toBeNull();
    retireActiveServerAccountScopeLifetime();
    expect(resolveSelectedPluginSurfaceLaunchAuthority({ placement: accountPlacement, accountLifetime })).toBeNull();
    expect(resolveSelectedPluginSurfaceLaunchAuthority({ placement: accountPlacement, accountLifetime: null })).toBeNull();
    expect(isSamePluginSurfaceLaunchAuthority(authority!, authority!)).toBe(false);
});
