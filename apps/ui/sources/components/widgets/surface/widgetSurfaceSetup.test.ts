import { describe, expect, it } from 'vitest';
import { proposeWidgetSetupDraft } from '@/components/widgets/add/widgetSetupModel';
import { widgetProvidedContext, widgetSetupFieldsForCandidate } from './widgetSurfaceSetup';

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

    it('offers a page slot as the follow for the input it names, and pins every other input', () => {
        const fields = widgetSetupFieldsForCandidate({ inputs }, context, 'personal');
        expect(fields[0]?.follow).toEqual({ slot: 'repository', label: 'This page', values: [{ value: 'happier', label: 'happier' }] });
        expect(fields[1]?.follow).toBeUndefined();
        expect(widgetProvidedContext(context)).toEqual({ repository: ['happier'] });
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
