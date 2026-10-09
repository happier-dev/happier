import { describe, expect, it } from 'vitest';
import { buildManagedConfigurationReceipt } from './managedConfigurationPresentation';
import { ValidatedLaunchSnapshotV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { presentQualifiedConnectedAccountTarget } from '@/sync/domains/connectedServices/qualifiedConnectedAccountTargetPresentation';
import { t } from '@/text';

const launch = { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Original guest', choices: { cpu: 2 } };
const reviewedFacts = { launch: { ...launch, name: 'Unrelated later name' }, controller: { machineId: 'original-host', installationId: 'installation' },
    optionStatus: 'current' as const, prerequisites: [], billing: { location: 'cloud' as const, stoppedBilling: 'billed' as const },
    retentionCapabilities: { supportedIntents: ['delete' as const] }, retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false,
    prices: [{ amount: '0.0119', currency: 'EUR', unit: 'hour', source: 'native', observedAt: 10 }] };
describe('one managed configuration receipt projection', () => {
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
        expect(receipt.facts.filter(fact => ['size', 'image', 'location', 'duration'].includes(fact.id)).map(fact => fact.value)).toEqual(['Small', 'Linux', 'West', '2 hours']);
        expect(receipt.spec).toBe('Small · Linux · West · 2 hours');
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
            .toEqual({ kind: 'local', computer: 'Build Mac', meters: [] });
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
});
