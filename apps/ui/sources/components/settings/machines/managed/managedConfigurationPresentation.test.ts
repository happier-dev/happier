import { describe, expect, it } from 'vitest';
import { buildManagedConfigurationReceipt } from './managedConfigurationPresentation';
import { ValidatedLaunchSnapshotV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { presentQualifiedConnectedAccountTarget } from '@/sync/domains/connectedServices/qualifiedConnectedAccountTargetPresentation';
import { t } from '@/text';
import { formatProviderAmount, formatPriceUnit } from './managedMachineDisplay';

const launch = { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Original guest', choices: { cpu: 2 } };
const reviewedFacts = { launch: { ...launch, name: 'Unrelated later name' }, controller: { machineId: 'original-host', installationId: 'installation' },
    optionStatus: 'current' as const, prerequisites: [], billing: { location: 'cloud' as const, stoppedBilling: 'billed' as const },
    retentionCapabilities: { supportedIntents: ['delete' as const] }, retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false,
    prices: [{ amount: '0.0119', currency: 'EUR', unit: 'hour', source: 'native', observedAt: 10 }] };
describe('one managed configuration receipt projection', () => {
    it('formats stopped compute and attachment charges through the same native price presenter', () => {
        const charges = [reviewedFacts.prices[0]!, { amount: '0.04', currency: 'USD', unit: 'GiB-month', source: 'volume', observedAt: 20 }];
        const receipt = buildManagedConfigurationReceipt({ launch, providerTitle: 'Compute', reviewedFacts: { ...reviewedFacts,
            billing: { ...reviewedFacts.billing, storageCharges: charges } } });
        expect(receipt.facts.find(fact => fact.id === 'stopped-storage')?.value).toBe(t('managedMachines.billing.stopped', {
            charges: charges.map(price => `${formatProviderAmount(price)} ${formatPriceUnit(price.unit)}`).join(' · '),
        }));
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
            .toEqual({ kind: 'price', prices });
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
        expect(receipt.cost).toEqual({ kind: 'price', prices: [{ ...prices[0], label: 'Localized compute' }, ...prices.slice(1)] });
    });
    it('discloses selected labelled native dimensions from captured facts without exposing or guessing launch selectors', () => {
        const receipt = buildManagedConfigurationReceipt({ launch, providerTitle: 'Compute', reviewedFacts: { ...reviewedFacts,
            nativeFacts: { size: { id: 'small', title: 'Small', cpuCores: 2 }, image: { id: 'linux', title: 'Linux' }, location: { id: 'west', title: 'West' },
                duration: { id: 'long', title: '2 hours', afterMs: 7_200_000 } } },
            localized: (_pluginId, value) => typeof value === 'string' ? value : value.fallback });
        // A cloud receipt names the place before the image; the size and its dimensions are the spec line.
        expect(receipt.facts.filter(fact => ['size', 'image', 'location', 'duration'].includes(fact.id)).map(fact => fact.value)).toEqual(['West', 'Linux', '2 hours']);
        expect(receipt.spec).toBe(`Small · ${t('managedMachines.receipt.cores', { count: 2 })}`);
    });
    it('keeps captured launch identity and exact price provenance independent from later live choices', () => {
        const receipt = buildManagedConfigurationReceipt({ launch, reviewedFacts, providerTitle: 'Compute', controllerName: 'Captured controller' });
        expect(receipt.name).toBe('Original guest');
        expect(receipt.cost).toEqual({ kind: 'price', prices: reviewedFacts.prices });
        expect(receipt.primary).toBeUndefined();
        expect(receipt.keep).toBeUndefined();
        expect(receipt.facts.some(fact => fact.value === 'Captured controller')).toBe(true);
    });
    it('shows unknown price when there are no captured billing facts', () => {
        expect(buildManagedConfigurationReceipt({ launch, providerTitle: 'Compute' }).cost)
            .toEqual({ kind: 'unpriced', provider: 'Compute' });
        expect(buildManagedConfigurationReceipt({ launch, providerTitle: 'Compute', reviewedFacts: { ...reviewedFacts, prices: [] } }).cost)
            .toEqual({ kind: 'unpriced', provider: 'Compute' });
        expect(buildManagedConfigurationReceipt({ launch, providerTitle: 'Local VM', controllerName: 'Build Mac',
            declaredBilling: { location: 'local', stoppedBilling: 'not-billed' } }).cost)
            .toEqual({ kind: 'local', computer: 'Build Mac', meters: [], note: t('managedMachines.receipt.headroomUnknown', { computer: 'Build Mac' }) });
    });
    it('shares captured Home, preset revision and optional inherited selection without inventing a concrete policy', () => {
        const receipt = buildManagedConfigurationReceipt({ launch, providerTitle: 'Compute', homeName: 'Build Home',
            preset: { id: 'recipe', revision: 3, name: 'Guest recipe' }, presetPolicy: { wakeOnAcceptedMessage: true } });
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
        expect(receipt.spec).toBe(`Medium · ${t('managedMachines.receipt.cores', { count: 6 })} · 16 GB · 128 GB`);
        // A local VM names what it runs before where it is.
        expect(receipt.facts[0]).toMatchObject({ id: 'image', value: 'macOS Tahoe' });
        expect(receipt.cost).toEqual({ kind: 'local', computer: 'MacBook Pro', meters: [
            { id: 'cpu', label: t('managedMachines.config.columns.cpu'), fraction: 0.5,
                value: t('managedMachines.receipt.coresOfFree', { count: 6, free: '12' }) },
            { id: 'memory', label: t('managedMachines.config.columns.memory'), fraction: 16 / 36,
                value: t('managedMachines.receipt.amountOfFree', { amount: '16 GB', free: '36 GB' }) },
        ], note: t('managedMachines.receipt.leavesBoth', { cores: t('managedMachines.receipt.cores', { count: 6 }), memory: '20 GB', computer: 'MacBook Pro' }) });
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
            preset: { id: 'recipe', revision: 3, name: 'Build box' } } });
        expect(receipt.caption).toBe(t('machinePresets.fromRevision', { name: 'Build box', revision: 3 }));
        expect(receipt.facts.map(fact => fact.id)).not.toEqual(expect.arrayContaining(['preset']));
        expect(receipt.facts.map(fact => fact.id).filter(id => ['retention', 'native-expiry', 'wake', 'preset'].includes(id))).toEqual([]);
        // Creation-time headroom no longer describes the host.
        expect(receipt.cost).toEqual({ kind: 'local', computer: t('common.unknown'), meters: [] });
    });
});
