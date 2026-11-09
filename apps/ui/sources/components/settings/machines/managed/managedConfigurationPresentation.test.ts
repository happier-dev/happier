import { describe, expect, it } from 'vitest';
import { buildManagedConfigurationReceipt, describeManagedConfigurationSummary } from './managedConfigurationPresentation';
import { ValidatedLaunchSnapshotV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { presentQualifiedConnectedAccountTarget } from '@/sync/domains/connectedServices/qualifiedConnectedAccountTargetPresentation';
import { t } from '@/text';
import { presentManagedCost } from './managedMachineDisplay';
import { describeRetention, formatRetentionDuration } from './managedRetentionPresentation';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { describeApprovalActionFields } from '@happier-dev/protocol/actions/actionApprovalPresentation';

const launch = { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Original guest', choices: { cpu: 2 } };
const reviewedFacts = { launch: { ...launch, name: 'Unrelated later name' }, controller: { machineId: 'original-host', installationId: 'installation' },
    optionStatus: 'current' as const, prerequisites: [], billing: { location: 'cloud' as const, stoppedBilling: 'billed' as const },
    retentionCapabilities: { supportedIntents: ['delete' as const] }, retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false,
    prices: [{ amount: '0.0119', currency: 'EUR', unit: 'hour', source: 'native', observedAt: 10 }] };
describe('the phone summary of a configuration', () => {
    const nativeFacts = { size: { id: 'cx32', title: 'CX32', cpuCores: 4 }, image: { id: 'ubuntu', title: 'Ubuntu 24.04' },
        location: { id: 'fsn1', title: 'Falkenstein', countryCode: 'DE' } };
    it('says the size, the place and what Keep it does, from the same facts as the receipt (lab m-config Ap)', () => {
        expect(describeManagedConfigurationSummary({ ...reviewedFacts, nativeFacts })).toBe(
            ['CX32', 'Falkenstein', t('managedRetention.untilDelete')].join(' · '));
    });
    it('names the system instead of the place for a local machine, and the Keep rule the person chose', () => {
        const retention = { kind: 'unused' as const, afterMs: 3_600_000, effect: 'stop' as const };
        const summary = describeManagedConfigurationSummary({ ...reviewedFacts, nativeFacts, retention,
            billing: { location: 'local' as const, stoppedBilling: 'not-billed' as const } });
        expect(summary).toBe(['CX32', 'Ubuntu 24.04', describeRetention(retention)].join(' · '));
    });
    it('says nothing of its own when the provider returned no native dimensions', () => {
        expect(describeManagedConfigurationSummary(reviewedFacts)).toBeNull();
    });
});
describe('one managed configuration receipt projection', () => {
    it('shares the approval cost, idle duration and readable size with the configurator receipt', () => {
        const retention = { kind: 'unused' as const, afterMs: 3_600_000, effect: 'stop' as const };
        const nativeFacts = { size: { id: '4/4/100', title: 'Custom size', cpuCores: 4,
            memoryBytes: 4 * 1024 ** 3, diskBytes: 100 * 1024 ** 3 }, image: { id: 'ubuntu', title: 'Ubuntu 26.04' } };
        const facts = { ...reviewedFacts, launch, prices: [], retention, nativeFacts,
            billing: { location: 'local' as const, stoppedBilling: 'not-billed' as const } };
        const receipt = buildManagedConfigurationReceipt({ launch, reviewedFacts: facts, providerTitle: 'Lima' });
        const spec = getActionSpec('machines.managed.acquire');
        const review = describeApprovalActionFields({ actionId: spec.id, actionArgs: {
            selection: { kind: 'one-off', homeId: 'home', launch, retention, wakeOnAcceptedMessage: false },
            enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' }, reviewedFacts: facts,
        } });
        expect(review.unrepresentable).toBeNull();
        expect(review.rows).toContainEqual(expect.objectContaining({ path: 'price', value: presentManagedCost(receipt.cost!).value }));
        expect(review.rows).toContainEqual(expect.objectContaining({ path: 'lifetime', value: describeRetention(retention) }));
        const native = review.rows.find(row => row.path === 'nativeFacts');
        expect(native?.kind === 'value' ? native.value : '').toContain(receipt.spec);
        expect(native?.kind === 'value' ? native.value : '').toContain(receipt.facts.find(fact => fact.id === 'image')!.value);
    });

    it('keeps a preset\'s last saved size and image, labelled as last saved, when its current facts cannot be read (VD D6)', () => {
        const lastSaved = { size: { id: 'medium', title: 'Original guest', cpuCores: 2, memoryBytes: 2 * 1024 ** 3 },
            image: { id: 'ubuntu', title: 'Ubuntu' }, location: { id: 'fsn1', title: 'Falkenstein' } };
        const degraded = buildManagedConfigurationReceipt({ launch, providerTitle: 'Lima', lastSaved });
        // Never current state: the line says the facts are the last saved ones, size and image only.
        expect(degraded.spec).toBe(t('managedMachines.receipt.lastSaved', {
            facts: `${t('managedMachines.receipt.cores', { count: 2 }).replace(/ /g, '\u00a0')} · 2\u00a0GiB · Ubuntu` }));
        expect(degraded.facts.some(fact => fact.id === 'location')).toBe(false);
        // Current facts win: a readable receipt never shows the last saved line.
        const current = buildManagedConfigurationReceipt({ launch, providerTitle: 'Lima', lastSaved,
            reviewedFacts: { ...reviewedFacts, nativeFacts: { image: { id: 'debian', title: 'Debian' } } } });
        expect(current.spec).toBe('Debian');
        // Nothing saved: no invented line, the provider stays the spec.
        expect(buildManagedConfigurationReceipt({ launch, providerTitle: 'Lima' }).spec).toBe('Lima');
    });
    it.each(['Lima', 'Lume', 'Cloud compute'])('keeps %s receipt sizes in the GiB used by the launch form', providerTitle => {
        const receipt = buildManagedConfigurationReceipt({ launch, providerTitle, reviewedFacts: { ...reviewedFacts,
            nativeFacts: { size: { id: 'custom', title: 'Custom size', cpuCores: 4,
                memoryBytes: 4 * 1024 ** 3, diskBytes: 100 * 1024 ** 3 } } } });
        expect(receipt.spec).toBe(`Custom size · ${t('managedMachines.receipt.cores', { count: 4 }).replace(/ /g, '\u00a0')} · 4\u00a0GiB · 100\u00a0GiB`);
    });
    it.each([
        [{ kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user', role: 'server', adminAccessAtCreation: 'ask',
            administrator: { username: 'leeroy' } } as const, 'happier', t('managedMachines.identity.ask')],
        [{ kind: 'existingUser', role: 'personal' } as const, t('managedMachines.identity.receiptYourAccount'), undefined],
        [{ kind: 'guestProcess', role: 'sandbox' } as const, t('managedMachines.identity.receiptSandbox'), undefined],
    ])('says who Happier runs as for a %o identity, and administrator access only where it applies', (enrollmentIdentity, runsAs, administrator) => {
        const receipt = buildManagedConfigurationReceipt({ launch, providerTitle: 'Compute', reviewedFacts, enrollmentIdentity });
        expect(receipt.facts.find(fact => fact.id === 'runs-as')?.value).toBe(runsAs);
        expect(receipt.facts.find(fact => fact.id === 'administrator')?.value).toBe(administrator);
    });
    it('never puts provider storage prose in a receipt value: the stopped cost is said once, by Keep it (R6)', () => {
        const charges = [{ ...reviewedFacts.prices[0]!, label: { key: 'price.snapshots', fallback: 'Snapshot storage (Pro / Enterprise)' } },
            { amount: '0.04', currency: 'USD', unit: 'GiB-month', source: 'volume', observedAt: 20 }];
        const reviewed = buildManagedConfigurationReceipt({ launch, providerTitle: 'Compute', reviewedFacts: { ...reviewedFacts,
            billing: { ...reviewedFacts.billing, stoppedBilling: 'not-billed', storageCharges: charges } } });
        const declared = buildManagedConfigurationReceipt({ launch, providerTitle: 'Compute',
            declaredBilling: { location: 'cloud', stoppedBilling: 'not-billed', storageCharges: charges } });
        for (const receipt of [reviewed, declared]) {
            expect(receipt.facts.some(fact => fact.id === 'stopped-storage')).toBe(false);
            expect(JSON.stringify(receipt.facts)).not.toContain('Snapshot storage');
        }
        expect(declared.cost).toEqual({ kind: 'unpriced', provider: 'Compute' });
    });
    it('discloses each retained credential purpose and captured controller with explicit unavailable Account names and no opaque IDs', () => {
        const selected = ValidatedLaunchSnapshotV1Schema.parse({ ...launch, credentials: [
            { purpose: { consumer: launch.provider, purpose: 'provision' }, account: { service: { pluginId: 'custom.accounts', localId: 'compute' }, accountId: 'opaque-work-id' } },
            { purpose: { consumer: launch.provider, purpose: 'gateway' }, account: { service: { pluginId: 'custom.accounts', localId: 'gateway' }, accountId: 'opaque-personal-id' } },
        ] });
        const receipt = buildManagedConfigurationReceipt({ launch: selected, reviewedFacts: { ...reviewedFacts, launch: selected }, providerTitle: 'Compute' });
        const accounts = receipt.facts.filter(fact => fact.id.startsWith('credential:'));
        expect(accounts).toHaveLength(2);
        expect(accounts[0]?.label).toContain('provision');
        expect(accounts[1]?.label).toContain('gateway');
        const unavailable = presentQualifiedConnectedAccountTarget({ target: { kind: 'account', account: selected.credentials![0]!.account },
            accounts: [], groups: [], labelsByKey: {}, serviceTitle: null }).primaryLabel;
        expect(accounts.map(fact => fact.value)).toEqual([unavailable, unavailable]);
        expect(receipt.facts.find(fact => fact.id === 'controller')?.value).toBe(t('common.unknown'));
        expect(JSON.stringify(receipt)).not.toContain('original-host');
        expect(JSON.stringify(receipt)).not.toContain('opaque-work-id');
        expect(JSON.stringify(receipt)).not.toContain('opaque-personal-id');
    });
    it('keeps a native no-cap fact distinct from a published monthly rate and keeps omitted cap status unknown', () => {
        const known = buildManagedConfigurationReceipt({ launch, providerTitle: 'Compute', reviewedFacts: { ...reviewedFacts,
            nativeFacts: { monthlyCapStatus: 'none' } } });
        expect(known.facts.find(fact => fact.id === 'monthly-cap')).toBeDefined();
        const unknown = buildManagedConfigurationReceipt({ launch, providerTitle: 'Compute', reviewedFacts });
        expect(unknown.facts.find(fact => fact.id === 'monthly-cap')).toBeUndefined();
    });
    it('discloses the captured monthly price alongside the hourly price without guessing a conversion', () => {
        const monthlyPrice = { amount: '3.75', currency: 'EUR', unit: 'month', source: 'native-api', observedAt: 20 };
        const prices = [...reviewedFacts.prices, monthlyPrice];
        expect(buildManagedConfigurationReceipt({ launch, providerTitle: 'Compute', reviewedFacts: { ...reviewedFacts, prices } }).cost)
            .toEqual({ kind: 'price', provider: 'Compute', prices });
    });
    it('projects every selected native compute and attachment charge from the immutable receipt', () => {
        const prices = [
            { ...reviewedFacts.prices[0]!, label: { key: 'price.compute', fallback: 'Compute' } },
            { amount: '0.0008', currency: 'EUR', unit: 'hour', source: 'native-network', observedAt: 20, label: 'Primary IPv4' },
            { amount: '0.50', currency: 'EUR', unit: 'month', source: 'native-network', observedAt: 20, label: 'Primary IPv4' },
            { amount: '0.04', currency: 'USD', unit: 'GiB-month', source: 'native-storage', observedAt: 30, label: 'Volume' },
        ];
        const captured = { ...reviewedFacts, prices };
        const receipt = buildManagedConfigurationReceipt({ launch, providerTitle: 'Compute', reviewedFacts: captured,
            localized: (pluginId, value) => typeof value === 'string' ? value
                : pluginId === launch.provider.pluginId && value.key === 'price.compute' ? 'Localized compute' : value.fallback });
        expect(receipt.cost).toEqual({ kind: 'price', provider: 'Compute', prices: [{ ...prices[0], label: 'Localized compute' }, ...prices.slice(1)] });
    });
    it('discloses selected labelled native dimensions from captured facts without exposing or guessing launch selectors', () => {
        const receipt = buildManagedConfigurationReceipt({ launch, providerTitle: 'Compute', reviewedFacts: { ...reviewedFacts,
            nativeFacts: { size: { id: 'small', title: 'Small', cpuCores: 2 }, image: { id: 'linux', title: 'Linux' }, location: { id: 'west', title: 'West' },
                duration: { id: 'long', title: '2 hours', afterMs: 7_200_000 } } },
            localized: (_pluginId, value) => typeof value === 'string' ? value : value.fallback });
        // A cloud receipt names the place before the image; the size and its dimensions are the spec line.
        expect(receipt.facts.filter(fact => ['size', 'image', 'location', 'duration'].includes(fact.id)).map(fact => fact.value)).toEqual(['West', 'Linux', formatRetentionDuration(7_200_000)]);
        expect(receipt.spec).toBe(`Small · ${t('managedMachines.receipt.cores', { count: 2 }).replace(/ /g, '\u00a0')}`);
    });
    it('does not repeat the machine name when a local size is titled with it (UIR5c)', () => {
        const receipt = buildManagedConfigurationReceipt({ launch, providerTitle: 'Compute', reviewedFacts: { ...reviewedFacts,
            nativeFacts: { size: { id: 'own', title: launch.name, cpuCores: 2 } } },
            localized: (_pluginId, value) => typeof value === 'string' ? value : value.fallback });
        expect(receipt.spec).toBe(t('managedMachines.receipt.cores', { count: 2 }).replace(/ /g, '\u00a0'));
    });
    it('keeps captured launch identity and exact price provenance independent from later live choices', () => {
        const receipt = buildManagedConfigurationReceipt({ launch, reviewedFacts, providerTitle: 'Compute', controllerName: 'Captured controller' });
        expect(receipt.name).toBe('Original guest');
        expect(receipt.cost).toEqual({ kind: 'price', provider: 'Compute', prices: reviewedFacts.prices });
        expect(receipt.primary).toBeUndefined();
        expect(receipt.keep).toBeUndefined();
        expect(receipt.facts.some(fact => fact.value === 'Captured controller')).toBe(true);
    });
    it('shows unknown price when there are no captured billing facts', () => {
        // Without any billing fact (the provisioner could not be read) the receipt cannot say who bills it:
        // a local VM is never "billed directly by" its provider, so the line names no one.
        expect(buildManagedConfigurationReceipt({ launch, providerTitle: 'Lima' }).cost)
            .toEqual({ kind: 'unpriced', provider: null });
        expect(buildManagedConfigurationReceipt({ launch, providerTitle: 'Compute', reviewedFacts: { ...reviewedFacts, prices: [] } }).cost)
            .toEqual({ kind: 'unpriced', provider: 'Compute' });
        expect(buildManagedConfigurationReceipt({ launch, providerTitle: 'Local VM', controllerName: 'Build Mac',
            declaredBilling: { location: 'local', stoppedBilling: 'not-billed' } }).cost)
            .toEqual({ kind: 'local', computer: 'Build Mac', meters: [], note: t('managedMachines.receipt.headroomUnknown', { computer: 'Build Mac' }) });
    });
    it('keeps unknown billing explicit without inventing a service name', () => {
        const receipt = buildManagedConfigurationReceipt({ launch, providerTitle: null });
        expect(receipt.spec).toBe('');
        expect(receipt.cost).toEqual({ kind: 'unpriced', provider: null });
        const captured = buildManagedConfigurationReceipt({ launch, providerTitle: null, reviewedFacts: { ...reviewedFacts,
            retentionCapabilities: { ...reviewedFacts.retentionCapabilities, nativeExpiry: { kind: 'unused', afterMs: 60_000 } } } });
        expect(captured.cost).toEqual({ kind: 'price', provider: null, prices: reviewedFacts.prices });
        expect(captured.facts.find(fact => fact.id === 'native-expiry')?.value).toBe(t('managedRetention.nativeExpiry', {
            provider: null, time: t('managedRetention.minutes', { count: 1 }),
        }));
    });
    it('shares captured Home, preset revision and optional inherited selection without inventing a concrete policy', () => {
        const receipt = buildManagedConfigurationReceipt({ launch, providerTitle: 'Compute', homeName: 'Build Home',
            preset: { id: 'launch', revision: 3, name: 'Guest launch' }, presetPolicy: { wakeOnAcceptedMessage: true } });
        expect(receipt.facts.find(fact => fact.id === 'home')?.value).toBe('Build Home');
        expect(receipt.facts.find(fact => fact.id === 'preset')?.value).toContain('3');
        expect(receipt.facts.find(fact => fact.id === 'retention')?.value).toBe('Defaults');
        expect(receipt.facts.find(fact => fact.id === 'wake')?.value).toBe('wake on');
        expect(receipt.keep).toBeUndefined();
    });
    const localFacts = { ...reviewedFacts, prices: [], billing: { location: 'local' as const, stoppedBilling: 'not-billed' as const },
        nativeFacts: { size: { id: 'medium', title: 'Medium', cpuCores: 6, memoryBytes: 16 * 2 ** 30, diskBytes: 128 * 2 ** 30 },
            image: { id: 'tahoe', title: 'macOS Tahoe' } } };
    it('meters a local size against what its computer reported free, and says what it leaves (RV-C F13)', () => {
        const receipt = buildManagedConfigurationReceipt({ launch, providerTitle: 'Lume', controllerName: 'MacBook Pro', reviewedFacts: { ...localFacts,
            localResources: { observedAt: 5, availableCpuCores: 12, availableMemoryBytes: 36 * 2 ** 30 } } });
        expect(receipt.spec).toBe(`Medium · ${t('managedMachines.receipt.cores', { count: 6 }).replace(/ /g, '\u00a0')} · 16\u00a0GiB · 128\u00a0GiB`);
        // A local VM names what it runs before where it is.
        expect(receipt.facts[0]).toMatchObject({ id: 'image', value: 'macOS Tahoe' });
        expect(receipt.cost).toEqual({ kind: 'local', computer: 'MacBook Pro', meters: [
            { id: 'cpu', label: t('managedMachines.config.columns.cpu'), fraction: 0.5,
                value: t('managedMachines.receipt.coresOfFree', { count: 6, free: '12' }) },
            { id: 'memory', label: t('managedMachines.config.columns.memory'), fraction: 16 / 36,
                value: t('managedMachines.receipt.amountOfFree', { amount: '16 GiB', free: '36 GiB' }) },
        ], note: t('managedMachines.receipt.leavesBoth', { cores: t('managedMachines.receipt.cores', { count: 6 }), memory: '20 GiB', computer: 'MacBook Pro' }) });
    });
    it('never draws an invented share: unmeasured headroom is unknown and an oversized choice says it does not fit', () => {
        const unmeasured = buildManagedConfigurationReceipt({ launch, providerTitle: 'Lume', controllerName: 'MacBook Pro', reviewedFacts: localFacts });
        expect(unmeasured.cost).toEqual({ kind: 'local', computer: 'MacBook Pro', meters: [],
            note: t('managedMachines.receipt.headroomUnknown', { computer: 'MacBook Pro' }) });
        const oversized = buildManagedConfigurationReceipt({ launch, providerTitle: 'Lume', controllerName: 'MacBook Pro', reviewedFacts: { ...localFacts,
            localResources: { observedAt: 5, availableCpuCores: 4 } } });
        expect(oversized.cost).toMatchObject({ kind: 'local', meters: [expect.objectContaining({ id: 'cpu', fraction: 1 })],
            note: t('managedMachines.receipt.exceedsFree', { computer: 'MacBook Pro' }) });
    });
    it('describes a created machine by what it was made from, without a creation-time policy beside its live one', () => {
        const receipt = buildManagedConfigurationReceipt({ launch, providerTitle: 'Compute', created: true, reviewedFacts: { ...reviewedFacts,
            billing: { location: 'local', stoppedBilling: 'not-billed' }, prices: [],
            localResources: { observedAt: 5, availableCpuCores: 12 }, retentionCapabilities: { supportedIntents: ['stop'], nativeExpiry: { kind: 'unused', afterMs: 60_000 } },
            preset: { id: 'launch', revision: 3, name: 'Build box' } } });
        expect(receipt.caption).toBe(t('machinePresets.fromRevision', { name: 'Build box', revision: 3 }));
        expect(receipt.facts.map(fact => fact.id)).not.toEqual(expect.arrayContaining(['preset']));
        expect(receipt.facts.map(fact => fact.id).filter(id => ['retention', 'native-expiry', 'wake', 'preset'].includes(id))).toEqual([]);
        // Creation-time headroom no longer describes the host.
        // A sentence never says "Runs on Unknown": an unnamed controller is the computer that manages it.
        expect(receipt.cost).toEqual({ kind: 'local', computer: t('managedMachines.receipt.managingComputer'), meters: [] });
    });
    it('names a pool-backed controller as the pool and checks no single machine\'s headroom', () => {
        const sentence = t('machinePresets.controllerPoolIn', { pool: 'Build servers' });
        const receipt = buildManagedConfigurationReceipt({ launch, providerTitle: 'Docker', reviewedFacts: localFacts,
            controllerName: 'Build servers', pooledController: { sentenceName: sentence } });
        expect(receipt.facts.find(fact => fact.id === 'controller')?.value).toBe('Build servers');
        expect(receipt.cost).toEqual({ kind: 'local', computer: sentence, meters: [] });
    });
    it('keeps "Unknown" out of a requester\'s sentences when the controller has no name it can read (VD G2)', () => {
        const receipt = buildManagedConfigurationReceipt({ launch, providerTitle: 'Lima', reviewedFacts: localFacts });
        const computer = t('managedMachines.receipt.managingComputer');
        expect(receipt.cost).toEqual({ kind: 'local', computer, meters: [], note: t('managedMachines.receipt.headroomUnknown', { computer }) });
        // The labelled fact stays explicit; only sentences use the neutral phrase.
        expect(receipt.facts.find(fact => fact.id === 'controller')?.value).toBe(t('common.unknown'));
    });
    it('names the preset in its receipt row by name and revision alone, beside the "Made from" label', () => {
        const receipt = buildManagedConfigurationReceipt({ launch, providerTitle: 'Compute', reviewedFacts: { ...reviewedFacts,
            preset: { id: 'launch', revision: 3, name: 'Build box' } } });
        expect(receipt.facts.find(fact => fact.id === 'preset')).toMatchObject({ label: t('machinePresets.madeFrom'),
            value: t('machinePresets.nameRevision', { name: 'Build box', revision: 3 }) });
        expect(receipt.facts.find(fact => fact.id === 'preset')?.value).toBe('Build box · revision 3');
    });
    it('keeps the captured native duration unless the created detail already presents its live lifetime', () => {
        const facts = { ...reviewedFacts, nativeFacts: { duration: { id: 'native-duration', title: '2 hours', afterMs: 7_200_000 } } };
        const input = { launch, providerTitle: 'Compute', reviewedFacts: facts };
        expect(buildManagedConfigurationReceipt({ ...input, nativeLifetimePresented: true }).facts.find(fact => fact.id === 'duration')?.value).toBe(formatRetentionDuration(7_200_000));
        expect(buildManagedConfigurationReceipt({ ...input, created: true }).facts.find(fact => fact.id === 'duration')?.value).toBe(formatRetentionDuration(7_200_000));
        expect(buildManagedConfigurationReceipt({ ...input, created: true, nativeLifetimePresented: true }).facts.some(fact => fact.id === 'duration')).toBe(false);
        expect(facts.nativeFacts.duration.afterMs).toBe(7_200_000);
    });
});
describe('an Account-created machine\'s receipt (58d U4, lab af-config K)', () => {
    const run = { id: '86400000', title: '86400 s', afterMs: 86_400_000 };
    const facts = { ...reviewedFacts, controller: undefined, nativeFacts: { duration: run },
        retentionCapabilities: { supportedIntents: ['start' as const, 'stop' as const, 'delete' as const] } };
    it('names no managing computer, says who agents sign in as, and the provider\'s longest run after where it joins', () => {
        const receipt = buildManagedConfigurationReceipt({ launch, reviewedFacts: facts, providerTitle: 'Vercel', managedBy: 'account',
            keepEditedBelow: true, homeName: 'Personal Home', agentSignIn: [{ agent: 'Claude', account: 'leeroy@hey.com' }] });
        expect(receipt.facts.some(fact => fact.id === 'controller')).toBe(false);
        expect(receipt.facts.find(fact => fact.id === 'agents')).toMatchObject({ label: t('managedMachines.receipt.agentsSignInAs'), value: 'leeroy@hey.com' });
        expect(receipt.facts.find(fact => fact.id === 'duration')).toMatchObject({ label: t('managedMachines.receipt.longestRun'),
            value: formatRetentionDuration(run.afterMs) });
        expect(receipt.facts.map(fact => fact.id)).toEqual(['agents', 'home', 'duration']);
    });
    it('names each agent beside its account when they sign in differently, and nothing when none is signed in', () => {
        const both = buildManagedConfigurationReceipt({ launch, reviewedFacts: facts, providerTitle: 'Vercel', managedBy: 'account',
            agentSignIn: [{ agent: 'Claude', account: 'leeroy@hey.com' }, { agent: 'Codex', account: 'work@hey.com' }] });
        expect(both.facts.find(fact => fact.id === 'agents')?.value).toBe('Claude · leeroy@hey.com, Codex · work@hey.com');
        const reading = buildManagedConfigurationReceipt({ launch, reviewedFacts: facts, providerTitle: 'Vercel', managedBy: 'account',
            agentSignIn: [{ agent: 'Claude', account: null }] });
        expect(reading.facts.find(fact => fact.id === 'agents')?.value).toBeNull();
        const none = buildManagedConfigurationReceipt({ launch, reviewedFacts: facts, providerTitle: 'Vercel', managedBy: 'account', agentSignIn: [] });
        expect(none.facts.some(fact => fact.id === 'agents')).toBe(false);
    });
    it('keeps Ends, not Longest run, for a resource that ends instead of stopping', () => {
        const finite = { ...facts, retentionCapabilities: { ...facts.retentionCapabilities, finiteOnly: true } };
        const receipt = buildManagedConfigurationReceipt({ launch, reviewedFacts: finite, providerTitle: 'Modal', managedBy: 'account' });
        expect(receipt.facts.find(fact => fact.id === 'duration')).toMatchObject({ label: t('managedRetention.ends'), value: run.title });
    });
});
