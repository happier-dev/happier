import { describe, expect, it } from 'vitest';
import { buildManagedConfigurationReceipt, describeManagedConfigurationSummary, describeManagedPresetOffer, formatManagedSizeBytes, describeLocalHeadroom, managedCredentialReceiptTargets, presentManagedPresetCost } from './managedConfigurationPresentation';
import { ValidatedLaunchSnapshotV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { presentQualifiedConnectedAccountTarget } from '@/sync/domains/connectedServices/qualifiedConnectedAccountTargetPresentation';
import { t } from '@/text';
import { formatPriceSource, presentManagedCost } from './managedMachineDisplay';
import { describeRetention, describeRetentionPolicy, formatRetentionDuration } from './managedRetentionPresentation';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { describeApprovalActionFields } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { InputHintsSchema } from '@happier-dev/protocol/inputs/inputFields';
import { DEVCONTAINER_PLUGIN } from '../../../../../../../packages/plugins/devcontainer/src/manifest';

describe('saved image roles', () => {
    it('projects the declared Devcontainer image into the offer and receipt without native review', () => {
        const action = DEVCONTAINER_PLUGIN.manifest.contributes.actions.find(action => action.id === 'options');
        const provisioner = DEVCONTAINER_PLUGIN.manifest.contributes.machineProvisioners.find(entry => entry.id === 'devcontainer');
        if (!action || !provisioner) throw new Error('Missing Devcontainer declaration');
        const savedLaunchPresentation = { schema: provisioner.launchSchema, inputHints: InputHintsSchema.parse(action.inputHints) };
        const saved = { provider: { pluginId: DEVCONTAINER_PLUGIN.manifest.id, localId: provisioner.id }, schemaVersion: 1,
            name: 'Docker container', choices: { configuration: { kind: 'image', image: 'node:22' } } };
        expect(describeManagedPresetOffer({ launch: saved, savedLaunchPresentation })).toBe('node:22');
        const receipt = buildManagedConfigurationReceipt({ launch: saved, savedLaunchPresentation });
        expect(receipt.facts.find(fact => fact.id === 'image')?.value).toBe('node:22');
        expect(receipt.facts.some(fact => fact.id === 'saved:configuration.image')).toBe(false);
    });

    it('retains other saved fields and omits hidden, secret and source-body image values', () => {
        const savedLaunchPresentation = { schema: { type: 'object' as const }, inputHints: InputHintsSchema.parse({ fields: [
            { path: 'image', title: 'Image', widget: 'text', role: 'image' },
            { path: 'memory', title: 'RAM', widget: 'integer', role: 'memory' },
            { path: 'arch', title: 'Architecture', widget: 'text' },
            { path: 'hidden', title: 'Hidden', widget: 'text', role: 'image', visibleWhen: { op: 'truthy', path: 'showHidden' } },
            { path: 'secret', title: 'Secret', widget: 'secret', role: 'image' },
            { path: 'source', title: 'Source', widget: 'textarea', role: 'image' },
        ] }) };
        const saved = { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest',
            choices: { image: 'ubuntu:24.04', memory: 4, arch: 'arm64', hidden: 'hidden', secret: 'secret', source: '{"image":"raw"}' } };
        expect(describeManagedPresetOffer({ launch: saved, savedLaunchPresentation })).toBe(
            `${formatManagedSizeBytes(4 * 1024 ** 3).replace(/ /g, '\u00a0')} · ubuntu:24.04`);
        const receipt = buildManagedConfigurationReceipt({ launch: saved, savedLaunchPresentation });
        expect(receipt.facts.find(fact => fact.id === 'image')?.value).toBe('ubuntu:24.04');
        expect(receipt.facts.find(fact => fact.id === 'saved:arch')?.value).toBe('arm64');
        expect(receipt.facts.some(fact => fact.id === 'saved:image' || fact.id === 'saved:memory')).toBe(false);
        expect(describeManagedPresetOffer({ launch: { ...saved, choices: { ...saved.choices, image: '' } }, savedLaunchPresentation }))
            .toBe(formatManagedSizeBytes(4 * 1024 ** 3).replace(/ /g, '\u00a0'));
    });
});

describe('saved option size roles', () => {
    it.each([false, true])('shares the saved size across receipt and offer (bytes=%s)', bytes => {
        const savedLaunchPresentation = { schema: { type: 'object' as const }, inputHints: InputHintsSchema.parse({ fields: [
            { path: 'arbitrary.cores', title: 'CPU', widget: 'integer', role: 'cpu' },
            { path: 'ram', title: 'RAM', widget: 'integer', role: 'memory', ...(bytes ? { unit: 'bytes' } : {}) },
            { path: 'storage', title: 'Disk', widget: 'integer', role: 'disk', ...(bytes ? { unit: 'bytes' } : {}) },
        ] }) };
        const saved = { provider: { pluginId: 'custom.vm', localId: 'vm' }, schemaVersion: 1, name: 'Guest',
            choices: { arbitrary: { cores: 2 }, ram: 4 * (bytes ? 1024 ** 3 : 1), storage: 20 * (bytes ? 1024 ** 3 : 1) } };
        const receipt = buildManagedConfigurationReceipt({ launch: saved, providerTitle: 'Custom', savedLaunchPresentation });
        const size = [t('managedMachines.receipt.cores', { count: 2 }), formatManagedSizeBytes(4 * 1024 ** 3),
            formatManagedSizeBytes(20 * 1024 ** 3)].map(part => part.replace(/ /g, '\u00a0')).join(' · ');
        expect(receipt.spec).toBe(size);
        expect(receipt.facts.filter(fact => fact.id.startsWith('saved:'))).toEqual([]);
        expect(describeManagedPresetOffer({ providerTitle: 'Custom', launch: saved, savedLaunchPresentation })).toBe(`Custom · ${size}`);
    });
});

describe('a saved size beside the other saved choices (SWEEP-S0VD-164)', () => {
    it('keeps every other declared saved choice when only the saved size, not the provider, describes the machine', () => {
        const savedLaunchPresentation = { schema: { type: 'object' as const }, inputHints: InputHintsSchema.parse({ fields: [
            { path: 'store', title: 'Lima store', widget: 'text' },
            { path: 'image', title: 'Image location', widget: 'text' },
            { path: 'arch', title: 'Architecture', widget: 'select', options: [{ value: 'x86_64', label: 'x86_64' }] },
            { path: 'vmType', title: 'VM driver', widget: 'select', options: [{ value: 'qemu', label: 'QEMU' }] },
            { path: 'cpus', role: 'cpu', title: 'CPU cores', widget: 'integer' },
            { path: 'memoryGiB', role: 'memory', title: 'Memory (GiB)', widget: 'integer' },
            { path: 'diskGiB', role: 'disk', title: 'Disk (GiB)', widget: 'integer' },
        ] }) };
        const saved = { provider: { pluginId: 'happier.machine.lima', localId: 'lima' }, schemaVersion: 1, name: 'g1-fixed',
            choices: { arch: 'x86_64', cpus: 4, image: 'https://cloud-images.example/ubuntu-26.04.img', store: '/home/happier/.lima',
                vmType: 'qemu', diskGiB: 100, memoryGiB: 4 } };
        const receipt = buildManagedConfigurationReceipt({ launch: saved, providerTitle: 'Lima', savedLaunchPresentation });
        expect(receipt.spec).toBeTruthy();
        // The size is the spec line; the saved choices it does not cover stay, and the size is not repeated as rows.
        expect(receipt.facts.filter(fact => fact.id.startsWith('saved:')).map(fact => [fact.label, fact.value])).toEqual([
            ['Lima store', '/home/happier/.lima'], ['Image location', saved.choices.image], ['Architecture', 'x86_64'], ['VM driver', 'QEMU'],
        ]);
    });
});

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
describe('a preset offered as a new machine in the picker (lab m-pick)', () => {
    const nativeFacts = { size: { id: 'cx32', title: 'CX32', cpuCores: 4 }, image: { id: 'ubuntu', title: 'Ubuntu 24.04' },
        location: { id: 'fsn1', title: 'Falkenstein', countryCode: 'DE' } };
    const stopUnused = { kind: 'unused' as const, afterMs: 3_600_000, effect: 'stop' as const };
    it('says its reviewed size and place, then the Keep it rule the preset sets now', () => {
        expect(describeManagedPresetOffer({ reviewedFacts: { ...reviewedFacts, nativeFacts }, retention: stopUnused, wakeOnAcceptedMessage: true }))
            .toBe(['CX32', 'Falkenstein', describeRetentionPolicy({ retention: stopUnused, wakeOnAcceptedMessage: true })].join(' · '));
    });
    it('leads with the provider it creates on, then its size and place, then its Keep it rule (DESIGN-2 row 9)', () => {
        expect(describeManagedPresetOffer({ providerTitle: 'Hetzner', reviewedFacts: { ...reviewedFacts, nativeFacts }, retention: stopUnused,
            wakeOnAcceptedMessage: true }))
            .toBe(['Hetzner', 'CX32', 'Falkenstein', describeRetentionPolicy({ retention: stopUnused, wakeOnAcceptedMessage: true })].join(' · '));
        // A local preset with no reviewed size still says what it makes, never only "Always on".
        expect(describeManagedPresetOffer({ providerTitle: 'Lima', retention: { kind: 'until-delete' } }))
            .toBe(['Lima', t('managedRetention.untilDelete')].join(' · '));
        // A provider whose title can't be read yet says nothing in its place.
        expect(describeManagedPresetOffer({ providerTitle: null, retention: { kind: 'until-delete' } })).toBe(t('managedRetention.untilDelete'));
    });
    it('says only its Keep it rule when nothing reviewed describes its size', () => {
        expect(describeManagedPresetOffer({ retention: { kind: 'until-delete' } })).toBe(t('managedRetention.untilDelete'));
    });
    it('never repeats the Keep rule captured at review once the preset follows the defaults', () => {
        expect(describeManagedPresetOffer({ reviewedFacts: { ...reviewedFacts, nativeFacts } })).toBe('CX32 · Falkenstein');
        expect(describeManagedPresetOffer({})).toBeUndefined();
    });
    it('costs No bill on the computer that runs it, a returned price with when it was read, and says provider charges apply when unpriced', () => {
        const local = { location: 'local' as const, stoppedBilling: 'not-billed' as const };
        expect(presentManagedPresetCost({ billing: local, provider: 'Lima', runsOn: 'Mac Studio' })).toEqual({
            value: t('managedMachines.price.noBill'), detail: t('managedMachines.price.runsOn', { computer: 'Mac Studio' }) });
        const price = reviewedFacts.prices[0]!;
        const headline = presentManagedCost({ kind: 'price', prices: [price] });
        expect(presentManagedPresetCost({ prices: [price], billing: reviewedFacts.billing, provider: 'Hetzner' })).toEqual({
            value: `${headline.value} ${headline.unit}`, detail: formatPriceSource(price, null) });
        // A cloud machine without a returned price never shows a figure, and never a blank that reads as free (PLAN §3).
        expect(presentManagedPresetCost({ billing: reviewedFacts.billing, provider: 'Hetzner' })).toEqual({
            value: t('managedMachines.price.unavailable', { provider: null }) });
    });
});
describe('one managed configuration receipt projection', () => {
    it('lists saved choices only under their declared titles, with sensitive values withheld, when no native facts describe them', () => {
        const saved = { ...launch, choices: { image: 'https://images.example/saved.img', store: '/saved/virtual-machines',
            memory: 4 * 1024 ** 3, region: 'west', token: 'private-saved-token', enabled: false, arch: 'x86_64' } };
        const schema = { type: 'object', properties: { image: { type: 'string' }, store: { type: 'string' },
            memory: { type: 'integer' }, region: { type: 'string' }, token: { type: 'string' }, missingFlag: { type: 'boolean' },
            enabled: { type: 'boolean' }, arch: { type: 'string', title: 'Architecture' } } };
        const receipt = buildManagedConfigurationReceipt({ launch: saved, providerTitle: 'Compute',
            savedLaunchPresentation: { schema, inputHints: { fields: [
                { path: 'memory', title: 'Memory (GiB)', widget: 'integer', unit: 'bytes' },
                { path: 'region', title: 'Region', widget: 'select', options: [{ value: 'west', label: 'West coast' }] },
                { path: 'token', title: 'Token', widget: 'secret' },
            ] } } });
        expect(receipt.facts).toEqual(expect.arrayContaining([
            expect.objectContaining({ label: 'Memory (GiB)', value: '4' }),
            expect.objectContaining({ label: 'Region', value: 'West coast' }),
            expect.objectContaining({ label: 'Architecture', value: 'x86_64' }),
        ]));
        // A field named only by its schema key ("Store", "Vm Type", "Disk Gi B") has no title a person reads.
        expect(receipt.facts.filter(fact => fact.id.startsWith('saved:')).map(fact => fact.label).sort())
            .toEqual(['Architecture', 'Memory (GiB)', 'Region']);
        expect(JSON.stringify(receipt)).not.toContain(saved.choices.token);
        expect(JSON.stringify(receipt)).not.toContain(saved.choices.store);
    });
    it('leaves saved choices to the provider\'s native facts when it has described them, current or last saved', () => {
        const saved = { ...launch, choices: { image: 'https://cloud-images.example/releases/ubuntu-26.04-server-cloudimg-amd64.img',
            cpus: 2, memoryGiB: 2, diskGiB: 8, vmType: 'qemu' } };
        const savedLaunchPresentation = { schema: { type: 'object', properties: { image: { type: 'string', title: 'Image location' },
            cpus: { type: 'integer', title: 'CPU cores' }, memoryGiB: { type: 'integer', title: 'Memory (GiB)' },
            diskGiB: { type: 'integer', title: 'Disk (GiB)' }, vmType: { type: 'string', title: 'VM driver' } } } };
        const native = { size: { id: 'custom', title: 'Custom size', cpuCores: 2, memoryBytes: 2 * 1024 ** 3, diskBytes: 8 * 1024 ** 3 },
            image: { id: 'ubuntu', title: 'Ubuntu 26.04' } };
        const current = buildManagedConfigurationReceipt({ launch: saved, providerTitle: 'Lima', savedLaunchPresentation,
            reviewedFacts: { ...reviewedFacts, launch: saved, nativeFacts: native } });
        const lastSaved = buildManagedConfigurationReceipt({ launch: saved, providerTitle: 'Lima', savedLaunchPresentation, lastSaved: native });
        for (const receipt of [current, lastSaved]) {
            expect(receipt.facts.filter(fact => fact.id.startsWith('saved:'))).toEqual([]);
            expect(JSON.stringify(receipt)).not.toContain(saved.choices.image);
        }
    });
    it('keeps saved choices with unavailable declaration labels honest instead of printing opaque selection ids', () => {
        const saved = { ...launch, choices: { region: 'private-provider-location-id' } };
        const receipt = buildManagedConfigurationReceipt({ launch: saved, providerTitle: 'Compute',
            savedLaunchPresentation: { schema: { type: 'object', properties: { region: { type: 'string' } } }, inputHints: { fields: [
                { path: 'region', title: 'Region', widget: 'select', optionsSourceId: 'live-regions' },
            ] } } });
        expect(receipt.facts).toContainEqual(expect.objectContaining({ label: 'Region', value: t('common.unavailable') }));
        expect(JSON.stringify(receipt)).not.toContain(saved.choices.region);
    });
    it('keeps Team resource receipts out of personal Account lookups and presents an absent resource as unavailable', () => {
        const selected = ValidatedLaunchSnapshotV1Schema.parse({ ...launch, credentials: [{
            purpose: { consumer: launch.provider, purpose: 'provision' }, teamId: 'engineering',
            selection: { source: 'team_resource', resourceId: 'team-compute', deliveryMode: 'brokered' },
        }] });
        expect(managedCredentialReceiptTargets(selected)).toEqual([]);
        const receipt = buildManagedConfigurationReceipt({ launch: selected, providerTitle: 'Compute' });
        expect(receipt.facts.find(fact => fact.id === 'credential:0')?.value).toBe(t('common.unavailable'));
        expect(JSON.stringify(receipt)).not.toContain('team-compute');
    });
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
        const personal = selected.credentials![0]!;
        if (!('account' in personal)) throw new Error('Expected a personal credential fixture');
        const unavailable = presentQualifiedConnectedAccountTarget({ target: { kind: 'account', account: personal.account },
            accounts: [], groups: [], labelsByKey: {}, serviceTitle: null }).primaryLabel;
        expect(accounts.map(fact => fact.value)).toEqual([unavailable, unavailable]);
        expect(receipt.facts.find(fact => fact.id === 'controller')).toBeUndefined();
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
        // The row's label already says what is started: its value is only the state.
        expect(receipt.facts.find(fact => fact.id === 'wake')?.value).toBe(t('common.on'));
        expect(receipt.keep).toBeUndefined();
    });
    const localFacts = { ...reviewedFacts, prices: [], billing: { location: 'local' as const, stoppedBilling: 'not-billed' as const },
        nativeFacts: { size: { id: 'medium', title: 'Medium', cpuCores: 6, memoryBytes: 16 * 2 ** 30, diskBytes: 128 * 2 ** 30 },
            image: { id: 'tahoe', title: 'macOS Tahoe' } } };
    it.each([0, 4])('shows total and %i allocated cores without claiming free CPU', allocated => {
        const receipt = buildManagedConfigurationReceipt({ launch, providerTitle: 'Lume', controllerName: 'MacBook Pro', reviewedFacts: { ...localFacts,
            localResources: { observedAt: 5, totalCpuCores: 16, allocatedCpuCores: allocated, availableMemoryBytes: 36 * 2 ** 30 } } });
        expect(receipt.cost).toMatchObject({ kind: 'local', meters: [
            { id: 'cpu', fraction: allocated / 16, value: t('managedMachines.receipt.coresAllocated', { allocated: String(allocated), total: '16' }) },
            { id: 'memory', fraction: 16 / 36 },
        ], note: t('managedMachines.receipt.leavesOne', { amount: '20 GiB', computer: 'MacBook Pro' }) });
    });
    it('includes disk in local size comparison headroom, including insufficient space', () => {
        expect(describeLocalHeadroom({ id: 'custom', title: 'Custom', diskBytes: 64 * 2 ** 30 },
            { observedAt: 5, availableDiskBytes: 90 * 2 ** 30 })).toBe('26 GiB');
        expect(describeLocalHeadroom({ id: 'custom', title: 'Custom', diskBytes: 150 * 2 ** 30 },
            { observedAt: 5, availableDiskBytes: 90 * 2 ** 30 })).toBe(t('managedMachines.config.notEnoughFree'));
    });
    // LUME-LIVE3 attempt 4: one native home location (~/.lume), selected storage=home,
    // 2 cores / 4 GiB / 150 GiB requested; native filesystem had roughly 90 GB free.
    it.each([90_000_000_000, 0, undefined])('carries measured home disk space (%s) into the shared receipt', availableDiskBytes => {
        const selected = { ...launch, choices: { storage: 'home', cpu: 2, memoryBytes: 4 * 2 ** 30, diskBytes: 150 * 2 ** 30 } };
        const facts = { ...localFacts, launch: selected, nativeFacts: {
            size: { id: 'custom', title: 'Custom', cpuCores: 2, memoryBytes: 4 * 2 ** 30, diskBytes: 150 * 2 ** 30 },
            location: { id: 'home', title: 'home' },
        }, localResources: { observedAt: 5, availableMemoryBytes: 50_574_917_222,
            ...(availableDiskBytes === undefined ? {} : { availableDiskBytes }) } };
        const receipt = buildManagedConfigurationReceipt({ launch: selected, reviewedFacts: facts,
            providerTitle: 'Lume', controllerName: 'MacBook Pro' });
        expect(receipt.facts).toContainEqual(expect.objectContaining({ id: 'location', value: 'home' }));
        expect(receipt.cost?.kind).toBe('local');
        if (receipt.cost?.kind !== 'local') throw new Error('Expected local receipt');
        expect(receipt.cost.meters.map(meter => meter.id)).toEqual(availableDiskBytes === undefined ? ['memory'] : ['memory', 'disk']);
        if (availableDiskBytes !== undefined) {
            expect(receipt.cost.meters.find(meter => meter.id === 'disk')).toMatchObject({ fraction: 1,
                label: t('managedMachines.config.columns.disk'),
                value: t('managedMachines.receipt.amountOfFree', { amount: '150 GiB', free: formatManagedSizeBytes(availableDiskBytes) }) });
            expect(receipt.cost.note).toBe(t('managedMachines.receipt.exceedsFree', { computer: 'MacBook Pro' }));
        }
    });
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
        // "Runs on a machine in Build servers" names the pool once; no Managed from row repeats it.
        expect(receipt.facts.some(fact => fact.id === 'controller')).toBe(false);
        expect(receipt.cost).toEqual({ kind: 'local', computer: sentence, meters: [] });
    });
    it('keeps "Unknown" out of a requester\'s sentences when the controller has no name it can read (VD G2)', () => {
        const receipt = buildManagedConfigurationReceipt({ launch, providerTitle: 'Lima', reviewedFacts: localFacts });
        const computer = t('managedMachines.receipt.managingComputer');
        expect(receipt.cost).toEqual({ kind: 'local', computer, meters: [], note: t('managedMachines.receipt.headroomUnknown', { computer }) });
        // Runs on names the computer once, so no "Unknown" Managed from row stands beside it.
        expect(receipt.facts.some(fact => fact.id === 'controller')).toBe(false);
    });
    it('names a local machine\'s computer once, in Runs on, and keeps Managed from where it runs elsewhere or no longer runs (O-MACH 11-10)', () => {
        const local = buildManagedConfigurationReceipt({ launch, providerTitle: 'Lima', controllerName: 'Build Mac', reviewedFacts: localFacts });
        expect(local.facts.some(fact => fact.id === 'controller')).toBe(false);
        expect(local.cost).toMatchObject({ kind: 'local', computer: 'Build Mac' });
        // A cloud guest is managed from one computer and runs at the provider: both are said.
        const cloud = buildManagedConfigurationReceipt({ launch, providerTitle: 'Compute', controllerName: 'Build Mac', reviewedFacts });
        expect(cloud.facts.find(fact => fact.id === 'controller')?.value).toBe('Build Mac');
        // A local machine that no longer exists has no Runs on line: its record keeps Managed from and shows no cost.
        const absent = buildManagedConfigurationReceipt({ launch, providerTitle: 'Lima', controllerName: 'Build Mac', reviewedFacts: localFacts,
            created: true, absent: true });
        expect(absent.cost).toBeNull();
        expect(absent.facts.find(fact => fact.id === 'controller')?.value).toBe('Build Mac');
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
