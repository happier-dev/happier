import * as React from 'react';
import { expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

installSettingsViewCommonModuleMocks({ storage: importOriginal => importOriginal() });

it('keeps Save directly available in phone navigation and in the page after widening', async () => {
    const { PromptEditorHeader } = await import('./PromptEditorHeader');
    const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
    const save = vi.fn();
    const render = (phone: boolean) => (
        <DestinationInstanceHost tabId="prompt" ref={{ kind: 'settings', params: {} }}
            pathname="/settings/prompts" focused visible phone={phone}
            navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
            <PromptEditorHeader testID="prompt-header" mark="file" title="Review changes"
                description="Instructions for a review." saveTestID="prompt-save" saveDisabled={false}
                onSave={save} menuActions={[]} />
        </DestinationInstanceHost>
    );
    const screen = await renderScreen(render(true));
    expect(screen.findHostByTestId('prompt-save')).not.toBeNull();
    await screen.pressByTestIdAsync('prompt-save');
    expect(save).toHaveBeenCalledOnce();
    await screen.update(render(false));
    expect(screen.findHostByTestId('workspace-destination-header')).toBeNull();
    expect(screen.findHostByTestId('prompt-save')).not.toBeNull();
    await screen.pressByTestIdAsync('prompt-save');
    expect(save).toHaveBeenCalledTimes(2);
});
