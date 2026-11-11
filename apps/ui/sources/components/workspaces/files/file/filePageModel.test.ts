import { describe, expect, it, vi } from 'vitest';
import { resolveFilePageAttribution, resolveFilePageEditControl, resolveFilePageHeaderModel } from './filePageModel';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

const text = { kind: 'code', hasRenderableDiff: true, hasText: true, writeSupported: true };

describe('File page header behaviour model', () => {
    it('names the prompting person only in a collaborative session, through transcript byline naming', () => {
        const actor = { v: 1 as const, serverId: 'home', accountId: 'alice',
            profile: { name: 'Alice Chen', firstName: 'Alice', lastName: 'Chen', username: 'alice', avatarUrl: null } };
        const input = { agentName: 'Agent', requesterActor: actor, viewerScope: { serverId: 'home', accountId: 'bob' }, hasOtherNamedCollaborator: true };
        expect(resolveFilePageAttribution(input)).toEqual({ agentName: 'Agent', requesterName: 'Alice Chen' });
        expect(resolveFilePageAttribution({ ...input, hasOtherNamedCollaborator: false }).requesterName).toBeNull();
        expect(resolveFilePageAttribution({ ...input, viewerScope: actor }).requesterName).toBe('message.accountActorYou');
        expect(resolveFilePageAttribution({ ...input, agentName: null }).requesterName).toBeNull();
    });
    it('projects preview/source for Markdown, SVG and HTML, and deletion only as Changes', () => {
        for (const kind of ['markdown', 'svg', 'html']) {
            expect(resolveFilePageHeaderModel({ ...text, kind }).modes.map(mode => mode.id)).toEqual(['preview', 'source', 'changes']);
        }
        expect(resolveFilePageHeaderModel({ ...text, deleted: true }).modes).toEqual([{ id: 'changes', displayMode: 'diff' }]);
        expect(resolveFilePageHeaderModel({ ...text, hasRenderableDiff: false }).modes).toEqual([{ id: 'view', displayMode: 'file' }]);
    });

    it('lets a plugin own mode/find while text can still enter the built-in editor', () => {
        const plugin = resolveFilePageHeaderModel({ ...text, pluginViewerSelected: true });
        expect(plugin.modes).toEqual([]);
        expect(plugin.findAvailable).toBe(false);
        expect(plugin.editUnavailableReason).toBe(null);
    });

    it('offers Find in a PDF, whose viewer searches its text, but not in other binary kinds', () => {
        expect(resolveFilePageHeaderModel({ ...text, kind: 'pdf', hasText: false }).findAvailable).toBe(true);
        expect(resolveFilePageHeaderModel({ ...text, kind: 'image', hasText: false }).findAvailable).toBe(false);
        expect(resolveFilePageHeaderModel({ ...text, kind: 'pdf', hasText: false, pluginViewerSelected: true }).findAvailable).toBe(false);
    });

    it('does not offer an editor for a partial buffer, even when writes are supported', () => {
        expect(resolveFilePageHeaderModel({ ...text, partial: true }).editUnavailableReason).toBe('partial');
        expect(resolveFilePageHeaderModel({ ...text, hasText: false }).editUnavailableReason).toBe('binary');
    });

    it('keeps one primary Save: quiet while the notice line carries the save, absent while the key row does', () => {
        const editor = { status: 'dirty', canSave: true, refusal: null, onSave: vi.fn(), onDone: vi.fn() } as unknown as
            NonNullable<Parameters<typeof resolveFilePageEditControl>[0]['editor']>;
        const base = { fileEditorEnabled: true, isEditingFile: true, editor };
        expect(resolveFilePageEditControl(base)).toMatchObject({ kind: 'save', primary: true });
        expect(resolveFilePageEditControl({ ...base, machineUnreachable: true })).toMatchObject({ kind: 'save', primary: false });
        expect(resolveFilePageEditControl({ ...base, editor: { ...editor, refusal: { kind: 'unreachable' } } }))
            .toMatchObject({ kind: 'save', primary: false });
        expect(resolveFilePageEditControl({ ...base, editor: { ...editor, refusal: { kind: 'awaitingApproval' } } }))
            .toMatchObject({ kind: 'save', primary: false });
        expect(resolveFilePageEditControl({ ...base, keyRowCarriesSave: true })).toBeNull();
        // Leaving a clean editor stays reachable on a phone.
        expect(resolveFilePageEditControl({ ...base, keyRowCarriesSave: true, editor: { ...editor, status: 'clean' } }))
            .toMatchObject({ kind: 'done' });
    });
});
