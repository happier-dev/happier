import { describe, expect, it } from 'vitest';
import { buildBackendTargetKeyV2 } from '../backends/targets/backendTargetRefV2.js';
import { openConnectedPresentationContentV1, sealConnectedPresentationContentV1,
    openConnectedAcknowledgementsContentV1, sealConnectedAcknowledgementsContentV1,
    readLegacyConnectedMetadataV1, removeConnectedMetadataSubjectV1, removeLegacyConnectedMetadataSubjectV1, applyConnectedPresentationMutationV1, applyConnectedAcknowledgementMutationV1,
    ConnectedPresentationRowReadResponseV1Schema,
    StoredConnectedPresentationContentV1Schema, StoredConnectedAcknowledgementsContentV1Schema,
    StoredConnectedPresentationRecordV1Schema, StoredConnectedAcknowledgementsRecordV1Schema,
    projectConnectedPresentationLabelsV1, connectedEntitySubjectKeyV1,
    type QualifiedConnectedEntityRef,
    CONNECTED_PRESENTATION_ACCOUNT_CIPHER_KIND_V1, CONNECTED_ACKNOWLEDGEMENTS_ACCOUNT_CIPHER_KIND_V1,
} from './connectedAccountPresentationRowsV1.js';
import { sealAccountScopedBlobCiphertext } from '../crypto/accountScopedCipher.js';

const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
const account: QualifiedConnectedEntityRef = { kind: 'account', account: { service, accountId: 'default' } };
const group: QualifiedConnectedEntityRef = { kind: 'group', service, groupId: 'work-team' };
const agentTargetKey = buildBackendTargetKeyV2({ kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } });
const inventory = { entities: [account, group], agents: [{ agentTargetKey, legacyAgentId: 'codex' }] };

describe('connected Account presentation and acknowledgement authority', () => {
    it('refuses visible credential carriers before stored metadata projection in both Account modes', () => {
        const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(9) };
        const record = { v: 1 as const, entries: [] };
        for (const mode of ['plain', 'e2ee'] as const) {
            const key = mode === 'plain' ? null : material;
            const cases = [
                { schema: StoredConnectedPresentationContentV1Schema, open: openConnectedPresentationContentV1,
                    content: sealConnectedPresentationContentV1({ mode, material: key, record }) },
                { schema: StoredConnectedAcknowledgementsContentV1Schema, open: openConnectedAcknowledgementsContentV1,
                    content: sealConnectedAcknowledgementsContentV1({ mode, material: key, record }) },
            ];
            for (const domain of cases) {
                const harmless = { ...domain.content, futureDisplay: { color: 'warm' } };
                expect(domain.schema.safeParse(harmless).success).toBe(true);
                expect(domain.open({ mode, material: key, content: harmless })).toEqual({ status: 'opened', record });
                const carrier = { ...harmless, futureCredential: { secretRef: 'happier:shared-secret:v1:unknown' } };
                expect(domain.schema.safeParse(carrier).success).toBe(false);
                expect(domain.open({ mode, material: key, content: carrier }))
                    .toEqual({ status: 'unavailable', reason: 'invalid-stored-content' });
            }
        }
    });
    it('refuses hidden payload credential carriers before stored metadata projection after decryption', () => {
        const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(9) };
        const payload = { v: 1, entries: [], futureCredential: { secretRef: 'happier:shared-secret:v1:unknown' } };
        for (const domain of [
            { schema: StoredConnectedPresentationRecordV1Schema, open: openConnectedPresentationContentV1,
                kind: CONNECTED_PRESENTATION_ACCOUNT_CIPHER_KIND_V1 },
            { schema: StoredConnectedAcknowledgementsRecordV1Schema, open: openConnectedAcknowledgementsContentV1,
                kind: CONNECTED_ACKNOWLEDGEMENTS_ACCOUNT_CIPHER_KIND_V1 },
        ]) {
            expect(domain.schema.safeParse({ v: 1, entries: [], futureDisplay: { color: 'warm' } }).success).toBe(true);
            expect(domain.schema.safeParse(payload).success).toBe(false);
            const c = sealAccountScopedBlobCiphertext({ kind: domain.kind, material, payload,
                randomBytes: length => new Uint8Array(length).fill(1) });
            expect(domain.open({ mode: 'e2ee', material, content: { t: 'encrypted', c } }))
                .toEqual({ status: 'unavailable', reason: 'invalid-stored-content' });
        }
    });
    it('passes raw stored entries through row transport and exposes valid neighbors with incomplete diagnostics', () => {
        const response = ConnectedPresentationRowReadResponseV1Schema.parse({ status: 'present', revision: 3,
            content: { t: 'plain', v: { v: 1, entries: [
                { v: 1, subject: account, label: 'Work' },
                { v: 1, subject: group, label: 42 },
                { v: 1, subject: { ...group, futureAccountRef: 'unverified' }, label: 'Readable' },
            ] } } });
        expect(response.status).toBe('present');
        if (response.status !== 'present') return;
        const opened = openConnectedPresentationContentV1({ mode: 'plain', material: null, content: response.content });
        expect(opened).toMatchObject({ status: 'partial', record: { v: 1, entries: [
            { v: 1, subject: account, label: 'Work' }, { v: 1, subject: group, label: 'Readable' },
        ] }, diagnostics: [expect.objectContaining({ reason: 'invalid-stored-content' })] });
    });
    it('opens known stored identities with additive catalog, entry, and subject fields projected away', () => {
        const response = ConnectedPresentationRowReadResponseV1Schema.parse({ status: 'present', revision: 3,
            content: { t: 'plain', v: { v: 1, futureCatalogHint: 'display', entries: [
                { v: 1, subject: { ...account, futureAccountRef: 'additive' }, label: 'Work', displayHint: 'display' },
            ] } } });
        if (response.status !== 'present') throw new Error('Expected stored presentation row');
        expect(openConnectedPresentationContentV1({ mode: 'plain', material: null, content: response.content }))
            .toEqual({ status: 'opened', record: { v: 1, entries: [{ v: 1, subject: account, label: 'Work' }] } });
    });
    it('keeps unknown subject versions and duplicate identities incomplete while exposing valid neighbors', () => {
        const opened = openConnectedPresentationContentV1({ mode: 'plain', material: null,
            content: { t: 'plain', v: { v: 1, entries: [
                { v: 1, subject: account, label: 'Work' },
                { v: 2, subject: group, label: 'Unknown entry version' },
                { v: 1, subject: { kind: 'future', service }, label: 'Unknown subject' },
                { v: 1, subject: group, label: 'First' },
                { v: 1, subject: group, label: 'Second' },
            ] } } });
        expect(opened).toEqual({ status: 'partial', record: { v: 1, entries: [{ v: 1, subject: account, label: 'Work' }] },
            diagnostics: [expect.objectContaining({ reason: 'invalid-stored-content' }),
                expect.objectContaining({ reason: 'invalid-stored-content' }), expect.objectContaining({ reason: 'duplicate-subject' })] });
        expect(openConnectedPresentationContentV1({ mode: 'plain', material: null,
            content: { t: 'plain', v: { v: 2, entries: [] } } }))
            .toEqual({ status: 'unavailable', reason: 'invalid-stored-content' });
    });
    it('retains literal predecessor default and exact Machine/global sparse acknowledgements', () => {
        const raw = { connectedServicesProfileLabelByKey: { 'openai-codex/default': 'Work' },
            connectedServicesDefaultAuthPoolAdoptionDismissedByKey: { 'codex:openai-codex:work-team': false },
            dismissedCLIWarnings: { global: { installation: true }, perMachine: { 'machine:one': { installation: false } } } };
        const result = readLegacyConnectedMetadataV1(raw, inventory);
        expect(result.status).toBe('ready');
        if (result.status !== 'ready') return;
        expect(result.presentation.entries).toEqual([{ v: 1, subject: account, label: 'Work' }]);
        expect(result.acknowledgements.entries).toEqual([
            { v: 1, subject: { kind: 'adoption', agentTargetKey, service, groupId: 'work-team' }, acknowledged: false },
            { v: 1, subject: { kind: 'warning', warningId: 'installation', scope: { kind: 'account' } }, acknowledged: true },
            { v: 1, subject: { kind: 'warning', warningId: 'installation', scope: { kind: 'machine', machineId: 'machine:one' } }, acknowledged: false },
        ]);
    });

    it('refuses an ambiguous legacy address instead of splitting punctuation', () => {
        const collision = { kind: 'account' as const, account: { service, accountId: 'folder%2Faccount' } };
        const other = { kind: 'account' as const, account: { service, accountId: 'folder/account' } };
        expect(readLegacyConnectedMetadataV1({ connectedServicesProfileLabelByKey: {
            'openai-codex/folder%2Faccount': 'Ambiguous',
        } }, { entities: [collision, other], agents: [] })).toMatchObject({ status: 'partial',
            diagnostics: [{ root: 'connectedServicesProfileLabelByKey', key: 'openai-codex/folder%2Faccount', reason: 'ambiguous-subject' }] });
    });

    it('keeps valid neighbors and reports malformed or conflicting legacy values without mutating source', () => {
        const raw = { connectedServicesProfileLabelByKey: { 'openai-codex/default': 'Work',
            'happier.agent.codex%2Fopenai-codex/default': 'Conflicting', unknown: 42 },
            dismissedCLIWarnings: { global: { installation: false, malformed: 'yes' }, perMachine: {} } };
        const before = structuredClone(raw);
        const result = readLegacyConnectedMetadataV1(raw, inventory);
        expect(result.status).toBe('partial');
        expect(result.presentation.entries).toEqual([]);
        expect(result.acknowledgements.entries).toEqual([{ v: 1, subject: { kind: 'warning', warningId: 'installation', scope: { kind: 'account' } }, acknowledged: false }]);
        expect(result.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({ root: 'connectedServicesProfileLabelByKey', reason: 'conflicting-values' }),
            expect.objectContaining({ root: 'connectedServicesProfileLabelByKey', key: 'unknown', reason: 'invalid-stored-content' }),
            expect.objectContaining({ root: 'dismissedCLIWarnings', reason: 'invalid-stored-content' }),
        ]));
        expect(raw).toEqual(before);
    });

    it('retains independent sparse pool-member disclosure with exact group and account identities', () => {
        const first = { kind: 'group-member' as const, group: { service, groupId: 'work-team' }, accountId: 'default' };
        const second = { ...first, accountId: 'personal' };
        const result = readLegacyConnectedMetadataV1({ connectedServicesCollapsedItemKeysV1: {
            'openai-codex:pool:work-team:default': false,
            'openai-codex:pool:work-team:personal': true,
        } }, { ...inventory, disclosureSubjects: [first, second] });
        expect(result.status).toBe('ready');
        expect(result.disclosure).toEqual([{ subject: first, collapsed: false }, { subject: second, collapsed: true }]);
    });

    it('opens both Account modes while refusing wrong envelopes or locked material', () => {
        const record = { v: 1 as const, entries: [{ v: 1 as const, subject: account, label: 'Work' }] };
        const acks = { v: 1 as const, entries: [{ v: 1 as const, subject: { kind: 'warning' as const, warningId: 'installation',
            scope: { kind: 'machine' as const, machineId: 'exact' } }, acknowledged: true }] };
        const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(9) };
        for (const mode of ['plain', 'e2ee'] as const) {
            const key = mode === 'plain' ? null : material;
            const content = sealConnectedPresentationContentV1({ mode, material: key, record });
            expect(openConnectedPresentationContentV1({ mode, material: key, content })).toEqual({ status: 'opened', record });
            expect(openConnectedPresentationContentV1({ mode: mode === 'plain' ? 'e2ee' : 'plain', material: null, content }))
                .toEqual({ status: 'unavailable', reason: 'account-mode-mismatch' });
            const ackContent = sealConnectedAcknowledgementsContentV1({ mode, material: key, record: acks });
            expect(openConnectedAcknowledgementsContentV1({ mode, material: key, content: ackContent }))
                .toEqual({ status: 'opened', record: acks });
            if (mode === 'e2ee') expect(openConnectedPresentationContentV1({ mode, material: null, content }))
                .toEqual({ status: 'unavailable', reason: 'encryption-material-unavailable' });
        }
    });

    it('deletes exact metadata without discarding another service or warning scope', () => {
        const otherGroup = { ...group, service: { ...service, localId: 'other' } };
        const presentation = { v: 1 as const, entries: [group, otherGroup].map(subject => ({ v: 1 as const, subject, label: 'Work' })) };
        const acknowledgements = { v: 1 as const, entries: [
            { v: 1 as const, subject: { kind: 'adoption' as const, agentTargetKey, service, groupId: 'work-team' }, acknowledged: true },
            { v: 1 as const, subject: { kind: 'warning' as const, warningId: 'installation', scope: { kind: 'machine' as const, machineId: 'exact' } }, acknowledged: true },
        ] };
        expect(removeConnectedMetadataSubjectV1({ presentation, acknowledgements, subject: group })).toEqual({
            presentation: { v: 1, entries: [presentation.entries[1]] }, acknowledgements: { v: 1, entries: [acknowledgements.entries[1]] },
        });
    });

    it('prepares exact deleted subject source cleanup without removing ambiguous neighbors or genuine preferences', () => {
        const ambiguous = { kind: 'account' as const, account: { service, accountId: 'folder%2Faccount' } };
        const otherAmbiguous = { kind: 'account' as const, account: { service, accountId: 'folder/account' } };
        const members = ['default', 'personal'].map(accountId => ({ kind: 'group-member' as const, group: { service, groupId: 'work-team' }, accountId }));
        const beforeDelete = { ...inventory, entities: [...inventory.entities, ambiguous, otherAmbiguous], disclosureSubjects: members };
        const raw = { connectedServicesProfileLabelByKey: { 'openai-codex/default': 'Work', 'openai-codex/folder%2Faccount': 'Ambiguous', unknown: 42 },
            connectedServicesCollapsedItemKeysV1: { 'openai-codex:account:default': false, 'openai-codex:pool:work-team:default': true,
                'openai-codex:pool:work-team:personal': false, unknown: true },
            connectedServicesDefaultAuthPoolAdoptionDismissedByKey: { 'codex:openai-codex:work-team': false, unknown: true },
            dismissedCLIWarnings: { global: { installation: false }, perMachine: {} },
            connectedServicesDefaultProfileByServiceId: { 'openai-codex': 'default' } };
        const original = structuredClone(raw);
        expect(removeLegacyConnectedMetadataSubjectV1({ raw, inventory: beforeDelete, subject: account }).raw).toEqual({ ...raw,
            connectedServicesProfileLabelByKey: { 'openai-codex/folder%2Faccount': 'Ambiguous', unknown: 42 },
            connectedServicesCollapsedItemKeysV1: { 'openai-codex:pool:work-team:personal': false, unknown: true } });
        expect(removeLegacyConnectedMetadataSubjectV1({ raw, inventory: beforeDelete, subject: group }).raw).toEqual({ ...raw,
            connectedServicesCollapsedItemKeysV1: { 'openai-codex:account:default': false, unknown: true },
            connectedServicesDefaultAuthPoolAdoptionDismissedByKey: { unknown: true } });
        expect(removeLegacyConnectedMetadataSubjectV1({ raw, inventory: beforeDelete, subject: ambiguous }).raw).toEqual(raw);
        expect(removeLegacyConnectedMetadataSubjectV1({ raw: { ...raw, connectedServicesCollapsedItemKeysV1: null }, inventory: beforeDelete, subject: group }).raw)
            .toEqual({ ...raw, connectedServicesCollapsedItemKeysV1: null, connectedServicesDefaultAuthPoolAdoptionDismissedByKey: { unknown: true } });
        expect(raw).toEqual(original);
    });

    it('projects account and exact qualified group labels into one display map', () => {
        const otherGroup: QualifiedConnectedEntityRef = { kind: 'group', service: { ...service, localId: 'other' }, groupId: 'work-team' };
        expect(projectConnectedPresentationLabelsV1({ entries: [
            { v: 1, subject: account, label: 'Account' },
            { v: 1, subject: group, label: 'Group' },
            { v: 1, subject: otherGroup, label: 'Other service' },
        ] })).toEqual({
            'happier.agent.codex%2Fopenai-codex/default': 'Account',
            [connectedEntitySubjectKeyV1(group)]: 'Group',
            [connectedEntitySubjectKeyV1(otherGroup)]: 'Other service',
        });
    });

    it('updates and resets exact subjects while retaining sparse false acknowledgements', () => {
        const other = { ...account, account: { ...account.account, service: { ...service, localId: 'other' } } };
        const base = { v: 1 as const, entries: [{ v: 1 as const, subject: other, label: 'Unrelated' }] };
        const changed = applyConnectedPresentationMutationV1(base, { subject: account, label: '  Work  ' });
        expect(changed.entries).toEqual([...base.entries, { v: 1, subject: account, label: 'Work' }]);
        expect(projectConnectedPresentationLabelsV1(changed)).toEqual({
            'happier.agent.codex%2Fother/default': 'Unrelated', 'happier.agent.codex%2Fopenai-codex/default': 'Work',
        });
        expect(applyConnectedPresentationMutationV1(changed, { subject: account, label: null })).toEqual(base);
        const warning = { kind: 'warning' as const, warningId: 'installation', scope: { kind: 'machine' as const, machineId: 'exact' } };
        const acknowledged = applyConnectedAcknowledgementMutationV1({ v: 1, entries: [] }, { subject: warning, acknowledged: false });
        expect(acknowledged.entries).toEqual([{ v: 1, subject: warning, acknowledged: false }]);
        expect(applyConnectedAcknowledgementMutationV1(acknowledged, { subject: warning, acknowledged: null })).toEqual({ v: 1, entries: [] });
    });
});
