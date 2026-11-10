import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MachinePresetItemV1Schema, type MachineSetupV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

installSettingsViewCommonModuleMocks({
  text: async () => vi.importActual<typeof import('@/text')>('@/text'),
});
afterEach(() => standardCleanup());

// Load the real component after boundary mocks, outside any render's act lifetime.
const { MachineSetupSection } = await import('./MachineSetupSection');
const { MachineSetupContents } = await import('./MachineSetupContents');

async function renderSection(
  setup: MachineSetupV1 | undefined,
  onChange: (next: MachineSetupV1 | undefined) => void,
) {
  return renderScreen(
    <MachineSetupSection
      testID="env"
      setup={setup}
      editable
      scope={null}
      onChange={onChange}
    />,
  );
}

describe('MachineSetupSection (D53)', () => {
  it.each(['', ' \r\n', undefined])('preserves retained script presence and bytes while another field is edited (%j)', async body => {
    const setup: MachineSetupV1 = body === undefined ? {} : { scripts: [{ body }] };
    const onChange = vi.fn();
    const screen = await renderSection(setup, onChange);
    const tools = screen.tree.findAll(node =>
      node.props?.testIDPrefix === 'env.toolchain' && Array.isArray(node.props.options))[0]!;
    await act(async () => tools.props.onChange('mise'));
    expect(onChange).toHaveBeenLastCalledWith({ ...setup, toolchain: { adapterId: 'mise', config: '' } });
    await screen.unmount();
  });

  it('preserves ordered setup and script metadata when editing an existing field', async () => {
    const setup: MachineSetupV1 = {
      items: [{ kind: 'softwareRecipe', selection: {
        ref: { pluginId: 'acme.tools', recipeId: 'editor', revision: '1' }, inputs: {},
      } }],
      scripts: [{ body: 'echo ready\r\n', affects: { services: ['editor'] },
        check: { executable: 'test', args: ['-f', '/ready'], unsatisfiedExitCodes: [1] } }],
    };
    const onChange = vi.fn();
    const screen = await renderSection(setup, onChange);
    const tools = screen.tree.findAll(node =>
      node.props?.testIDPrefix === 'env.toolchain' && Array.isArray(node.props.options))[0]!;
    await act(async () => tools.props.onChange('mise'));
    expect(onChange).toHaveBeenLastCalledWith({
      ...setup, toolchain: { adapterId: 'mise', config: '' },
    });
    await screen.unmount();
  });

  it('offers the characterized tools from the protocol catalog and writes the preset environment the owner stores', async () => {
    const onChange = vi.fn();
    const screen = await renderSection(undefined, onChange);
    const tools = screen.tree.findAll(
      (node) =>
        node.props?.testIDPrefix === 'env.toolchain' &&
        Array.isArray(node.props.options),
    )[0]!;
    expect(
      tools.props.options.map((option: { id: string }) => option.id),
    ).toEqual(['none', 'mise']);
    expect(tools.props.value).toBe('none');
    // Nothing to configure until a tool is chosen.
    expect(
      screen.tree.findAll(
        (node) => node.props?.testID === 'env.toolchain-config',
      ),
    ).toHaveLength(0);
    await act(async () => tools.props.onChange('mise'));
    expect(onChange).toHaveBeenLastCalledWith({
      toolchain: { adapterId: 'mise', config: '' },
    });
    const script = screen.tree.findAll(
      (node) =>
        node.props?.testID === 'env.setup.input' &&
        typeof node.props.onChangeText === 'function',
    )[0]!;
    await act(async () => script.props.onChangeText('npm ci'));
    expect(onChange).toHaveBeenLastCalledWith({ scripts: [{ body: 'npm ci' }] });
    await screen.unmount();
  });

  it('stores no environment once every part is cleared, and keeps an uncharacterized stored tool visible as unavailable', async () => {
    const onChange = vi.fn();
    const screen = await renderSection(
      {
        toolchain: { adapterId: 'retired-tool', config: 'x' },
        scripts: [{ body: 'echo hi' }],
      },
      onChange,
    );
    const tools = screen.tree.findAll(
      (node) =>
        node.props?.testIDPrefix === 'env.toolchain' &&
        Array.isArray(node.props.options),
    )[0]!;
    expect(
      tools.props.options.find(
        (option: { id: string }) => option.id === 'retired-tool',
      )?.unavailableReason,
    ).toBeTruthy();
    expect(
      screen.tree.findAll(
        (node) => node.props?.testID === 'env.toolchain-config',
      ).length,
    ).toBeGreaterThan(0);
    await act(async () => tools.props.onChange('none'));
    expect(onChange).toHaveBeenLastCalledWith({ scripts: [{ body: 'echo hi' }] });
    await screen.unmount();
    const { normalizeMachineSetup } =
      await import('./MachineSetupSection');
    expect(
      normalizeMachineSetup({
        scripts: [{ body: '  \n' }],
        secretRefs: undefined,
      }),
    ).toEqual({ scripts: [{ body: '  \n' }] });
    expect(normalizeMachineSetup({})).toBeUndefined();
  });

  it('edits the ordered scripts in place: every script shows in order, edits keep the others and their metadata', async () => {
    const first = { body: 'echo first\r\n', affects: 'dockerEngine' as const };
    const onChange = vi.fn();
    const screen = await renderSection({ scripts: [first, { body: 'echo second' }] }, onChange);
    const input = (testID: string) => screen.tree.findAll(
      (node) => node.props?.testID === testID && typeof node.props.onChangeText === 'function',
    )[0];
    expect(input('env.setup.input')?.props.value).toBe('echo first\r\n');
    expect(input('env.setup.input.1')?.props.value).toBe('echo second');
    await act(async () => input('env.setup.input.1')!.props.onChangeText('echo changed'));
    expect(onChange).toHaveBeenLastCalledWith({ scripts: [first, { body: 'echo changed' }] });
    // Clearing a script keeps its place; only Remove takes it out.
    await act(async () => input('env.setup.input')!.props.onChangeText(''));
    expect(onChange).toHaveBeenLastCalledWith({ scripts: [{ ...first, body: '' }, { body: 'echo second' }] });
    const press = (testID: string) => screen.tree.findAll(
      (node) => node.props?.testID === testID && typeof node.props.onPress === 'function',
    )[0]!.props.onPress();
    await act(async () => press('env.setup.remove.0'));
    expect(onChange).toHaveBeenLastCalledWith({ scripts: [{ body: 'echo second' }] });
    await act(async () => press('env.setup.add'));
    expect(onChange).toHaveBeenLastCalledWith({ scripts: [first, { body: 'echo second' }, { body: '' }] });
    await screen.unmount();
  });

  it('adds a secret in one inline row: the name shows its rule as it is typed, and choosing a saved secret binds it', async () => {
    const onChange = vi.fn();
    const { Modal } = await import('@/modal');
    const prompt = vi.spyOn(Modal, 'prompt');
    const screen = await renderSection(undefined, onChange);
    const nameField = () => screen.tree.findAll(
      (node) => node.props?.testID === 'env.add-secret.name' && typeof node.props.onChangeText === 'function',
    )[0]!;
    const secretSelect = () => screen.tree.findAll(
      (node) => node.props?.testID === 'env.add-secret.secret' && typeof node.props.onSelect === 'function',
    )[0]!;
    await act(async () => nameField().props.onChangeText('npm-token'));
    // Typed in place, upper-cased, and refused inline while it breaks the rule.
    expect(nameField().props.value).toBe('NPM-TOKEN');
    expect(nameField().props.error).toBeTruthy();
    await act(async () => secretSelect().props.onSelect('saved-secret-1'));
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => nameField().props.onChangeText('npm_token'));
    expect(nameField().props.error).toBeFalsy();
    await act(async () => secretSelect().props.onSelect('saved-secret-1'));
    expect(onChange).toHaveBeenLastCalledWith({
      secretRefs: { v: 1, bindings: { NPM_TOKEN: { ref: 'saved-secret-1' } } },
    });
    // The row is ready for the next one, and no dialog chain was involved.
    expect(nameField().props.value).toBe('');
    expect(prompt).not.toHaveBeenCalled();
    await screen.unmount();
  });

  it('summarizes the environment for the receipt without showing the script or secret values', async () => {
    const { describeMachineSetup } =
      await import('./MachineSetupSection');
    const facts = describeMachineSetup({
      toolchain: { adapterId: 'mise', config: '[tools]' },
      scripts: [{ body: 'apt-get update\n\nnpm ci\n' }],
      secretRefs: { v: 1, bindings: { NPM_TOKEN: { ref: 'personal-secret' } } },
    });
    expect(facts.map((fact) => fact.id)).toEqual([
      'setup-toolchain',
      'setup-script',
      'setup-secrets',
    ]);
    expect(facts[0]!.value).toBe('Mise');
    expect(facts[2]!.value).toBe('NPM_TOKEN');
    expect(JSON.stringify(facts)).not.toContain('apt-get');
  });

  it('reads what a preset sets up by kind in apply order, with the script commands closing Setup', async () => {
    const setup: MachineSetupV1 = {
      items: [
        MachinePresetItemV1Schema.parse({ kind: 'app', definition: { name: 'Status page', project: { kind: 'create' },
          definition: { from: 'compose', document: 'services:\n  app:\n    image: example/app:1\n', profiles: [], services: ['app'] },
          bindings: [] } }),
        { kind: 'softwareRecipe', selection: { ref: { pluginId: 'acme.tools', recipeId: 'node', revision: '1' }, inputs: {} } },
      ],
      scripts: [{ body: 'npm install -g pnpm' }],
    };
    const screen = await renderScreen(<MachineSetupContents testID="sets" setup={setup} scope={null} />);
    const groups = screen.tree.findAll(node => typeof node.props?.testID === 'string'
      && /^sets\.(setupRecipe|softwareRecipe|app)$/.test(node.props.testID) && node.props.title !== undefined)
      .map(node => node.props.testID as string);
    expect([...new Set(groups)]).toEqual(['sets.setupRecipe', 'sets.softwareRecipe', 'sets.app']);
    expect(screen.getTextContent()).toContain('$ npm install -g pnpm');
    await screen.unmount();
    // Nothing set up and nothing to edit: the section isn't drawn.
    const empty = await renderScreen(<MachineSetupContents testID="sets" setup={undefined} scope={null} />);
    expect(empty.tree.findAll(node => node.props?.testID === 'sets' && node.props.title !== undefined)).toHaveLength(0);
    await empty.unmount();
  });
});
