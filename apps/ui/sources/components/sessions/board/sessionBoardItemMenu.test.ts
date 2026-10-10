import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import { describe, expect, it, vi } from 'vitest';

import {
    createSessionSurfaceNoteDocumentV1,
    SessionSurfaceDeclarativeDocumentV1Schema,
} from '@happier-dev/protocol/sessions/board';

import { t } from '@/text';

import { buildSessionBoardItemActions } from './sessionBoardItemMenu';

const item = {
    v: 1 as const,
    title: 'Release plan',
    frame: 'card' as const,
    height: { mode: 'fixed' as const, size: 'compact' as const },
    source: { kind: 'declarative' as const, document: createSessionSurfaceNoteDocumentV1('Body') },
};

describe('buildSessionBoardItemActions', () => {
    it('groups the complete item operation set by content, movement, geometry, and destruction', () => {
        const actions = buildSessionBoardItemActions({
            density: 'full',
            canEdit: true,
            item,
            width: 'medium',
            onReadFull: vi.fn(),
            onEdit: vi.fn(),
            onRename: vi.fn(),
            onMove: vi.fn(),
            moveDestinations: [{ id: 'research', title: 'Research' }],
            onMoveToView: vi.fn(),
            onResize: vi.fn(),
            onSetHeight: vi.fn(),
            onRemove: vi.fn(),
        });

        expect(actions.map((action) => [action.id, action.group?.id])).toEqual([
            ['read-full', 'content'],
            ['edit', 'content'],
            ['rename', 'content'],
            ['move-before', 'movement'],
            ['move-after', 'movement'],
            ['move-view-research', 'movement'],
            ['resize-compact', 'geometry'],
            ['resize-medium', 'geometry'],
            ['resize-wide', 'geometry'],
            ['resize-full', 'geometry'],
            ['height-auto', 'geometry'],
            ['height-compact', 'geometry'],
            ['height-regular', 'geometry'],
            ['height-tall', 'geometry'],
            ['remove', 'destructive'],
        ]);
    });

    // "Board views: Research" was assembled in code from an unrelated label and a
    // hardcoded colon. It is not a phrase any locale authored, it names no verb,
    // and a screen reader reads it as a heading rather than an operation.
    it('names the destination board view through one authored phrase, not a code-joined label', () => {
        const actions = buildSessionBoardItemActions({
            density: 'full',
            canEdit: true,
            item,
            width: 'medium',
            moveDestinations: [{ id: 'research', title: 'Research' }],
            onMoveToView: vi.fn(),
        });

        const destination = actions.find((action) => action.id === 'move-view-research');

        expect(destination?.title).toBe(t('sessionBoard.item.actions.moveToView', { title: 'Research' }));
        expect(destination?.title).not.toContain(`${t('sessionBoard.views.label')}:`);
    });

    it('maps Fit content to automatic height with the nearest semantic fallback, never pixels', () => {
        const onSetHeight = vi.fn();
        const actions = buildSessionBoardItemActions({
            density: 'full',
            canEdit: true,
            item,
            width: 'medium',
            reportedHeight: 432,
            onSetHeight,
        });

        actions.find((action) => action.id === 'height-auto')?.onPress?.();

        expect(onSetHeight).toHaveBeenCalledWith({ mode: 'auto', fallback: 'tall' });
        expect(onSetHeight).not.toHaveBeenCalledWith(expect.objectContaining({ height: expect.any(Number) }));
    });

    it('uses the canonical regular semantic fallback when no reliable measurement exists', () => {
        const onSetHeight = vi.fn();
        const actions = buildSessionBoardItemActions({
            density: 'full',
            canEdit: true,
            item,
            width: 'medium',
            reportedHeight: Number.NaN,
            onSetHeight,
        });

        actions.find((action) => action.id === 'height-auto')?.onPress?.();

        expect(onSetHeight).toHaveBeenCalledWith({ mode: 'auto', fallback: 'regular' });
    });

    it('offers the same real editor for caller-hosted HTML but not installed plugin surfaces', () => {
        const onEdit = vi.fn();
        const hostedActions = buildSessionBoardItemActions({
            density: 'full',
            canEdit: true,
            item: {
                ...item,
                source: { kind: 'hostedHtml', source: artifactHtmlBundleFromBodyV1('<main />') },
            },
            onEdit,
        });
        const installedActions = buildSessionBoardItemActions({
            density: 'full',
            canEdit: true,
            item: {
                ...item,
                source: { kind: 'widget', instance: { v: 1, id: 'instance-1', definition: { kind: 'installed', surface: { pluginId: 'acme.widget', localId: 'status' } }, bindings: {} } },
            },
            onEdit,
        });

        expect(hostedActions.some((action) => action.id === 'edit')).toBe(true);
        expect(installedActions.some((action) => action.id === 'edit')).toBe(false);
    });

    // The Note editor round-trips exactly one declarative shape. An Agent may
    // author any admitted presentational document through the same Board Action,
    // and the editor cannot open that: offering Edit there is a control that does
    // nothing when pressed.
    it('omits Edit for a declarative document the Note editor cannot open', () => {
        const actions = buildSessionBoardItemActions({
            density: 'full',
            canEdit: true,
            item: {
                ...item,
                source: {
                    kind: 'declarative',
                    document: SessionSurfaceDeclarativeDocumentV1Schema.parse({
                        version: 1,
                        root: { kind: 'stack', children: [{ kind: 'text', text: 'Build 42 is green' }] },
                    }),
                },
            },
            onEdit: vi.fn(),
            onReadFull: vi.fn(),
        });

        expect(actions.some((action) => action.id === 'edit')).toBe(false);
        // The item stays fully reachable; only the editor it has no editor for is absent.
        expect(actions.some((action) => action.id === 'read-full')).toBe(true);
    });
    it('offers the shared frame override to editors: Hide frame while the Board uses Card, then the way back', () => {
        const onSetFrameStyle = vi.fn();
        const framed = buildSessionBoardItemActions({
            density: 'full',
            canEdit: true,
            item,
            frame: { surfaceDefault: 'card', override: null, onSet: onSetFrameStyle },
        });
        const toggle = framed.find((action) => action.id === 'frameStyle');
        expect(toggle?.title).toBe(t('widgetFrame.hideFrame'));
        expect(toggle?.group?.id).toBe('geometry');
        expect(framed.some((action) => action.id === 'frameStyleReset')).toBe(false);
        toggle?.onPress?.();
        expect(onSetFrameStyle).toHaveBeenCalledWith('plain');

        const overridden = buildSessionBoardItemActions({
            density: 'full',
            canEdit: true,
            item,
            frame: { surfaceDefault: 'card', override: 'plain', onSet: onSetFrameStyle },
        });
        expect(overridden.find((action) => action.id === 'frameStyle')?.title).toBe(t('widgetFrame.showFrame'));
        overridden.find((action) => action.id === 'frameStyleReset')?.onPress?.();
        expect(onSetFrameStyle).toHaveBeenLastCalledWith(null);
    });

    it('never offers the shared frame override to a viewer who cannot edit the Board', () => {
        const actions = buildSessionBoardItemActions({
            density: 'full',
            canEdit: false,
            item,
            frame: { surfaceDefault: 'card', override: null, onSet: vi.fn() },
        });
        expect(actions.some((action) => action.id.startsWith('frameStyle'))).toBe(false);
    });
});
