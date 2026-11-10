import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { SkillFoundListResultV1Schema } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import { MACHINE_RPC_TIMEOUT_ERROR_CODE } from '@happier-dev/protocol/rpcErrors';
import { act, createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createSkillsSurfaceHarness } from '@/dev/testkit/harness/skillsSurfaceHarness';
import type { FoundMachineScan } from '@/sync/domains/skills/useFoundSkills';
import type { ReachMachine } from '@/sync/domains/capabilities/reach/useReachProjection';

vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
const transport = vi.hoisted(() => vi.fn<(input: unknown) => Promise<unknown>>());
// The daemon transport is the boundary; scans run through the real mounted Action owner.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () =>
    (await import('@/dev/testkit/mocks/serverScopedRpc')).createServerScopedMachineRpcBoundaryMock(transport));
installDisconnectedServerSocketBoundary();
const { SkillsFoundPage, SkillsFoundScreen } = await import('./SkillsFoundScreen');
const { saveFoundWarmCacheEntry } = await import('@/sync/domains/state/warmCachePersistence');
const { prepareWarmCacheEncryptionKey } = await import('@/sync/domains/state/warmCacheEncryptionKey');
const { resetPromptLibraryCatalogEngineForTests } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');
const { resetPromptLibraryCatalogSnapshotsForTests } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
afterEach(() => { standardCleanup(); resetPromptLibraryCatalogEngineForTests(); resetPromptLibraryCatalogSnapshotsForTests(); });

const result = SkillFoundListResultV1Schema.parse({ scannedAt: 123, roots: [], items: [
    ...['one', 'two', 'held', 'plugin', 'masked'].map(name => ({ name, description: null, path: `/skills/${name}`, digest: name,
        agents: ['codex'], scope: 'user', inLibrary: name === 'held' ? 'library-held' : null, masksLibrary: name === 'masked',
        happierInstalled: false, pluginOwned: name === 'plugin' ? { pluginName: 'review-kit' } : null })),
] });
const machine = (machineId: string, offline = false): ReachMachine => ({ machineId, name: machineId,
    platform: 'posix', agentIds: ['codex'], online: !offline, offline, lastSeenAt: offline ? 123 : null });

it('retains adopted content after a rules CAS refusal and offers rules-only recovery after rescan', async () => {
    const home = await createSkillsSurfaceHarness('https://skills-found-partial.test');
    const { createSkillInstallActionHarness } = await import('@/dev/testkit/harness/skillInstallActionHarness');
    const { createFoundSkillTransferFixture } = await import('@/dev/testkit/harness/promptMachineTransferBoundary');
    const { acknowledgeSkillActionResult, retrySkillInstallRules } = await import('../add/skillInstall');
    const fixtures = ['one', 'two'].map(name => createFoundSkillTransferFixture({ name, path: `/skills/${name}`, scope: 'user', agents: ['codex'],
        files: [{ path: 'SKILL.md', contentKind: 'utf8', contentBase64: Buffer.from(`---\nname: ${name}\n---\nHelp.`).toString('base64') }] }));
    const list = { ...fixtures[0]!.list, items: fixtures.flatMap(fixture => fixture.list.items) };
    let downloads = 0;
    const owner = createSkillInstallActionHarness({ readFoundSkillBundle: async (_machineId, path) => {
        downloads++; return fixtures.find(fixture => fixture.bundle.path === path)!.bundle;
    } });
    owner.setRulesUnavailable(true);
    let scan: FoundMachineScan = { machineId: 'nl2', result: list, scanning: false, failure: null };
    const props: React.ComponentProps<typeof SkillsFoundPage> = {
        machines: [machine('nl2')], scanOf: () => scan, canCheckAgain: true, checking: false, onCheckAgain() {},
        libraryIdByName: new Map(), libraryPending: false, agentNames: ids => ids, readBoth: async () => null,
        adopt: async (machineId, items) => {
            const result = await owner.execute('skills.found.adopt', { machineId, items: items.map(({ name, path }) => ({ name, path })) });
            return acknowledgeSkillActionResult('skills.found.adopt', result);
        },
        retryRules: receipt => retrySkillInstallRules(owner.execute, receipt),
        onScan: async () => { scan = { ...scan, result: { ...list,
            items: list.items.map((item, index) => ({ ...item, inLibrary: owner.artifacts.has(`skill-${index + 1}`) ? `skill-${index + 1}` : null })) } }; },
    };
    const screen = await renderScreen(<SkillsFoundPage {...props} />);
    try {
        await screen.pressByTestIdAsync('skills.found.action.nl2.one');
        await vi.waitFor(() => expect(owner.artifacts.size).toBe(1));
        await screen.update(<SkillsFoundPage {...props} scanOf={() => scan} />);
        const partialID = 'skills.found.partial.nl2';
        expect(screen.findByTestId(partialID)).not.toBeNull();
        // A second Add on this machine must retain the first outstanding rules receipt.
        await screen.pressByTestIdAsync('skills.found.action.nl2.two');
        await vi.waitFor(() => expect(owner.artifacts.size).toBe(2));
        await screen.update(<SkillsFoundPage {...props} scanOf={() => scan} />);
        const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
        const retry = () => screen.findAllByType(SurfaceStateCard).find(node => node.props.testID === partialID)!.props.action.onPress();
        await act(async () => { await retry(); });
        expect(screen.findByTestId(partialID)).not.toBeNull();
        owner.setRulesUnavailable(false);
        await act(async () => { await retry(); });
        expect(screen.findByTestId(partialID)).toBeNull();
        expect([...owner.artifacts.keys()]).toEqual(['skill-1', 'skill-2']);
        expect(downloads).toBe(2);
        expect(owner.rules().map(rule => rule.skillId)).toEqual(['skill-1', 'skill-2']);
    } finally { await screen.unmount(); await home.dispose(); }
});

it('bulk-adds only addable native rows, retains their positions while settling, and offers plugin copy and masked Compare', async () => {
    const home = await createSkillsSurfaceHarness('https://skills-found-page.test');
    try {
        const pending = createDeferred<Awaited<ReturnType<React.ComponentProps<typeof SkillsFoundPage>['adopt']>>>();
        const adopted: string[][] = [];
        const adopt: React.ComponentProps<typeof SkillsFoundPage>['adopt'] = async (_machineId, items) => {
            adopted.push(items.map(item => item.name)); return pending.promise;
        };
        let scan: FoundMachineScan = { machineId: 'nl2', result, scanning: false, failure: null };
        const onScan = async () => { scan = { ...scan, result: { ...result,
            items: result.items.map(item => item.name === 'one' || item.name === 'two' ? { ...item, inLibrary: `library-${item.name}` } : item) } }; };
        const props: React.ComponentProps<typeof SkillsFoundPage> = { machines: [machine('nl2')], scanOf: () => scan,
            canCheckAgain: true, checking: false, onCheckAgain: () => {}, libraryIdByName: new Map([['masked', 'library-masked']]),
            libraryPending: false, agentNames: ids => ids, onScan, adopt, retryRules: async receipt => receipt, readBoth: async () => null };
        const screen = await renderScreen(<SkillsFoundPage {...props} />);
        expect(screen.findByTestId('skills.found.action.nl2.plugin')).not.toBeNull();
        expect(screen.getTextContent()).toContain('Make a copy');
        expect(screen.findByTestId('skills.found.action.nl2.masked')).not.toBeNull();
        expect(screen.getTextContent()).toContain('Compare');
        const rows = () => screen.findAll(node => typeof node.type === 'string' && typeof node.props.testID === 'string'
            && node.props.testID.startsWith('skills.found.row.')).map(node => node.props.testID);
        const before = rows();
        expect(before).toHaveLength(5);
        await act(async () => screen.pressByTestId('skills.found.addAll.nl2'));
        expect(adopted).toEqual([['one', 'two']]);
        expect(screen.findByTestId('skills.found.action.nl2.one')?.props.disabled).toBe(true);
        await act(async () => pending.resolve({ ok: true, skillIds: ['library-one', 'library-two'], incomplete: [], rulesMissing: [] }));
        await screen.update(<SkillsFoundPage {...props} scanOf={() => scan} />);
        expect(rows()).toEqual(before);
        expect(screen.findByTestId('skills.found.addAll.nl2')).toBeNull();
        expect(screen.findByTestId('skills.found.action.nl2.one')?.findAll(node => node.children.includes('In your library'))).not.toHaveLength(0);
    } finally { await standardCleanup(); await home.dispose(); }
});

it('keeps last-known rows offline without automatic scans, but Check again reaches the machine and settles a failed request', async () => {
    const home = await createSkillsSurfaceHarness('https://skills-found-offline.test');
    try {
        transport.mockReset();
        transport.mockRejectedValue(Object.assign(new Error('RPC request timed out'), { code: MACHINE_RPC_TIMEOUT_ERROR_CODE }));
        const away = home.storage.getState().machines.away!;
        home.storage.getState().applyMachines([away], true, { sourceServerId: home.scope.serverId, sourceAccountId: home.scope.accountId });
        await prepareWarmCacheEncryptionKey();
        saveFoundWarmCacheEntry(home.scope.serverId, home.scope.accountId,
            { kind: 'skill', machineId: 'away', observedAt: result.scannedAt, result });
        const screen = await renderScreen(<SkillsFoundScreen />);
        await vi.waitFor(() => expect(screen.findByTestId('skills.found.row.away.one')).not.toBeNull());
        expect(screen.findByTestId('skills.found.offline.away')).not.toBeNull();
        expect(screen.findByTestId('skills.found.action.away.one')?.props.disabled).toBe(true);
        expect(screen.findByTestId('skills.found.addAll.away')).toBeNull();
        expect(screen.getTextContent()).toContain('Bring away online');
        expect(transport).not.toHaveBeenCalled();
        expect(screen.findByTestId('skills.found.checkAgain')).not.toBeNull();
        await screen.pressByTestIdAsync('skills.found.checkAgain');
        await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce());
        expect(transport.mock.calls[0]![0]).toMatchObject({ machineId: 'away' });
        await vi.waitFor(() => expect(screen.findByTestId('skills.found.checkAgain')?.props.accessibilityState?.busy).toBe(false));
        expect(screen.findByTestId('skills.found.row.away.one')).not.toBeNull();
    } finally { await standardCleanup(); await home.dispose(); }
});

it('names machines with nothing to show once each as a count, keeping the sections of machines with something to say', async () => {
    const emptyResult = SkillFoundListResultV1Schema.parse({ scannedAt: 123, roots: [], items: [] });
    const scans: Record<string, FoundMachineScan> = {
        busy: { machineId: 'busy', result, scanning: false, failure: null },
        'empty-1': { machineId: 'empty-1', result: emptyResult, scanning: false, failure: null },
        'empty-2': { machineId: 'empty-2', result: emptyResult, scanning: false, failure: null },
        reading: { machineId: 'reading', result: null, scanning: true, failure: null },
    };
    const props: React.ComponentProps<typeof SkillsFoundPage> = {
        machines: Object.keys(scans).map(id => machine(id)), scanOf: m => scans[m.machineId]!,
        canCheckAgain: true, checking: false, onCheckAgain() {}, libraryIdByName: new Map(), libraryPending: false,
        agentNames: ids => ids, onScan: async () => {}, adopt: async () => null, retryRules: async receipt => receipt, readBoth: async () => null,
    };
    const screen = await renderScreen(<SkillsFoundPage {...props} />);
    try {
        expect(screen.findByTestId('skills.found.machine.busy')).not.toBeNull();
        for (const id of ['empty-1', 'empty-2', 'reading']) expect(screen.findByTestId(`skills.found.machine.${id}`)).toBeNull();
        expect(screen.findByTestId('skills.found.quiet.empty')).not.toBeNull();
        expect(screen.findByTestId('skills.found.quiet.looking')).not.toBeNull();
        expect(screen.getTextContent()).toContain('No skills found on 2 other machines');
        expect(screen.getTextContent()).toContain('Looking on 1 machine');
    } finally { await screen.unmount(); }
});
