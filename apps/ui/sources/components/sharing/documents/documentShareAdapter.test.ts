import { describe, expect, it, vi } from 'vitest';

import { createDocumentShareAdapter } from './documentShareAdapter';
import { t } from '@/text';

const base = { artifactId: 'document', grants: [], loading: false, readOnly: false, retryContent: () => {} };

describe('createDocumentShareAdapter', () => {
    it('shares a dashboard as read/edit/admin without offering a refused link', () => {
        const dashboard = createDocumentShareAdapter({ ...base, kind: 'widget-area-layout.v1', linkPath: '/artifacts/dashboard' });
        expect(dashboard.levels.view.label).toBe(t('shareSheet.documents.levels.canRead'));
        expect(dashboard.levels.edit.label).toBe(t('shareSheet.documents.levels.canEdit'));
        expect(dashboard.levels.admin.label).toBe(t('shareSheet.documents.levels.admin'));
        expect(dashboard.levels.view.help).not.toBe(createDocumentShareAdapter({ ...base, kind: null }).levels.view.help);
        expect(dashboard.notes).toHaveLength(1);
        expect(dashboard.linkPath).toBeUndefined();
    });

    it('puts private choices before the roster and only offers producer-admitted repairs', () => {
        const removeChoice = vi.fn();
        const letViewersPick = vi.fn();
        const onExpand = vi.fn();
        const dashboard = createDocumentShareAdapter({ ...base, kind: 'widget-area-layout.v1', privateChoices: [
            { id: 'metric:account', widget: 'Metric', service: 'GitHub', removeChoice, letViewersPick },
            { id: 'readme:account', widget: 'README', service: 'GitHub', removeChoice },
            { id: 'authored:input', widget: 'Authored' },
        ] });
        const leading = dashboard.sections?.({ idPrefix: '', editable: true, onExpand }).leading;
        expect(leading).toHaveLength(1);
        const section = leading![0]!;
        if (section.kind !== 'static') throw new Error('Expected a private-choice section');
        const options = section.options;
        expect(options).toHaveLength(3);
        options[0]!.onSelect?.();
        expect(onExpand).toHaveBeenCalledWith('metric:account');
        expect(options[0]!.expandedContent).toEqual(expect.any(Function));
        expect(options[1]!.expandedContent).toEqual(expect.any(Function));
        expect(options[2]!.disabled).toBe(true);
        expect(options[2]!.expandedContent).toBeUndefined();
        const readonly = dashboard.sections?.({ idPrefix: '', editable: false, onExpand: () => {} }).leading?.[0];
        expect(readonly?.kind === 'static' && readonly.options.every(option => option.disabled)).toBe(true);
    });
    it('gives every ordinary Artifact kind its own recipient meaning, not only workflows, roles and profiles', () => {
        const levels = (kind: string | null) => createDocumentShareAdapter({ ...base, kind }).levels;
        const workflow = levels('workflow-definition.v1');
        for (const kind of [null, 'prompt_doc.v2', 'work-board.v1', 'published.v1']) {
            const view = levels(kind).view;
            expect(view.help, String(kind)).toEqual(expect.any(String));
            expect(view.help).not.toBe(workflow.view.help);
        }
        // A document is read, not "used": its level reads as such, while a workflow keeps "Can use".
        expect(levels(null).view.label).not.toBe(workflow.view.label);
        expect(levels('prompt_doc.v2').view.label).toBe(workflow.view.label);
        // Every kind keeps the same edit and admin meaning.
        expect(levels('work-board.v1').edit).toEqual(workflow.edit);
    });
});
