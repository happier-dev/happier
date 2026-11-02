import * as React from 'react';
import { act, create as createRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineAdministrationTargetSelectionV1 } from '@/sync/domains/machines/administration/useTargetSelection';
import { t } from '@/text';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { ApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { DaemonNpmRegistryProfileMutationRequestV1Schema } from '@happier-dev/protocol/rpc/npmRegistryProfiles';

const mocks = vi.hoisted(() => ({
    get: vi.fn(),
    mutate: vi.fn(),
    prompt: vi.fn(),
    confirm: vi.fn(),
    alert: vi.fn(),
    alertAsync: vi.fn(),
    show: vi.fn(),
    machineId: 'machine-a' as string | null,
    serverId: 'server-a' as string | null,
}));

vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({ View: 'View' }));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock({
    theme: { colors: { accent: { blue: 'blue' } } },
}));
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    // Keep Action admission, private credential delivery and the raw RPC codec real.
    machineRpcWithServerScope: async (request: Readonly<{
        machineId: string; serverId?: string | null; method: string; payload: unknown; signal?: AbortSignal;
        preparePayload?: (remainingTimeoutMs: number) => unknown; onIssued?: () => void;
    }>) => {
        if (request.method === RPC_METHODS.DAEMON_NPM_REGISTRY_PROFILES_GET)
            return mocks.get(request.machineId, { serverId: request.serverId, signal: request.signal });
        if (request.method !== RPC_METHODS.DAEMON_NPM_REGISTRY_PROFILES_MUTATE)
            throw new Error('Unexpected registry Machine RPC');
        const mutation = DaemonNpmRegistryProfileMutationRequestV1Schema.parse(request.preparePayload?.(0) ?? request.payload);
        request.onIssued?.();
        return mocks.mutate(request.machineId, mutation, { serverId: request.serverId, signal: request.signal });
    },
}));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
    spies: {
        prompt: mocks.prompt,
        confirm: mocks.confirm,
        alert: mocks.alert,
        alertAsync: mocks.alertAsync,
        show: mocks.show,
    },
}).module);
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { NpmRegistryProfilesSection } = await import('./NpmRegistryProfilesSection');
const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
let homeA: string;
let homeB: string;
const mountedTrees = new Set<ReturnType<typeof createRenderer>>();
const create: typeof createRenderer = (...args) => {
    const tree = createRenderer(...args);
    mountedTrees.add(tree);
    return tree;
};
afterEach(async () => {
    await act(async () => { for (const tree of mountedTrees) tree.unmount(); mountedTrees.clear(); });
    standardCleanup();
    await disconnectActiveServerConnection();
    await homes.reset();
});

type RegistryRowAction = Readonly<{
    id: string;
    title: string;
    accessibilityLabel?: string;
    disabled: boolean;
    onPress: () => void;
}>;

/** The actions carried by one profile's row. */
function profileActions(
    tree: ReturnType<typeof create>,
    profileId: string,
): readonly RegistryRowAction[] {
    return tree.root.findAllByType(ItemRowActions)
        .flatMap((node) => (
            (node.props as Readonly<{ overflowTriggerTestID?: string }>).overflowTriggerTestID
                === `settings.plugins.registries.profile.${profileId}.actions.overflow`
                ? (node.props as Readonly<{ actions?: readonly RegistryRowAction[] }>).actions ?? []
                : []
        ));
}

function profileAction(
    tree: ReturnType<typeof create>,
    profileId: string,
    actionId: string,
): RegistryRowAction | undefined {
    return profileActions(tree, profileId).find((action) => action.id === actionId);
}

type BindingMenuItem = Readonly<{ id: string; testID?: string; title: string }>;

/** The selection a marketplace source's single row offers for its registry. */
function bindingMenu(tree: ReturnType<typeof create>, sourceId: string): Readonly<{
    selectedId: string;
    items: readonly BindingMenuItem[];
    select: (profileId: string) => void;
}> {
    const node = tree.root.findByProps({
        testID: `settings.plugins.registries.marketplaceBinding.${sourceId}`,
    });
    const props = node.props as Readonly<{
        selectedId: string;
        items: readonly BindingMenuItem[];
        onSelect: (profileId: string) => void;
    }>;
    return { selectedId: props.selectedId, items: props.items, select: props.onSelect };
}

/**
 * Answers the profile form the way a reader who finished it would.
 *
 * The form is a modal the host owns, so the test drives it through that
 * boundary and leaves the form's own contract to its focused tests.
 */
function answerProfileForm(profile: Readonly<Record<string, unknown>> | null): void {
    mocks.show.mockImplementation((config: Readonly<{
        props?: Readonly<{ onResolve?: (value: unknown) => void }>;
        onRequestClose?: () => void;
    }>) => {
        if (profile === null) config.onRequestClose?.();
        else config.props?.onResolve?.(profile);
        return 'npm-registry-profile-editor';
    });
}

type NpmRegistryProfilesTargetSelection = Pick<
    MachineAdministrationTargetSelectionV1,
    'selectedTarget' | 'canExecute' | 'resolveExecutionTarget'
>;

function createTargetSelection(
    machineId = mocks.machineId,
    serverId = mocks.serverId,
): NpmRegistryProfilesTargetSelection {
    if (!machineId || !serverId) {
        return {
            selectedTarget: null,
            canExecute: false,
            resolveExecutionTarget: () => null,
        };
    }
    const target = { serverIdentityId: serverId === homeA ? 'srv_registry_a' : 'srv_registry_b', machineId };
    return {
        selectedTarget: target,
        canExecute: true,
        resolveExecutionTarget: () => ({
            kind: 'resolved',
            target,
            serverId,
            profile: {
                id: serverId,
                name: `Server ${serverId}`,
                serverUrl: `https://${serverId}.example.test`,
                serverIdentityId: target.serverIdentityId,
                createdAt: 1,
                updatedAt: 1,
                lastUsedAt: 1,
            },
            machine: {
                id: machineId,
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                metadata: null,
                metadataVersion: 0,
                daemonState: null,
                daemonStateVersion: 0,
            },
        }),
    };
}

type TestSectionProps = Omit<React.ComponentProps<typeof NpmRegistryProfilesSection>, 'targetSelection'> & Readonly<{
    targetSelection?: NpmRegistryProfilesTargetSelection;
}>;

function TestSection({ targetSelection = createTargetSelection(), ...props }: TestSectionProps): React.ReactElement {
    return <NpmRegistryProfilesSection {...props} targetSelection={targetSelection} />;
}

async function flush(): Promise<void> {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function submitInlineCredential(tree: ReturnType<typeof create>, profileId = 'registry_acme') {
    await act(async () => { profileAction(tree, profileId, 'login')?.onPress(); });
    await act(async () => {
        tree.root.findAll((node) => node.props.testID === 'settings.plugins.registries.login.token' && typeof node.props.onChangeText === 'function')[0]!.props.onChangeText('boundary-secret');
    });
    await act(async () => {
        tree.root.findAll((node) => node.props.testID === 'settings.plugins.registries.login.save' && typeof node.props.onPress === 'function')[0]!.props.onPress();
    });
    await flush();
}

function snapshot(profileId = 'registry_acme', displayName = 'Acme', hasCredentials = false) {
    const origin = profileId === 'registry_acme'
        ? 'https://registry.acme.test'
        : 'https://registry.beta.test';
    return {
        protocolVersion: 1 as const,
        revision: 2,
        profiles: [{
            profileId, displayName, origin, scopes: ['@acme'],
            useAsDefault: false,
            allowPrivateNetwork: false,
            hasCredentials,
            authenticationState: hasCredentials ? 'configured' as const : 'missing' as const,
            availability: hasCredentials ? 'available' as const : 'sign_in_required' as const,
            lastSuccessfulCheckAtMs: null,
            updatedAtMs: 1,
        }],
        pausedSources: [],
    };
}

describe('NpmRegistryProfilesSection', () => {
    beforeEach(async () => {
        await homes.reset();
        await loadSyncSingletonForTests();
        homeA = await homes.addHome({ name: 'Registry A', serverUrl: 'https://registry-home-a.test', serverIdentityId: 'srv_registry_a',
            accountId: 'registry-account', currentAccount: true });
        homeB = await homes.addHome({ name: 'Registry B', serverUrl: 'https://registry-home-b.test', serverIdentityId: 'srv_registry_b',
            accountId: 'registry-account', currentAccount: true, active: false });
        mocks.machineId = 'machine-a';
        mocks.serverId = homeA;
        mocks.get.mockReset().mockResolvedValue({
            status: 'success',
            snapshot: snapshot(),
        });
        mocks.mutate.mockReset().mockResolvedValue({
            status: 'success', snapshot: { protocolVersion: 1, revision: 3, profiles: [], pausedSources: [] },
        });
        mocks.prompt.mockReset();
        mocks.confirm.mockReset().mockResolvedValue(true);
        mocks.alert.mockReset();
        mocks.alertAsync.mockReset();
        mocks.show.mockReset().mockReturnValue('npm-registry-profile-editor');
    });

    it('loads secret-free profiles and exposes a sign-in action', async () => {
        const { Item } = await import('@/components/ui/lists/Item');
        const screen = await renderScreen(<TestSection daemonOperationsAvailable />);
        const tree = screen.tree;
        await flush();
        expect(mocks.get).toHaveBeenCalledWith('machine-a', expect.objectContaining({ serverId: homeA }));
        const profile = tree.root.findByProps({ testID: 'settings.plugins.registries.profile.registry_acme' });
        expect(profile.props.subtitle).toContain('https://registry.acme.test');
        // One profile is one row: edit, sign in, test and remove are that row's
        // own actions rather than four more rows about the same registry.
        expect(profileActions(tree, 'registry_acme').map((action) => action.id))
            .toEqual(['edit', 'login', 'test', 'remove']);
        expect(screen.findAllByType(Item).filter((node) => (
            node.props.testID === 'settings.plugins.registries.edit.registry_acme'
        ))).toHaveLength(0);
        // The repeated icon controls name the profile they act on.
        expect(profileAction(tree, 'registry_acme', 'login')?.accessibilityLabel)
            .toContain('Acme');
    });

    it('cancels a stalled profile read on target replacement and unmount, then loads on retry', async () => {
        const signals: Array<AbortSignal | undefined> = [];
        mocks.get.mockImplementation((_machineId: string, options: { signal?: AbortSignal }) => {
            signals.push(options.signal);
            return new Promise((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
        });
        const firstTarget = createTargetSelection('machine-a', homeA);
        const secondTarget = createTargetSelection('machine-b', homeB);
        const screen = await renderScreen(<TestSection daemonOperationsAvailable targetSelection={firstTarget} />);
        await flush();
        await act(async () => { screen.tree.update(<TestSection daemonOperationsAvailable targetSelection={secondTarget} />); });
        await flush();
        expect(signals[0]?.aborted).toBe(true);
        expect(signals[1]?.aborted).toBe(false);
        await act(async () => screen.tree.unmount());
        expect(signals[1]?.aborted).toBe(true);
        mocks.get.mockResolvedValue({ status: 'success', snapshot: snapshot() });
        const retry = await renderScreen(<TestSection daemonOperationsAvailable targetSelection={secondTarget} />);
        await flush();
        expect(retry.tree.root.findByProps({ testID: 'settings.plugins.registries.profile.registry_acme' })).toBeTruthy();
    });

    it('retires an issued profile mutation when its selected machine changes', async () => {
        let requestSignal: AbortSignal | undefined;
        mocks.mutate.mockImplementation((_machineId: string, _request: unknown, options: { signal?: AbortSignal }) => {
            requestSignal = options.signal;
            return new Promise((_resolve, reject) => requestSignal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
        });
        const firstTarget = createTargetSelection('machine-a', homeA);
        const secondTarget = createTargetSelection('machine-b', homeA);
        const screen = await renderScreen(<TestSection daemonOperationsAvailable targetSelection={firstTarget} />);
        await flush();
        await act(async () => { profileAction(screen.tree, 'registry_acme', 'test')?.onPress(); });
        await vi.waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1));
        await act(async () => { screen.tree.update(<TestSection daemonOperationsAvailable targetSelection={secondTarget} />); });
        await flush();
        expect(requestSignal?.aborted).toBe(true);
        expect(screen.tree.root.findByProps({ testID: 'settings.plugins.registries.profile.registry_acme' }).props.loading).toBe(false);
    });

    it('uses the supplied fresh exact target rather than deriving the primary machine', async () => {
        const targetSelection = createTargetSelection('machine-b', homeB);
        let tree!: ReturnType<typeof create>;
        await act(async () => {
            tree = create(<TestSection
                daemonOperationsAvailable
                targetSelection={targetSelection}
            />);
        });
        await flush();

        expect(tree.root.findByProps({ testID: 'settings.plugins.registries.profile.registry_acme' })).toBeTruthy();
        expect(mocks.get).toHaveBeenCalledWith('machine-b', expect.objectContaining({ serverId: homeB }));
        expect(mocks.get).not.toHaveBeenCalledWith('machine-a', expect.objectContaining({ serverId: homeA }));
    });

    it('routes a profile mutation through the supplied fresh exact target', async () => {
        const selected = createTargetSelection('machine-b', homeB);
        const resolveExecutionTarget = vi.fn(selected.resolveExecutionTarget);
        const targetSelection: NpmRegistryProfilesTargetSelection = {
            ...selected,
            resolveExecutionTarget,
        };
        let tree!: ReturnType<typeof create>;
        await act(async () => {
            tree = create(<TestSection daemonOperationsAvailable targetSelection={targetSelection} />);
        });
        await flush();
        const testAction = profileAction(tree, 'registry_acme', 'test');
        expect(testAction?.disabled).toBe(false);
        const callsBeforeMutation = resolveExecutionTarget.mock.calls.length;

        await act(async () => {
            testAction?.onPress();
        });
        await flush();

        expect(resolveExecutionTarget.mock.calls.length).toBeGreaterThan(callsBeforeMutation);

        expect(mocks.mutate).toHaveBeenCalledWith('machine-b', expect.objectContaining({
            action: 'test',
            profileId: 'registry_acme',
            machineId: 'machine-b',
            expectedRevision: 2,
        }), expect.objectContaining({ serverId: homeB }));
        expect(mocks.mutate).not.toHaveBeenCalledWith('machine-a', expect.anything(), expect.objectContaining({ serverId: homeA }));
    });

    it('does not send a profile mutation after fresh resolution loses the selected target', async () => {
        const selected = createTargetSelection('machine-b', homeB);
        let current = selected.resolveExecutionTarget();
        const targetSelection: NpmRegistryProfilesTargetSelection = {
            ...selected,
            resolveExecutionTarget: () => current,
        };
        let tree!: ReturnType<typeof create>;
        await act(async () => {
            tree = create(<TestSection daemonOperationsAvailable targetSelection={targetSelection} />);
        });
        await flush();

        current = null;
        await act(async () => {
            profileAction(tree, 'registry_acme', 'test')?.onPress();
        });
        await flush();

        expect(mocks.mutate).not.toHaveBeenCalled();
    });

    it('fails closed when its selected portable target cannot be freshly resolved', async () => {
        const selected = createTargetSelection('machine-b', homeB);
        const targetSelection: NpmRegistryProfilesTargetSelection = {
            ...selected,
            canExecute: false,
            resolveExecutionTarget: () => null,
        };
        let tree!: ReturnType<typeof create>;
        await act(async () => {
            tree = create(<TestSection daemonOperationsAvailable targetSelection={targetSelection} />);
        });
        await flush();

        expect(mocks.get).not.toHaveBeenCalled();
        expect(tree.root.findByProps({ testID: 'settings.plugins.registries.add' }).props.disabled).toBe(true);
    });

    it('discards a read when fresh resolution loses the same selected target', async () => {
        const selected = createTargetSelection('machine-a', homeA);
        let current = selected.resolveExecutionTarget();
        const targetSelection: NpmRegistryProfilesTargetSelection = {
            ...selected,
            resolveExecutionTarget: () => current,
        };
        let resolveGet!: (value: unknown) => void;
        const pendingGet = new Promise((resolve) => { resolveGet = resolve; });
        mocks.get.mockReturnValueOnce(pendingGet);
        let tree!: ReturnType<typeof create>;
        await act(async () => {
            tree = create(<TestSection daemonOperationsAvailable targetSelection={targetSelection} />);
        });
        expect(mocks.get).toHaveBeenCalledWith('machine-a', expect.objectContaining({ serverId: homeA }));

        current = null;
        await act(async () => {
            resolveGet({ status: 'success', snapshot: snapshot() });
            await pendingGet;
        });

        expect(tree.root.findAllByProps({ testID: 'settings.plugins.registries.profile.registry_acme' })).toHaveLength(0);
    });

    it('binds and unbinds a marketplace source by opaque profile id without handling credentials', async () => {
        const setBinding = vi.fn(async () => ({ status: 'success' as const }));
        const source = {
            id: 'marketplace:private', title: 'Private catalog', sourceUrl: 'https://catalog.example.test/private.json',
            enabled: true, origin: 'curated' as const, addedAtMs: 1, updatedAtMs: 1,
        };
        let tree!: ReturnType<typeof create>;
        await act(async () => {
            tree = create(<TestSection
                daemonOperationsAvailable
                marketplaceSources={[source]}
                onSetMarketplaceSourceProfile={setBinding}
            />);
        });
        await flush();
        // One source is one row: its registry is chosen from that row's own
        // selection rather than from a row per source-and-profile pair.
        expect(tree.root.findAllByProps({
            testID: 'settings.plugins.registries.marketplaceSource.marketplace:private',
        }).length).toBeGreaterThan(0);
        const unbound = bindingMenu(tree, 'marketplace:private');
        expect(unbound.items.map((item) => item.testID)).toEqual([
            'settings.plugins.registries.unbind.marketplace:private',
            'settings.plugins.registries.bind.marketplace:private.registry_acme',
        ]);
        await act(async () => {
            unbound.select('registry_acme');
        });
        expect(setBinding).toHaveBeenCalledWith('marketplace:private', 'registry_acme');

        await act(async () => {
            tree.update(<TestSection
                daemonOperationsAvailable
                marketplaceSources={[{ ...source, registryProfileId: 'registry_acme' }]}
                onSetMarketplaceSourceProfile={setBinding}
            />);
        });
        const bound = bindingMenu(tree, 'marketplace:private');
        expect(bound.selectedId).toBe('registry_acme');
        await act(async () => {
            bound.select('');
        });
        expect(setBinding).toHaveBeenLastCalledWith('marketplace:private', null);
    });

    it('can unbind a source whose referenced profile was removed', async () => {
        mocks.get.mockResolvedValueOnce({
            status: 'success',
            snapshot: { protocolVersion: 1, revision: 4, profiles: [], pausedSources: [] },
        });
        const setBinding = vi.fn(async () => ({ status: 'success' as const }));
        let tree!: ReturnType<typeof create>;
        await act(async () => {
            tree = create(<TestSection
                daemonOperationsAvailable
                marketplaceSources={[{
                    id: 'marketplace:private', title: 'Private catalog', sourceUrl: 'https://catalog.example.test/private.json',
                    enabled: true, origin: 'curated', registryProfileId: 'registry_removed', addedAtMs: 1, updatedAtMs: 1,
                }]}
                onSetMarketplaceSourceProfile={setBinding}
            />);
        });
        await flush();
        await act(async () => {
            bindingMenu(tree, 'marketplace:private').select('');
        });
        expect(setBinding).toHaveBeenCalledWith('marketplace:private', null);
    });

    it('keeps the token in the inline secure editor until explicit sign-in, then clears it', async () => {
        let tree!: ReturnType<typeof create>;
        await act(async () => { tree = create(<TestSection daemonOperationsAvailable />); });
        await flush();
        await act(async () => { await profileAction(tree, 'registry_acme', 'login')?.onPress(); });
        expect(mocks.mutate).not.toHaveBeenCalled();
        const field = tree.root.findAll((node) => node.props.testID === 'settings.plugins.registries.login.token' && typeof node.props.onChangeText === 'function')[0];
        expect(field).toBeDefined();
        expect(field.props.secureTextEntry).toBe(true);
        await act(async () => { field.props.onChangeText('boundary-secret'); });
        await act(async () => { tree.root.findAll((node) => node.props.testID === 'settings.plugins.registries.login.save' && typeof node.props.onPress === 'function')[0]!.props.onPress(); });
        await flush();
        expect(mocks.prompt).not.toHaveBeenCalled();
        expect(mocks.mutate).toHaveBeenCalledWith('machine-a', expect.objectContaining({
            action: 'login', credential: { kind: 'bearer_token', secret: 'boundary-secret' }, expectedRevision: 2,
        }), expect.objectContaining({ serverId: homeA }));
        const renderedText = tree.root.findAll((node) => (
            typeof node.props.title === 'string' || typeof node.props.subtitle === 'string'
        )).flatMap((node) => [node.props.title, node.props.subtitle]).filter((value): value is string => typeof value === 'string');
        expect(renderedText.join('\n')).not.toContain('boundary-secret');
        expect(tree.root.findAll((node) => node.props.testID === 'settings.plugins.registries.login.token')).toHaveLength(0);
    });

    it('retains a private login token in the originating mounted invocation across Ask-first', async () => {
        await homes.requireUiApproval(homeA, 'plugins.npm_registry_profiles.login');
        let tree!: ReturnType<typeof create>;
        await act(async () => { tree = create(<TestSection daemonOperationsAvailable />); });
        await flush();
        await submitInlineCredential(tree);
        let pending: Readonly<{ id: string; request: ReturnType<typeof ApprovalRequestSchema.parse> }> | undefined;
        await waitForHomeGovernance(() => {
            pending = homes.artifacts(homeA).list().map(row => ({ id: row.id,
                request: ApprovalRequestSchema.parse(JSON.parse(homes.artifacts(homeA).readPlainBody(row.id) ?? 'null')) }))
                .find(({ request }) => request.actionId === 'plugins.npm_registry_profiles.login');
            expect(pending).toBeDefined();
        });
        expect(mocks.mutate).not.toHaveBeenCalled();
        expect(pending?.request.approval?.flow).toBe('blocking');
        expect(JSON.stringify(pending?.request)).not.toContain('boundary-secret');
        if (!pending) throw new Error('Missing registry login approval');
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        await act(async () => {
            expect(await createDefaultActionExecutor().execute('approval.request.decide', {
                artifactId: pending!.id, decision: 'approve',
            }, { surface: 'ui', serverId: homeA, expectedAccountId: 'registry-account' })).toMatchObject({ ok: true });
        });
        await waitForHomeGovernance(() => expect(mocks.mutate).toHaveBeenCalledWith('machine-a', expect.objectContaining({
            action: 'login', expectedRevision: 2, credential: { kind: 'bearer_token', secret: 'boundary-secret' },
        }), expect.objectContaining({ serverId: homeA })));
        expect(mocks.prompt).not.toHaveBeenCalled();
    });

    it('keeps removed or signed-out sources visible as paused update diagnostics', async () => {
        mocks.get.mockResolvedValueOnce({
            status: 'success', snapshot: {
                protocolVersion: 1, revision: 4, profiles: [],
                pausedSources: [{ origin: 'https://registry.old.test', reason: 'profile_removed', updatedAtMs: 4 }],
            },
        });
        let tree!: ReturnType<typeof create>;
        await act(async () => { tree = create(<TestSection daemonOperationsAvailable />); });
        await flush();
        expect(tree.root.findByProps({ testID: 'settings.plugins.registries.paused.https://registry.old.test' }).props.subtitle)
            .toContain('https://registry.old.test');
    });

    it('renders empty and retryable load states instead of silently clearing the section', async () => {
        mocks.get.mockRejectedValueOnce(new Error('offline'));
        let tree!: ReturnType<typeof create>;
        await act(async () => { tree = create(<TestSection daemonOperationsAvailable />); });
        await flush();
        expect(tree.root.findByProps({ testID: 'settings.plugins.registries.loadError' })).toBeTruthy();

        mocks.get.mockResolvedValueOnce({
            status: 'success', snapshot: { protocolVersion: 1, revision: 0, profiles: [], pausedSources: [] },
        });
        await act(async () => {
            await tree.root.findByProps({ testID: 'settings.plugins.registries.retry' }).props.onPress();
        });
        await flush();
        expect(tree.root.findByProps({ testID: 'settings.plugins.registries.empty' })).toBeTruthy();
    });

    it('abandons a new registry profile when the form is dismissed', async () => {
        answerProfileForm(null);
        let tree!: ReturnType<typeof create>;
        await act(async () => { tree = create(<TestSection daemonOperationsAvailable />); });
        await flush();

        await act(async () => { await tree.root.findByProps({ testID: 'settings.plugins.registries.add' }).props.onPress(); });

        // One form, not a chain of prompts, and nothing is sent from a profile
        // the reader never finished.
        expect(mocks.show).toHaveBeenCalledTimes(1);
        expect(mocks.prompt).not.toHaveBeenCalled();
        expect(mocks.mutate).not.toHaveBeenCalled();
    });

    it('adds the whole profile the form produced through one revisioned mutation', async () => {
        answerProfileForm({
            displayName: 'Beta',
            origin: 'https://registry.beta.test',
            scopes: ['@beta'],
            useAsDefault: false,
            allowPrivateNetwork: true,
        });
        let tree!: ReturnType<typeof create>;
        await act(async () => { tree = create(<TestSection daemonOperationsAvailable />); });
        await flush();

        await act(async () => { await tree.root.findByProps({ testID: 'settings.plugins.registries.add' }).props.onPress(); });

        expect(mocks.show).toHaveBeenCalledTimes(1);
        await vi.waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith('machine-a', expect.objectContaining({
            action: 'add',
            expectedRevision: 2,
            profile: {
                displayName: 'Beta',
                origin: 'https://registry.beta.test',
                scopes: ['@beta'],
                useAsDefault: false,
                allowPrivateNetwork: true,
            },
        }), expect.objectContaining({ serverId: homeA })));
        // The new profile is checked by its owner at once, against the revision
        // the add produced, so its availability is known rather than "unknown".
        const added = mocks.mutate.mock.calls[0]?.[1] as Readonly<{ profileId: string }>;
        await vi.waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(2));
        expect(mocks.mutate).toHaveBeenLastCalledWith('machine-a', expect.objectContaining({
            action: 'test', profileId: added.profileId, expectedRevision: 3,
        }), expect.objectContaining({ serverId: homeA }));
    });

    it('offers the registry a caller needs as the new profile the form starts from', async () => {
        answerProfileForm(null);
        const subject = {
            displayName: 'npm.acme.example',
            origin: 'https://npm.acme.example',
            scopes: ['@acme'],
            useAsDefault: false,
            allowPrivateNetwork: false,
        };
        let tree!: ReturnType<typeof create>;
        await act(async () => { tree = create(<TestSection daemonOperationsAvailable createProfileSubject={subject} />); });
        await flush();

        await act(async () => { await tree.root.findByProps({ testID: 'settings.plugins.registries.add' }).props.onPress(); });

        expect(mocks.show).toHaveBeenCalledWith(expect.objectContaining({
            props: expect.objectContaining({ mode: 'create', subject }),
        }));
    });

    it('signs in with one mutation, because the daemon sign-in already checks the credential', async () => {
        mocks.prompt.mockResolvedValueOnce('boundary-secret');
        mocks.mutate
            .mockResolvedValueOnce({ status: 'success', snapshot: { ...snapshot('registry_acme', 'Acme', true), revision: 3 } });
        let tree!: ReturnType<typeof create>;
        await act(async () => { tree = create(<TestSection daemonOperationsAvailable />); });
        await flush();

        await submitInlineCredential(tree);

        expect(mocks.mutate).toHaveBeenCalledTimes(1);
        expect(mocks.mutate).toHaveBeenCalledWith('machine-a', expect.objectContaining({
            action: 'login', profileId: 'registry_acme', expectedRevision: 2,
        }), expect.objectContaining({ serverId: homeA }));
        expect(tree.root.findByProps({ testID: 'settings.plugins.registries.profile.registry_acme' }).props.loading)
            .toBe(false);
    });

    it('edits profile routing and network policy through one revisioned update', async () => {
        answerProfileForm({
            displayName: 'Acme updated',
            origin: 'https://registry.acme.test',
            scopes: ['@acme', '@team'],
            useAsDefault: true,
            allowPrivateNetwork: false,
        });
        let tree!: ReturnType<typeof create>;
        await act(async () => { tree = create(<TestSection daemonOperationsAvailable />); });
        await flush();

        await act(async () => {
            await profileAction(tree, 'registry_acme', 'edit')?.onPress();
        });

        // The form opened on the profile as it stands, so the reader reviews
        // rather than retypes it.
        expect(mocks.show).toHaveBeenCalledWith(expect.objectContaining({
            props: expect.objectContaining({
                mode: 'edit',
                subject: expect.objectContaining({
                    displayName: 'Acme',
                    origin: 'https://registry.acme.test',
                    scopes: ['@acme'],
                }),
            }),
        }));
        await vi.waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith('machine-a', expect.objectContaining({
            action: 'update',
            profileId: 'registry_acme',
            expectedRevision: 2,
            profile: {
                displayName: 'Acme updated',
                origin: 'https://registry.acme.test',
                scopes: ['@acme', '@team'],
                useAsDefault: true,
                allowPrivateNetwork: false,
            },
        }), expect.objectContaining({ serverId: homeA })));
    });

    it('ignores a late profile response from a previously selected machine', async () => {
        let resolveFirst!: (value: unknown) => void;
        const first = new Promise((resolve) => { resolveFirst = resolve; });
        mocks.get.mockImplementation((machineId: string) => (
            machineId === 'machine-a'
                ? first
                : Promise.resolve({ status: 'success', snapshot: snapshot('registry_beta', 'Beta') })
        ));
        let tree!: ReturnType<typeof create>;
        await act(async () => { tree = create(<TestSection daemonOperationsAvailable />); });
        mocks.machineId = 'machine-b';
        await act(async () => { tree.update(<TestSection daemonOperationsAvailable />); });
        await flush();
        expect(tree.root.findByProps({ testID: 'settings.plugins.registries.profile.registry_beta' })).toBeTruthy();

        await act(async () => {
            resolveFirst({ status: 'success', snapshot: snapshot('registry_acme', 'Acme') });
            await first;
        });
        expect(tree.root.findAllByProps({ testID: 'settings.plugins.registries.profile.registry_acme' })).toHaveLength(0);
    });

    it('contains rejected mutations, reports the error, and releases the busy state', async () => {
        mocks.prompt.mockResolvedValueOnce('boundary-secret');
        mocks.mutate.mockRejectedValueOnce(new Error('offline'));
        let tree!: ReturnType<typeof create>;
        await act(async () => { tree = create(<TestSection daemonOperationsAvailable />); });
        await flush();
        await submitInlineCredential(tree);
        expect(mocks.alert).toHaveBeenCalled();
        // Progress belongs to the profile row, and it is released on failure.
        expect(tree.root.findByProps({ testID: 'settings.plugins.registries.profile.registry_acme' }).props.loading)
            .toBe(false);
    });

    it('refreshes and presents an issued credential mutation with an unknown outcome without replaying it', async () => {
        mocks.prompt.mockResolvedValueOnce('boundary-secret');
        mocks.mutate.mockResolvedValueOnce({ status: 'outcomeUnknown' });
        mocks.get.mockResolvedValueOnce({ status: 'success', snapshot: snapshot() })
            .mockResolvedValueOnce({ status: 'success', snapshot: snapshot('registry_acme', 'Acme', true) });
        let tree!: ReturnType<typeof create>;
        await act(async () => { tree = create(<TestSection daemonOperationsAvailable />); });
        await flush();

        await submitInlineCredential(tree);
        await flush();

        expect(mocks.mutate).toHaveBeenCalledTimes(1);
        expect(mocks.get).toHaveBeenCalledTimes(2);
        expect(mocks.alert).toHaveBeenCalledWith(
            t('settingsPlugins.sourceAdministration.operationOutcomeUnknownTitle'),
            t('settingsPlugins.sourceAdministration.operationOutcomeUnknownBody'),
        );
        expect(profileAction(tree, 'registry_acme', 'logout')).toBeTruthy();
    });

    it('presents a revision conflict as changed state after refreshing the canonical snapshot', async () => {
        mocks.prompt.mockResolvedValueOnce('boundary-secret');
        mocks.mutate.mockResolvedValueOnce({
            status: 'error', code: 'revision_conflict', retryable: false, currentRevision: 3,
        });
        let tree!: ReturnType<typeof create>;
        await act(async () => { tree = create(<TestSection daemonOperationsAvailable />); });
        await flush();

        await submitInlineCredential(tree);

        expect(mocks.get).toHaveBeenCalledTimes(2);
        expect(mocks.alert).toHaveBeenCalledWith(
            t('settingsPlugins.registriesConflictTitle'),
            t('settingsPlugins.registriesConflictBody'),
        );
    });

    it('opens no profile form and sends nothing while the daemon is unavailable', async () => {
        answerProfileForm({
            displayName: 'Beta',
            origin: 'https://registry.beta.test',
            scopes: [],
            useAsDefault: false,
            allowPrivateNetwork: false,
        });
        let tree!: ReturnType<typeof create>;
        await act(async () => { tree = create(<TestSection daemonOperationsAvailable />); });
        await flush();
        await act(async () => { tree.update(<TestSection daemonOperationsAvailable={false} />); });

        await act(async () => { await tree.root.findByProps({ testID: 'settings.plugins.registries.add' }).props.onPress(); });

        expect(mocks.show).not.toHaveBeenCalled();
        expect(mocks.mutate).not.toHaveBeenCalled();
    });

    it('keeps the cached profile read-only and performs no daemon work while offline', async () => {
        const acme = snapshot();
        const beta = snapshot('registry_beta', 'Beta', true);
        mocks.get.mockResolvedValueOnce({
            status: 'success',
            snapshot: { ...acme, profiles: [...acme.profiles, ...beta.profiles] },
        });
        let tree!: ReturnType<typeof create>;
        await act(async () => { tree = create(<TestSection daemonOperationsAvailable />); });
        await flush();

        await act(async () => {
            tree.update(<TestSection daemonOperationsAvailable={false} />);
        });

        expect(mocks.get).toHaveBeenCalledTimes(1);
        expect(tree.root.findByProps({ testID: 'settings.plugins.registries.profile.registry_acme' })).toBeTruthy();
        expect(tree.root.findByProps({ testID: 'settings.plugins.registries.add' }).props.disabled).toBe(true);
        for (const action of [
            ...profileActions(tree, 'registry_acme'),
            ...profileActions(tree, 'registry_beta'),
        ]) {
            expect(action.disabled).toBe(true);
        }
        expect(profileActions(tree, 'registry_acme').map((action) => action.id))
            .toEqual(['edit', 'login', 'test', 'remove']);
        expect(profileActions(tree, 'registry_beta').map((action) => action.id))
            .toEqual(['edit', 'logout', 'test', 'remove']);

        await act(async () => {
            await profileAction(tree, 'registry_acme', 'login')?.onPress();
            await profileAction(tree, 'registry_acme', 'test')?.onPress();
            await profileAction(tree, 'registry_beta', 'logout')?.onPress();
        });
        expect(mocks.prompt).not.toHaveBeenCalled();
        expect(mocks.mutate).not.toHaveBeenCalled();
    });

    it('ignores a profile read that completes after daemon operations become unavailable', async () => {
        let resolveGet!: (value: unknown) => void;
        const pendingGet = new Promise((resolve) => { resolveGet = resolve; });
        mocks.get.mockReturnValueOnce(pendingGet);

        let tree!: ReturnType<typeof create>;
        await act(async () => { tree = create(<TestSection daemonOperationsAvailable />); });
        await act(async () => {
            tree.update(<TestSection daemonOperationsAvailable={false} />);
        });
        await act(async () => {
            resolveGet({ status: 'success', snapshot: snapshot() });
            await pendingGet;
        });

        expect(tree.root.findAllByProps({ testID: 'settings.plugins.registries.profile.registry_acme' })).toHaveLength(0);
        expect(mocks.get).toHaveBeenCalledTimes(1);
    });

    it('ignores a mutation result from before disconnect even after reconnect refreshes the profile', async () => {
        let resolveMutation!: (value: unknown) => void;
        const pendingMutation = new Promise((resolve) => { resolveMutation = resolve; });
        mocks.prompt.mockResolvedValueOnce('boundary-secret');
        mocks.mutate.mockReturnValueOnce(pendingMutation);

        let tree!: ReturnType<typeof create>;
        await act(async () => { tree = create(<TestSection daemonOperationsAvailable />); });
        await flush();
        await submitInlineCredential(tree);
        await flush();
        expect(mocks.mutate).toHaveBeenCalledTimes(1);

        await act(async () => {
            tree.update(<TestSection daemonOperationsAvailable={false} />);
        });
        await act(async () => {
            tree.update(<TestSection daemonOperationsAvailable />);
        });
        await flush();
        expect(mocks.get).toHaveBeenCalledTimes(2);
        await act(async () => {
            resolveMutation({ status: 'success', snapshot: snapshot('registry_beta', 'Beta') });
            await pendingMutation;
        });

        expect(tree.root.findByProps({ testID: 'settings.plugins.registries.profile.registry_acme' })).toBeTruthy();
        expect(tree.root.findAllByProps({ testID: 'settings.plugins.registries.profile.registry_beta' })).toHaveLength(0);
        expect(mocks.alert).not.toHaveBeenCalled();
    });

});
