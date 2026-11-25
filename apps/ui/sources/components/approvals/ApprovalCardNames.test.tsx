import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { preloadTranslations, setPreferredLanguageFromSettings } from '@/text';
import { installApprovalCommonModuleMocks } from './approvalsTestHelpers';

installApprovalCommonModuleMocks({ text: () => vi.importActual<typeof import('@/text')>('@/text') });
const { ActionApprovalFieldsCard } = await import('./ActionApprovalFieldsCard');
const { describeApprovalActionFields } = await import('./approvalFieldValues');
const { getActionSpec } = await import('@happier-dev/protocol/actions/actionSpecs');
afterEach(() => { standardCleanup(); setPreferredLanguageFromSettings('en'); });

it.each(['page', 'card'] as const)('keeps unreadable resource identities behind Technical details in %s anatomy', async anatomy => {
    const id = '3d703df7-5a51-4be7-91ec-dc877ae861ab';
    const presentation = describeApprovalActionFields({ actionId: 'artifact.delete', actionArgs: getActionSpec('artifact.delete').inputSchema.parse({ artifactId: id, expectedRevision: { headerVersion: 1, bodyVersion: 1 } }) });
    const screen = await renderScreen(<ActionApprovalFieldsCard anatomy={anatomy} presentation={presentation} />);
    expect(screen.getTextContent()).toContain('Artifact —');
    expect(screen.getTextContent()).not.toContain(id);
    await screen.pressByTestIdAsync(anatomy === 'page' ? 'approvals.technical-details.header' : 'approvals.technical-details');
    expect(screen.getTextContent()).toContain(id);
    await screen.unmount();
});

it('shows only a declared explicit clear, translated, as an ordinary field row', async () => {
    await preloadTranslations('fr');
    setPreferredLanguageFromSettings('fr');
    const fields = (args: unknown) => describeApprovalActionFields({ actionId: 'artifact.folder.set',
        actionArgs: getActionSpec('artifact.folder.set').inputSchema.parse(args) });
    const omitted = fields({ artifactId: 'notes', tags: [], expectedRevision: 1 });
    expect(omitted.rows.some(row => row.path === 'folderId')).toBe(false);
    const cleared = fields({ artifactId: 'notes', folderId: null, expectedRevision: 1 });
    expect(cleared.rows.find(row => row.path === 'folderId')).toMatchObject({ kind: 'value', valueFormat: 'clear' });
    expect(cleared.rows.find(row => row.path === 'folderId')).not.toHaveProperty('technical');
    const screen = await renderScreen(<ActionApprovalFieldsCard anatomy="page" presentation={cleared} />);
    expect(screen.getTextContent()).toContain('Efface');
    expect(screen.getTextContent()).not.toContain('Clears');
    await screen.unmount();
    // This required null chooses the shared preset scope; it clears nothing.
    const selector = describeApprovalActionFields({ actionId: 'updates.batch.start', actionArgs:
        getActionSpec('updates.batch.start').inputSchema.parse({ groupId: null, itemIds: ['update'] }) });
    expect(selector.rows.find(row => row.path === 'groupId')).not.toMatchObject({ valueFormat: 'clear' });
});
