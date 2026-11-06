import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { installAgentInputCommonModuleMocks } from '../agentInputTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installAgentInputCommonModuleMocks();

vi.mock('@/components/ui/text/Text', () => ({
  Text: 'Text',
}));

vi.mock('@/components/sessions/pickers/OptionPickerOverlay', () => ({
  OptionPickerOverlay: (props: Record<string, unknown>) =>
    React.createElement('OptionPickerOverlay', props, null),
}));

import { OptionPickerPaneSlotsContext } from '@/components/sessions/pickers/optionPickerPaneSlots';

describe('AgentInputEngineDetail', () => {
  it('does not render an empty model section when no model content or probe is provided', async () => {
    const { AgentInputEngineDetail } = await import('./AgentInputEngineDetail');

    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<AgentInputEngineDetail />);
    });

    expect(tree?.toJSON()).toBeNull();
  });

  it('keeps the model section mounted while a model probe is active', async () => {
    const { AgentInputEngineDetail } = await import('./AgentInputEngineDetail');

    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <AgentInputEngineDetail
          modelProbe={{ phase: 'loading', onRefresh: () => {} }}
        />,
      );
    });

    expect(tree?.root.findByType('OptionPickerOverlay')).toBeTruthy();
  });

  it('hands the composer apply timing and notes to a model surface that replaces the default one', async () => {
    const { AgentInputEngineDetail } = await import('./AgentInputEngineDetail');
    const { SessionModelApplyTimingContext } = await import('@/components/sessions/modelPicker/SessionModelSourceBrowseHandoff');
    let received: unknown = 'unset';
    function Override() {
      received = React.useContext(SessionModelApplyTimingContext);
      return null;
    }

    await act(async () => {
      renderer.create(
        <AgentInputEngineDetail
          modelContentOverride={<Override />}
          modelApplyTiming="Applies from your next message"
          modelNotes={['Kept for resume']}
        />,
      );
    });

    expect(received).toEqual({ timing: 'Applies from your next message', notes: ['Kept for resume'] });
  });

  // The model picker keeps what the person typed, scrolled and focused while the producer's catalog
  // arrives or is withdrawn: one container topology for the whole life of the open surface.
  it('keeps the model surface mounted and its state while configuration arrives and is withdrawn', async () => {
    const { AgentInputEngineDetail } = await import('./AgentInputEngineDetail');
    const { computeSessionConfigOptionControlsForProvider } = await import('@/sync/domains/sessionControl/configOptionsControl');
    const controls = computeSessionConfigOptionControlsForProvider({
      providerId: 'fx',
      configOptions: [{
        id: 'effort', name: 'effort', type: 'select', currentValue: 'a',
        options: [{ value: 'a', name: 'A' }, { value: 'b', name: 'B' }],
      }],
      hideModelOption: true,
    }) ?? [];
    let mounts = 0;
    let setSearch: (value: string) => void = () => {};
    function Picker() {
      const [search, set] = React.useState('');
      setSearch = set;
      React.useEffect(() => { mounts += 1; }, []);
      // The model surface carries the pane's controls in its own scroll owner.
      const slots = React.useContext(OptionPickerPaneSlotsContext);
      return React.createElement('Picker', { search }, slots?.leading, slots?.trailing);
    }
    const render = (props: Partial<React.ComponentProps<typeof AgentInputEngineDetail>>) => (
      <AgentInputEngineDetail fillAvailableSpace modelContentOverride={<Picker />} {...props} />
    );

    let tree!: ReactTestRenderer;
    await act(async () => { tree = renderer.create(render({})); });
    await act(async () => { setSearch('opus'); });
    const search = () => tree.root.findByType('Picker').props.search;
    expect(search()).toBe('opus');

    await act(async () => { tree.update(render({ configControls: controls, configNotes: ['Provider rejected'] })); });
    expect(controls.length).toBeGreaterThan(0);
    expect(tree.root.findAllByProps({ testID: 'agent-input-config-options-unavailable' }).length).toBeGreaterThan(0);
    expect(search()).toBe('opus');

    await act(async () => { tree.update(render({ configControls: [], configNotes: [] })); });
    expect(search()).toBe('opus');
    expect(mounts).toBe(1);
  });

  it('shows configuration that arrives after nothing was shown without breaking the render', async () => {
    const { AgentInputEngineDetail } = await import('./AgentInputEngineDetail');
    let tree!: ReactTestRenderer;
    await act(async () => { tree = renderer.create(<AgentInputEngineDetail />); });
    expect(tree.toJSON()).toBeNull();
    await act(async () => { tree.update(<AgentInputEngineDetail configNotes={['Provider rejected']} />); });
    expect(tree.root.findAllByProps({ testID: 'agent-input-config-options-unavailable' }).length).toBeGreaterThan(0);
  });
});
