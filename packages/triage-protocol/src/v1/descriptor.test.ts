import { describe, expect, it } from 'vitest';

import {
    admitTriageSourceDescriptorV1,
    TriageSourceDescriptorV1Schema,
} from './descriptor.js';

/**
 * The one declaration a source makes about itself, and the one thing that was
 * missing from it.
 *
 * A target that lists nothing because nothing is configured has to be able to
 * send the reader somewhere. Every source already ships a Settings page for
 * exactly that, but the descriptor named no page, so the target could not
 * construct the destination and the empty screen could only describe the remedy
 * in prose. This is the field that closes that gap, and it is OPTIONAL by
 * construction: a source that declares no page is a source with no offer, never
 * a source the target refuses to admit.
 */

const MINIMAL = Object.freeze({
    v: 1,
    purpose: 'example-forge',
    displayName: 'Example Forge',
    kinds: Object.freeze([Object.freeze({
        id: 'pull-request',
        workflowSubject: 'pullRequest',
        displayName: 'Pull request',
    })]),
});

describe('the V1 source descriptor', () => {
    it('declares a closed server-side sort capability set', () => {
        const parsed = TriageSourceDescriptorV1Schema.parse({
            ...MINIMAL,
            sortFields: ['updated', 'created', 'status'],
        });
        expect(parsed.sortFields).toEqual(['updated', 'created', 'status']);
        expect(TriageSourceDescriptorV1Schema.safeParse({ ...MINIMAL, sortFields: ['title'] }).success).toBe(false);
        expect(TriageSourceDescriptorV1Schema.safeParse({ ...MINIMAL, sortFields: ['updated', 'updated'] }).success).toBe(false);
    });

    it('retains a source-declared minimum scan page without requiring one from other sources', () => {
        expect(TriageSourceDescriptorV1Schema.parse({ ...MINIMAL, minimumScanPageSize: 10 }))
            .toMatchObject({ minimumScanPageSize: 10 });
        expect(TriageSourceDescriptorV1Schema.parse(MINIMAL)).not.toHaveProperty('minimumScanPageSize');
        for (const minimumScanPageSize of [0, -1, 1.5]) {
            expect(TriageSourceDescriptorV1Schema.safeParse({ ...MINIMAL, minimumScanPageSize }).success).toBe(false);
        }
    });
    it('admits only a nonempty unique subset of declared kinds for source Session relations', () => {
        const scoped = { ...MINIMAL, sessionRelations: { kindIds: ['pull-request'] } };
        expect(admitTriageSourceDescriptorV1(scoped)).toMatchObject({ ok: true,
            descriptor: { sessionRelations: { kindIds: ['pull-request'] } },
        });
        for (const kindIds of [[], ['unknown'], ['pull-request', 'pull-request']]) {
            expect(admitTriageSourceDescriptorV1({ ...MINIMAL, sessionRelations: { kindIds } }).ok).toBe(false);
        }
        expect(admitTriageSourceDescriptorV1({ ...MINIMAL, sessionRelations: { authority: 'other' } }).ok).toBe(false);
        expect(admitTriageSourceDescriptorV1({ ...MINIMAL, sessionRelations: {} })).toMatchObject({ ok: true });
    });
    it('preserves a separately authored source’s natural selection unit', () => {
        const scopeUnit = { singularLabel: 'Repository', pluralLabel: 'Repositories' };
        const parsed = TriageSourceDescriptorV1Schema.parse({ ...MINIMAL, scopeUnit });
        expect(parsed).toMatchObject({ scopeUnit });
        expect(TriageSourceDescriptorV1Schema.safeParse({
            ...MINIMAL, scopeUnit: { ...scopeUnit, authority: 'invented' },
        }).success).toBe(false);
    });
    it('declares task edits and native transitions while retaining read-only source admission', () => {
        const taskCapabilities = {
            createFields: ['title', 'body', 'scopeId'], editFields: ['title', 'body', 'assigneeIds'],
            initialStatuses: [{ id: 'planned', label: 'Planned', state: { presentation: 'active', stage: 'backlog' } }],
            transitions: [{ id: 'begin', label: 'In progress', state: { presentation: 'active', stage: 'started' } }],
        };
        const admitted = admitTriageSourceDescriptorV1({
            ...MINIMAL, kinds: [{ ...MINIMAL.kinds[0], task: true, taskCapabilities }],
        });
        expect(admitted.ok).toBe(true);
        expect(admitted.ok && admitted.descriptor.kinds[0]).toMatchObject({ task: true, taskCapabilities });
        expect(admitTriageSourceDescriptorV1(MINIMAL).ok).toBe(true);
    });
    it('retains the optional source default marker without requiring it from other sources', () => {
        for (const marker of [{}, { isDefault: true }]) {
            const initialStatuses = [{ id: 'planned', label: 'Planned',
                state: { presentation: 'active', stage: 'backlog' }, ...marker }];
            const admitted = admitTriageSourceDescriptorV1({
                ...MINIMAL, kinds: [{ ...MINIMAL.kinds[0], task: true,
                    taskCapabilities: { initialStatuses } }],
            });
            expect(admitted.ok).toBe(true);
            if (!admitted.ok) throw new Error('Expected the source creation catalog');
            expect(admitted.descriptor.kinds[0]!.taskCapabilities!.initialStatuses).toEqual(initialStatuses);
        }
    });
    it('carries the source own Settings page so the target can offer a way to configure it', () => {
        const parsed = TriageSourceDescriptorV1Schema.safeParse({
            ...MINIMAL,
            settingsPageId: 'triage-sources',
        });

        expect(parsed.success).toBe(true);
        // Read back, not merely accepted: an `additive-open/drop` object drops
        // every property it does not declare, so a field that parses but does
        // not survive is exactly the state this closes.
        expect(parsed.success && parsed.data.settingsPageId).toBe('triage-sources');
    });

    it('admits a source that declares no page at all', () => {
        // Six source plugins already ship descriptors without one. A required
        // field would make every one of them inadmissible.
        const parsed = TriageSourceDescriptorV1Schema.safeParse(MINIMAL);

        expect(parsed.success).toBe(true);
        expect(parsed.success && 'settingsPageId' in parsed.data).toBe(false);
    });

    it('bounds the page it names', () => {
        expect(TriageSourceDescriptorV1Schema.safeParse({
            ...MINIMAL,
            settingsPageId: 'a'.repeat(200),
        }).success).toBe(false);
        expect(TriageSourceDescriptorV1Schema.safeParse({
            ...MINIMAL,
            settingsPageId: '',
        }).success).toBe(false);
    });

    it('rejects duplicate kind ids at the production target admission boundary', () => {
        const admitted = admitTriageSourceDescriptorV1({
            ...MINIMAL,
            kinds: [
                MINIMAL.kinds[0],
                { ...MINIMAL.kinds[0], workflowSubject: 'issue', displayName: 'Issue' },
            ],
        });

        expect(admitted).toEqual({ ok: false, reason: 'duplicateKindId' });
    });

    it('does not reject a descriptor solely because it has more than thirty-two kinds', () => {
        const parsed = TriageSourceDescriptorV1Schema.safeParse({
            ...MINIMAL,
            kinds: Array.from({ length: 33 }, (_unused, index) => ({
                id: `kind-${index + 1}`,
                workflowSubject: 'issue',
                displayName: `Kind ${index + 1}`,
            })),
        });

        expect(parsed.success).toBe(true);
    });
});

describe('per-kind detail tab declarations (r0.42)', () => {
    it('admits source-declared tabs beyond eight without a synthetic count ceiling', () => {
        const tabs = Array.from({ length: 9 }, (_, i) => ({ kind: 'source', id: `panel-${i}`, title: `Panel ${i}` }));
        expect(admitTriageSourceDescriptorV1({ ...MINIMAL, kinds: [{ ...MINIMAL.kinds[0], detailTabs: tabs }] }).ok).toBe(true);
    });

    it('preserves a source-owned translation key on its tab', () => {
        const tab = { kind: 'source', id: 'trace', title: 'Stack trace', titleKey: 'plugins.example.trace' };
        const admitted = admitTriageSourceDescriptorV1({ ...MINIMAL, kinds: [{ ...MINIMAL.kinds[0], detailTabs: [tab] }] });
        expect(admitted.ok).toBe(true);
        expect(admitted.ok && admitted.descriptor.kinds[0]?.detailTabs).toEqual([tab]);
    });
    const withTabs = (detailTabs: unknown) => ({
        ...MINIMAL,
        kinds: [{ ...MINIMAL.kinds[0], detailTabs }],
    });

    it('carries shared and source tabs per kind, in declared order', () => {
        const admitted = admitTriageSourceDescriptorV1(withTabs([
            { kind: 'shared', id: 'overview' },
            { kind: 'shared', id: 'files' },
            { kind: 'source', id: 'stack-trace', title: 'Stack trace' },
        ]));

        expect(admitted.ok).toBe(true);
        expect(admitted.ok && admitted.descriptor.kinds[0]?.detailTabs).toEqual([
            { kind: 'shared', id: 'overview' },
            { kind: 'shared', id: 'files' },
            { kind: 'source', id: 'stack-trace', title: 'Stack trace' },
        ]);
    });

    it('carries the row fact that summarizes a tab, on shared and source tabs alike', () => {
        const tabs = [
            { kind: 'shared', id: 'checks', summaryFact: 'example/checks' },
            { kind: 'source', id: 'occurrences', title: 'Occurrences', summaryFact: 'example/events' },
        ];
        const admitted = admitTriageSourceDescriptorV1(withTabs(tabs));
        expect(admitted.ok && admitted.descriptor.kinds[0]?.detailTabs).toEqual(tabs);
        expect(admitTriageSourceDescriptorV1(withTabs([{ kind: 'shared', id: 'checks', summaryFact: '' }])))
            .toEqual({ ok: false, reason: 'invalid' });
    });

    it('carries closed source-declared scroll ownership on shared and source panels', () => {
        const tabs = [
            { kind: 'shared', id: 'activity', scrollOwner: 'list' },
            { kind: 'source', id: 'events', title: 'Events', scrollOwner: 'list' },
            { kind: 'source', id: 'summary', title: 'Summary', scrollOwner: 'scrollArea' },
        ];
        const admitted = admitTriageSourceDescriptorV1(withTabs(tabs));
        expect(admitted.ok && admitted.descriptor.kinds[0]?.detailTabs).toEqual(tabs);
        expect(admitTriageSourceDescriptorV1(withTabs([
            { kind: 'source', id: 'events', title: 'Events', scrollOwner: 'unknown' },
        ]))).toEqual({ ok: false, reason: 'invalid' });
    });

    it('keeps a kind with no declaration as the whole-detail source it was', () => {
        const admitted = admitTriageSourceDescriptorV1(MINIMAL);
        expect(admitted.ok && 'detailTabs' in admitted.descriptor.kinds[0]!).toBe(false);
    });

    it('rejects a shared id the vocabulary does not name', () => {
        expect(admitTriageSourceDescriptorV1(withTabs([{ kind: 'shared', id: 'timeline' }])))
            .toEqual({ ok: false, reason: 'invalid' });
    });

    it('refuses a tab id declared twice, or a source tab that reuses a shared id', () => {
        expect(admitTriageSourceDescriptorV1(withTabs([
            { kind: 'shared', id: 'overview' },
            { kind: 'shared', id: 'overview' },
        ]))).toEqual({ ok: false, reason: 'duplicateDetailTabId' });
        expect(admitTriageSourceDescriptorV1(withTabs([
            { kind: 'shared', id: 'overview' },
            { kind: 'source', id: 'files', title: 'Files' },
        ]))).toEqual({ ok: false, reason: 'duplicateDetailTabId' });
    });
});

describe('the detail header actions panel (r0.42)', () => {
    it('lets a kind declare that its write controls render in the detail header', () => {
        const admitted = admitTriageSourceDescriptorV1({
            ...MINIMAL,
            kinds: [{ ...MINIMAL.kinds[0], detailTabs: [{ kind: 'shared', id: 'overview' }], detailActions: true }],
        });
        expect(admitted.ok && admitted.descriptor.kinds[0]?.detailActions).toBe(true);
    });

    it('reserves the header actions panel id from source tabs', () => {
        expect(admitTriageSourceDescriptorV1({
            ...MINIMAL,
            kinds: [{ ...MINIMAL.kinds[0], detailTabs: [{ kind: 'source', id: 'actions', title: 'Actions' }] }],
        })).toEqual({ ok: false, reason: 'duplicateDetailTabId' });
    });
});


describe('setup-free Account source declaration', () => {
    const declaration = {
        sourceInstanceId: '6d04cf37-0f5b-4ccd-9a4b-370491c8c393', configurationRowId: 'happier-exceptions',
        draft: { v: 1, binding: { purpose: MINIMAL.purpose, source: 'accountData' }, localInstanceKey: 'account',
            keyStability: 'stable', configuration: { v: 1, token: 'account-v1' }, locator: { v: 1, displayLabel: 'Account source' } },
    } as const;
    it('admits an immutable Account instance while retaining old descriptors, and rejects a connection or unstable declaration', () => {
        expect(admitTriageSourceDescriptorV1(MINIMAL).ok).toBe(true);
        expect(admitTriageSourceDescriptorV1({ ...MINIMAL, accountDataInstance: declaration })).toMatchObject({
            ok: true, descriptor: { accountDataInstance: declaration },
        });
        for (const draft of [
            { ...declaration.draft, keyStability: 'unstable' },
            { ...declaration.draft, binding: { purpose: 'another-purpose', source: 'accountData' } },
            { ...declaration.draft, binding: { purpose: MINIMAL.purpose, source: 'native', service: { pluginId: 'happier.example', localId: 'service' } } },
        ]) expect(admitTriageSourceDescriptorV1({ ...MINIMAL, accountDataInstance: { ...declaration, draft } }).ok).toBe(false);
    });
});
