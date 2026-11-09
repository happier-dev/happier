import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderSettingsView } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

installSettingsViewCommonModuleMocks({
  reactNative: async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ View: 'View' });
  },
  text: async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
      translate: (key, params) => params?.value ? `${key}: ${params.value}` : key,
    });
  },
});

vi.mock('@/components/ui/lists/ItemGroup', () => ({
  ItemGroup: ({ children, ...props }: any) => React.createElement('ItemGroup', props, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
  Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
  Switch: (props: any) => React.createElement('Switch', props),
}));

describe('VisibleAgentsSettingsGroup', () => {
  it('describes Project Manager-owned idle team assembly without claiming delegated work starts', async () => {
    const { en } = await import('@/text/translations/en');
    expect(en.visibleAgents.assembly.title).toBe('Assemble team on Project Manager assignment');
    expect(en.visibleAgents.assembly.subtitle).toBe(
      'Create idle subsessions from the team template when a Project Manager is assigned or its runner starts. The Project Manager’s runner creates these sessions. Creating or nesting a session does not start delegated work.',
    );
  });

  it('presents only visible team controls and delegates every edit to its settings owner', async () => {
    const onAssemblyEnabledChange = vi.fn();
    const onEditTeamTemplate = vi.fn();
    const { VisibleAgentsSettingsGroup } = await import('./VisibleAgentsSettingsGroup');
    const screen = await renderSettingsView(React.createElement(VisibleAgentsSettingsGroup, {
      assembleTeamOnLeadAssignment: true,
      teamTemplateSummary: 'Reviewer · Worker',
      onAssemblyEnabledChange,
      onEditTeamTemplate,
    }));

    expect(screen.findRowByTitle('visibleAgents.intent.review')).toBeFalsy();
    expect(screen.findRowByTitle('visibleAgents.intent.plan')).toBeFalsy();
    expect(screen.findRowByTitle('visibleAgents.intent.delegate')).toBeFalsy();

    const assemblyRow = screen.findRowByTitle('visibleAgents.assembly.title');
    await React.act(async () => { assemblyRow?.props.onPress?.(); });
    expect(onAssemblyEnabledChange).toHaveBeenCalledWith(false);

    await React.act(async () => {
      screen.findRowByTitle('visibleAgents.teamTemplate.title')?.props.onPress?.();
    });
    expect(onEditTeamTemplate).toHaveBeenCalledOnce();
  });
});
