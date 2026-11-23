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

it('shows the declared document sort label instead of its enum token', async () => {
    await preloadTranslations('fr');
    setPreferredLanguageFromSettings('fr');
    const presentation = describeApprovalActionFields({ actionId: 'artifact.list',
        actionArgs: getActionSpec('artifact.list').inputSchema.parse({ sort: 'updated_desc' }) });
    const screen = await renderScreen(<ActionApprovalFieldsCard anatomy="page" presentation={presentation} />);
    expect(screen.getTextContent()).toContain(t('artifacts.browser.sort.updated_desc'));
    expect(screen.getTextContent()).not.toContain('updated_desc');
    await screen.unmount();
});
