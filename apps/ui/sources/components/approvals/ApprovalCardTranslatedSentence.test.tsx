import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { preloadTranslations, setPreferredLanguageFromSettings, t } from '@/text';
import { installApprovalCommonModuleMocks } from './approvalsTestHelpers';
installApprovalCommonModuleMocks({ text: () => vi.importActual<typeof import('@/text')>('@/text') });
const { ActionApprovalFieldsCard } = await import('./ActionApprovalFieldsCard');
const { describeApprovalActionFields } = await import('./approvalFieldValues');
const { getActionSpec } = await import('@happier-dev/protocol/actions/actionSpecs');
afterEach(() => { standardCleanup(); setPreferredLanguageFromSettings('en'); });
it('translates a generated consequence sentence in the existing ordinary row', async () => {
    await preloadTranslations('fr');
    setPreferredLanguageFromSettings('fr');
    const presentation = describeApprovalActionFields({ actionId: 'artifact.folder.set',
        actionArgs: getActionSpec('artifact.folder.set').inputSchema.parse({ artifactId: 'notes', folderId: null, expectedRevision: 1 }) });
    const screen = await renderScreen(<ActionApprovalFieldsCard anatomy="page" presentation={presentation} />);
    expect(screen.getTextContent()).toContain(t('approvals.clearsField', { field: 'Folder' }));
    expect(screen.getTextContent()).not.toContain('Clears');
    await screen.unmount();
});
