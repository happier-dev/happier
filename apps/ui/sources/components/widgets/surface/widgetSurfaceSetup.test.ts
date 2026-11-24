import { describe, expect, it } from 'vitest';
import { readBuiltinWidgetDescriptorV1, WIDGET_SIZE_POLICY_V1, type WidgetInstanceV1 } from '@happier-dev/protocol/widgets';
import { resolveEffectiveInputFields } from '@happier-dev/protocol/inputs';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { usageAnalyticsRequestToQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { usageQaAccountingFixture } from '@/dev/testkit/fixtures/usageQaAccountingFixture';
import { usageWidgetSurfaceContext, readUsageWidgetPageContext, readUsageWidgetPageScope } from '@/components/settings/usage/usageWidgetPageContext';
import { describeWidgetSetupRow, proposeWidgetSetupDraft } from '@/components/widgets/add/widgetSetupModel';
import { t } from '@/text';
import { widgetGroupSurfaceContext, buildWidgetCandidateSetup, runAcknowledgedWidgetSetupCommand, widgetProvidedContext, widgetSetupFieldsForCandidate } from './widgetSurfaceSetup';
import type { WidgetCandidate } from '../widgetCatalog';

describe('public-profile snapshot setup', () => {
    it('translates a copied Usage choice to public presentation only, without asking for a private query', () => {
        const descriptor = readBuiltinWidgetDescriptorV1({ kind: 'builtin', id: 'usage_rhythm' })!;
        const candidate: WidgetCandidate = { ...descriptor, pluginName: 'Happier', sharedPluginName: false };
        const setup = buildWidgetCandidateSetup({ candidate, context: {}, audience: 'personal',
            scope: { serverId: 'home', accountId: 'viewer', owner: { kind: 'corePage', pageId: 'public-profile', area: 'main', layoutId: 'minimal' } },
            mode: { kind: 'add', submitLabel: 'Add', copiedInput: { style: 'sky', colourBy: 'agent', metric: 'cost',
                agents: ['private-agent'], period: { relative: '7days' } } }, submit: async () => ({ ok: true }) });
        expect(setup.fields.map(field => field.field.path)).toEqual(['style', 'colourBy']);
        expect(setup.resolve(setup.initial)).toEqual({ status: 'ready', input: { style: 'sky', colourBy: 'intensity' } });
        expect(JSON.stringify(setup.initial)).not.toMatch(/private-agent|cost|7days/);
    });
});

describe('Usage declared inputs on every host', () => {
    const accounting = usageQaAccountingFixture();
    const query = usageAnalyticsRequestToQuery({ dateRange: { startMs: accounting.coverage!.range.startMs }, costMode: 'auto' });
    const copiedInput = { ...readUsageWidgetPageScope(query), period: projectNativeJsonValueForTransport(query.period),
        metric: query.metric, breakdown: query.breakdown };
    const sessionId = accounting.contributions!.find(row => row.sessionId !== null)!.sessionId!;
    const page = usageWidgetSurfaceContext(readUsageWidgetPageContext(readUsageWidgetPageScope(query)), '7days');
    const session = usageWidgetSurfaceContext(readUsageWidgetPageContext(readUsageWidgetPageScope({ ...query, session: sessionId })), '7days', sessionId);
    const filteredPage = usageWidgetSurfaceContext(readUsageWidgetPageContext(readUsageWidgetPageScope({ ...query, session: sessionId })), '7days');
    const contexts = { Usage: page, 'Usage with a Session filter': filteredPage, Home: {}, Project: { slots: { projects: { label: 'This project',
        value: { value: ['qa-project'], label: 'QA project' } } } }, Session: session };
    for (const [host, context] of Object.entries(contexts)) {
        for (const flow of ['add', 'edit', 'copy'] as const) {
            it(`offers Session only on an admitted Session host in ${host} ${flow}`, () => {
                const descriptor = readBuiltinWidgetDescriptorV1({ kind: 'builtin', id: 'usage_daily' })!;
                const candidate: WidgetCandidate = { ...descriptor, pluginName: 'Happier', sharedPluginName: false };
                const instance: WidgetInstanceV1 = { v: 1, id: 'daily', definition: descriptor.definition,
                    bindings: Object.fromEntries(descriptor.inputs!.fields.map(field => [field.path, { kind: 'value' as const,
                        value: copiedInput[field.path as keyof typeof copiedInput] }])) };
                const setup = buildWidgetCandidateSetup({ candidate, context, audience: 'personal',
                    mode: flow === 'edit' ? { kind: 'edit', instance } : { kind: 'add', submitLabel: 'Add',
                        ...(flow === 'copy' ? { copiedInput } : {}) }, submit: async () => ({ ok: true }) });
                const fields = resolveEffectiveInputFields({ inputHints: { fields: setup.fields.map(entry => entry.field) } },
                    setup.optionsContext!(setup.initial).draftInput, { contextSlots: setup.contextSlots });
                expect(fields.some(field => field.path === 'session')).toBe(host === 'Session');
                expect(fields.some(field => field.path === 'breakdown')).toBe(false);
            });
            it(`omits unused Group by from Period summary in ${host} ${flow} while retaining saved query intent`, () => {
                const descriptor = readBuiltinWidgetDescriptorV1({ kind: 'builtin', id: 'usage_period_summary' })!;
                const candidate: WidgetCandidate = { ...descriptor, pluginName: 'Happier', sharedPluginName: false };
                const instance: WidgetInstanceV1 = { v: 1, id: 'summary', definition: descriptor.definition,
                    bindings: Object.fromEntries(Object.entries({ ...copiedInput, breakdown: ['agent'] })
                        .map(([path, value]) => [path, { kind: 'value' as const, value }])) };
                const setup = buildWidgetCandidateSetup({ candidate, context, audience: 'personal',
                    mode: flow === 'edit' ? { kind: 'edit', instance } : { kind: 'add', submitLabel: 'Add',
                        ...(flow === 'copy' ? { copiedInput } : {}) }, submit: async () => ({ ok: true }) });
                expect(setup.fields.some(entry => entry.field.path === 'breakdown')).toBe(false);
                expect(setup.resolve(setup.initial).status).toBe('ready');
                if (flow === 'edit') expect(setup.initial.bindings.breakdown).toEqual({ kind: 'value', value: ['agent'] });
            });
        }
    }
});

it('uses the typed value and declared field labels in a grouped widget’s Edit inputs menu', () => {
    const descriptor = readBuiltinWidgetDescriptorV1({ kind: 'builtin', id: 'usage_period_summary' })!;
    const period = descriptor.inputs!.fields.find(field => field.path === 'period')!;
    const candidate: WidgetCandidate = { ...descriptor, pluginName: 'Usage', sharedPluginName: false, inputSchema: undefined,
        inputs: { fields: [period, { path: 'calendarKey', title: 'Calendar', widget: 'select', contextMode: 'follow' }] } };
    const instance: WidgetInstanceV1 = { v: 1, id: 'summary', definition: descriptor.definition, bindings: {
        period: { kind: 'context', slot: 'period' },
        calendarKey: { kind: 'context', slot: 'calendarKey' },
    } };
    const periodOnly = widgetGroupSurfaceContext({}, {
        period: { kind: 'value', value: { relative: '90days' } },
    }, { fields: [], byChild: new Map(), labels: { period: t('usage.last90Days') } });
    const context = widgetGroupSurfaceContext(periodOnly, {
        calendarKey: { kind: 'value', value: { opaque: true } },
    }, { fields: [], byChild: new Map(), labels: { calendarKey: null } });
    const build = (placed: WidgetInstanceV1, surface = context) => buildWidgetCandidateSetup({
        candidate, context: surface, audience: 'personal', mode: { kind: 'edit', instance: placed }, submit: async () => ({ ok: true }),
    });
    const setup = build(instance);
    expect.soft(setup.fields.map(({ follow }) => follow?.values[0]?.label)).toEqual([t('usage.last90Days'), 'Calendar']);

    const alias = build({ ...instance, bindings: { ...instance.bindings, calendarKey: { kind: 'context', slot: 'period' } } }, { slots: { period: { label: 'This page', value: { value: { relative: '90days' }, label: null }, offered: false } } });
    const row = describeWidgetSetupRow({ entry: alias.fields[1]!, draft: alias.initial,
        resolution: alias.resolve(alias.initial), options: [] });
    expect(row).toMatchObject({ kind: 'follows', valueLabel: 'Calendar' });
});

it.each([true, false])('offers the runtime group alias with or without a same-named page slot (%s)', (includePageSlot) => {
    const field = { path: 'period', title: 'Period', widget: 'text' } as const;
    const candidate: WidgetCandidate = { key: 'alias', title: 'Alias', pluginName: 'Usage', sharedPluginName: false,
        icon: 'squares-four', homeDefault: 'available', target: 'app', inputs: { fields: [field] } };
    const instance: WidgetInstanceV1 = { v: 1, id: 'child', definition: { kind: 'builtin', id: 'usage_period_summary' },
        bindings: { period: { kind: 'context', slot: 'first' } } };
    const group = { first: { kind: 'context', slot: 'second' } } as const;
    const context = widgetGroupSurfaceContext({ slots: {
        ...(includePageSlot ? { first: { label: 'Old slot', value: { value: 'old', label: 'Old value' } } } : {}),
        second: { label: 'Current slot', value: { value: 'current', label: 'Current value' } },
    } }, group, { fields: [{ field, slot: 'first', sessionTarget: false }], byChild: new Map(), labels: {} });
    const setup = buildWidgetCandidateSetup({ candidate, context, audience: 'personal',
        mode: { kind: 'edit', instance }, submit: async () => ({ ok: true }) });
    expect(setup.resolve(setup.initial)).toEqual({ status: 'ready', input: { period: 'current' } });
    expect(setup.fields[0]?.follow).toMatchObject({ slot: 'first', values: [{ value: 'current', label: 'Current value' }] });
});

describe('Widget setup schema defaults', () => {
    const candidate: WidgetCandidate = { key: 'acme.checks/checks', title: 'Checks', pluginName: 'Checks', sharedPluginName: false,
        sizeDeclaration: { sizes: [...WIDGET_SIZE_POLICY_V1.home.sizes], defaultSize: WIDGET_SIZE_POLICY_V1.home.defaultSize },
        icon: 'squares-four', homeDefault: 'available', target: 'app', surface: { pluginId: 'acme.checks', localId: 'checks' },
        inputs: { fields: [{ path: 'filter.limit', title: 'Limit', widget: 'integer', required: true }] },
        inputSchema: { type: 'object', properties: { filter: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, default: 3 } },
            required: ['limit'], additionalProperties: false } }, required: ['filter'], additionalProperties: false } };
    const setup = (input: Partial<Parameters<typeof buildWidgetCandidateSetup>[0]> = {}) => buildWidgetCandidateSetup({
        candidate, audience: 'personal', context: {}, mode: { kind: 'add', submitLabel: 'Add' }, submit: async () => ({ ok: true }), ...input });

    it('proposes the declared nested literal default as a value and resolves it through the binder', () => {
        const created = setup();
        expect(created.initial).toEqual({ bindings: { 'filter.limit': { kind: 'value', value: 3 } } });
        expect(created.resolve(created.initial)).toEqual({ status: 'ready', input: { filter: { limit: 3 } } });
    });

    it('keeps own inputs at their declared values even when the surface offers matching context', () => {
        const ownCandidate = { ...candidate, inputs: { fields: [
            { ...candidate.inputs!.fields[0]!, contextMode: 'own' as const },
        ] } };
        const created = setup({ candidate: ownCandidate,
            context: { slots: { 'filter.limit': { label: 'This page', value: { value: 5, label: 'Five' } } } } });
        expect(created.fields[0]?.follow).toBeUndefined();
        expect(created.initial.bindings['filter.limit']).toEqual({ kind: 'value', value: 3 });
        expect(created.resolve(created.initial)).toEqual({ status: 'ready', input: { filter: { limit: 3 } } });
    });

    it('proposes a declared own semantic default without fabricating missing values or credential pins', () => {
        const typedCandidate = { ...candidate, inputs: { fields: [
            { path: 'repository', title: 'Repository', widget: 'select' as const,
                inputType: { pluginId: 'acme.inputs', localId: 'repository' }, contextMode: 'own' as const },
            { path: 'missing', title: 'Missing', widget: 'text' as const, contextMode: 'own' as const },
            { path: 'connection', title: 'Connection', widget: 'select' as const,
                connectedAccountOptions: true as const, contextMode: 'own' as const },
            { path: 'secret', title: 'Secret', widget: 'secret' as const, contextMode: 'own' as const },
        ] }, inputSchema: { type: 'object' as const, properties: {
            repository: { type: 'string' as const, default: 'happier' },
            connection: { type: 'string' as const, default: 'editor-private' },
            secret: { type: 'string' as const, default: 'private' },
        } } };
        expect(setup({ candidate: typedCandidate }).initial.bindings).toEqual({ repository: { kind: 'value', value: 'happier' } });
    });

    it('uses the declared semantic default as a value when a follow-able field has no offered slot', () => {
        const created = setup({ candidate: { ...candidate, inputs: { fields: [
            { path: 'repository', title: 'Repository', widget: 'select', contextMode: 'follow',
                inputType: { pluginId: 'acme.inputs', localId: 'repository' }, required: true },
        ] }, inputSchema: { type: 'object', properties: { repository: { type: 'string', default: 'happier' } },
            required: ['repository'], additionalProperties: false } } });
        expect(created.initial.bindings).toEqual({ repository: { kind: 'value', value: 'happier' } });
        expect(created.resolve(created.initial)).toEqual({ status: 'ready', input: { repository: 'happier' } });
    });

    it('preserves edit pins and followed context instead of replacing either with a default', () => {
        const edited = setup({ mode: { kind: 'edit', instance: { v: 1, id: 'copy', definition: { kind: 'installed', surface: candidate.surface! },
            bindings: { 'filter.limit': { kind: 'value', value: 8 } } } } });
        expect(edited.initial.bindings['filter.limit']).toEqual({ kind: 'value', value: 8 });
        const followed = setup({ context: { slots: { 'filter.limit': { label: 'This page', value: { value: 5, label: 'Five' } } } } });
        expect(followed.initial.bindings['filter.limit']).toEqual({ kind: 'context', slot: 'filter.limit' });
        expect(followed.resolve(followed.initial)).toEqual({ status: 'ready', input: { filter: { limit: 5 } } });
        const viewer = setup({ audience: 'shared', candidate: { ...candidate,
            inputs: { fields: [{ path: 'connection', title: 'Connection', widget: 'select', connectedAccountOptions: true }] },
            connectedAccountPurposeBindings: [{ path: 'connection', purpose: 'metrics-read', consumer: candidate.surface! }],
            inputSchema: { type: 'object', properties: { connection: { type: 'string', default: 'not-a-viewer-connection' } } },
        } });
        expect(viewer.initial.bindings).toEqual({ connection: { kind: 'viewer', purpose: 'metrics-read' } });
    });

    it('projects declaration defaults into Edit while retaining saved array-valued single choices and missing followed slots', () => {
        const own = { ...candidate, inputs: { fields: [
            { path: 'breakdown', title: 'Group by', widget: 'select' as const, contextMode: 'own' as const },
            { path: 'period', title: 'Period', widget: 'select' as const, contextMode: 'follow' as const },
        ] }, inputSchema: { type: 'object' as const, properties: {
            breakdown: { type: 'array' as const, items: { type: 'string' as const }, default: ['agent'] },
            period: { type: 'object' as const, default: {} },
        } } };
        const instance = { v: 1 as const, id: 'copy', definition: { kind: 'installed' as const, surface: candidate.surface! },
            bindings: { period: { kind: 'context' as const, slot: 'period' } } };
        const edited = setup({ candidate: own, mode: { kind: 'edit', instance } });
        expect(edited.initial.bindings.breakdown).toEqual({ kind: 'value', value: ['agent'] });
        expect(edited.resolve(edited.initial).status).toBe('selection_required');
        const saved = setup({ candidate: own, mode: { kind: 'edit', instance: { ...instance, bindings: {
            breakdown: { kind: 'value', value: ['model', 'source'] },
        } } } });
        expect(saved.initial.bindings.breakdown).toEqual({ kind: 'value', value: ['model', 'source'] });
    });

    it('keeps an invalid declared default invalid rather than admitting or substituting it', () => {
        const invalid = setup({ candidate: { ...candidate, inputSchema: { type: 'object', properties: {
            filter: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, default: 0 } }, required: ['limit'] },
        }, required: ['filter'] } } });
        expect(invalid.initial.bindings['filter.limit']).toEqual({ kind: 'value', value: 0 });
        expect(invalid.resolve(invalid.initial).status).toBe('invalid');
    });
});

describe('Widget setup declared viewer purpose', () => {
    it('uses the actual purpose declaration and never invents one from a field path', () => {
        const inputs = { fields: [{ path: 'connection', title: 'Connection', widget: 'select' as const, connectedAccountOptions: true as const }] };
        expect(widgetSetupFieldsForCandidate({ inputs, connectedAccountPurposeBindings: [{ path: 'connection', purpose: 'metrics-read', consumer: { pluginId: 'acme.metrics', localId: 'metrics' } }] }, {}, 'shared'))
            .toMatchObject([{ viewer: { purpose: 'metrics-read' } }]);
        expect(widgetSetupFieldsForCandidate({ inputs }, {}, 'shared')[0]?.viewer).toBeUndefined();
        expect(widgetSetupFieldsForCandidate({ inputs, connectedAccountPurposeBindings: [{ path: 'other', purpose: 'metrics-read', consumer: { pluginId: 'acme.metrics', localId: 'metrics' } }] }, {}, 'shared')[0]?.viewer).toBeUndefined();
    });
});

describe('Widget setup page context', () => {
    const inputs = { fields: [
        { path: 'repository', title: 'Repository', widget: 'text' as const, required: true },
        { path: 'branch', title: 'Branch', widget: 'text' as const },
    ] };
    const context = { slots: { repository: { label: 'This page', value: { value: 'happier', label: 'happier' } } } };

    it('offers the ambient Session through the declared host Session type at its own field path', () => {
        const fields = widgetSetupFieldsForCandidate({ inputs: { fields: [
            { path: 'source', title: 'Session', widget: 'json', inputType: { hostType: 'session' } },
        ] } }, { session: { ref: { serverId: 'home', sessionId: 'A' }, label: 'A' } }, 'personal');
        expect(fields[0]?.follow).toEqual({ slot: 'session', label: expect.any(String),
            values: [{ value: { serverId: 'home', sessionId: 'A' }, label: 'A' }] });
    });

    it('offers a page slot as the follow for the input it names, and pins every other input', () => {
        const fields = widgetSetupFieldsForCandidate({ inputs }, context, 'personal');
        expect(fields[0]?.follow).toEqual({ slot: 'repository', label: 'This page', values: [{ value: 'happier', label: 'happier' }] });
        expect(fields[1]?.follow).toBeUndefined();
        expect(widgetProvidedContext(context)).toEqual({ repository: ['happier'] });
    });

    it('does not offer the ambient Session to a declared own Session field', () => {
        const ownInputs = { fields: [{ path: 'session', title: 'Session', widget: 'json' as const, contextMode: 'own' as const }] };
        const fields = widgetSetupFieldsForCandidate({ inputs: ownInputs, sessionInputPath: 'session' },
            { session: { ref: { serverId: 'home', sessionId: 'A' }, label: 'A' } }, 'personal');
        expect(fields[0]?.follow).toBeUndefined();
    });

    it('starts a fresh copy following the page, and a changed page value reaches only followers', () => {
        const fields = widgetSetupFieldsForCandidate({ inputs }, context, 'personal');
        const draft = proposeWidgetSetupDraft(fields);
        expect(draft.bindings.repository).toEqual({ kind: 'context', slot: 'repository' });
        const changed = { slots: { repository: { label: 'This page', value: { value: 'website', label: 'website' } } } };
        expect(widgetProvidedContext(changed)).toEqual({ repository: ['website'] });
    });

    it('leaves a slot the page does not provide unfollowed, so the input is asked for', () => {
        const unavailable = { slots: { repository: { label: 'This page', value: null } } };
        expect(widgetSetupFieldsForCandidate({ inputs }, unavailable, 'personal')[0]?.follow).toBeUndefined();
        expect(widgetProvidedContext(unavailable)).toEqual({});
    });
});

describe('Acknowledged widget setup command', () => {
    const fallback = 'Couldn’t add it. Try again.';

    it('settles applied and waiting-for-approval writes as the step finishing', async () => {
        expect(await runAcknowledgedWidgetSetupCommand(async () => ({ kind: 'applied' }), fallback)).toEqual({ ok: true });
        expect(await runAcknowledgedWidgetSetupCommand(async () => ({ kind: 'approvalPending' }), fallback)).toEqual({ ok: true, approvalPending: true });
    });

    it('keeps the reason of a returned typed refusal through the one failure presenter', async () => {
        const invalid = await runAcknowledgedWidgetSetupCommand(async () => ({ kind: 'refused', errorCode: 'widget_inputs_invalid' }), fallback);
        expect(invalid).toEqual({ ok: false, message: t('widgetAdd.refusals.inputsInvalid') });
        const unavailable = await runAcknowledgedWidgetSetupCommand(async () => ({ kind: 'refused', errorCode: 'widget_area_unavailable' }), fallback);
        expect(unavailable).toEqual({ ok: false, message: t('widgetAdd.refusals.areaUnavailable') });
        // The presenter already owns reachability copy; a returned refusal gets it too.
        const unreachable = await runAcknowledgedWidgetSetupCommand(async () => ({ kind: 'refused', errorCode: 'server_unreachable' }), fallback);
        expect(unreachable.ok === false && unreachable.message).toBe(t('settingsPlugins.targetSelection.unreachableThisHome'));
    });

    it('keeps the transient fallback for an unknown refusal or a thrown unmapped failure, and never shows a raw code', async () => {
        expect(await runAcknowledgedWidgetSetupCommand(async () => ({ kind: 'refused', errorCode: 'some_unmapped_code' }), fallback)).toEqual({ ok: false, message: fallback });
        expect(await runAcknowledgedWidgetSetupCommand(async () => ({ kind: 'refused' }), fallback)).toEqual({ ok: false, message: fallback });
        expect(await runAcknowledgedWidgetSetupCommand(async () => { throw new Error('boom'); }, fallback)).toEqual({ ok: false, message: fallback });
        expect(await runAcknowledgedWidgetSetupCommand(async () => null, fallback)).toEqual({ ok: false, message: fallback });
    });
});
