import { describe, expect, it } from 'vitest';
import { WIDGET_SIZE_POLICY_V1 } from '@happier-dev/protocol/widgets';
import { proposeWidgetSetupDraft } from '@/components/widgets/add/widgetSetupModel';
import { buildWidgetCandidateSetup, widgetProvidedContext, widgetSetupFieldsForCandidate } from './widgetSurfaceSetup';
import type { WidgetCandidate } from '../widgetCatalog';

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
