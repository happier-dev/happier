import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MachineEnvironmentV1 } from '@happier-dev/protocol/machines/managed/machineEnvironmentV1';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

installSettingsViewCommonModuleMocks({
  text: async () => vi.importActual<typeof import('@/text')>('@/text'),
});
afterEach(() => standardCleanup());

async function renderSection(
  environment: MachineEnvironmentV1 | undefined,
  onChange: (next: MachineEnvironmentV1 | undefined) => void,
) {
  const { MachineEnvironmentSection } =
    await import('./MachineEnvironmentSection');
  return renderScreen(
    <MachineEnvironmentSection
      testID="env"
      environment={environment}
      editable
      scope={null}
      onChange={onChange}
    />,
  );
}

describe('MachineEnvironmentSection (D53)', () => {
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
    expect(onChange).toHaveBeenLastCalledWith({ setupScript: 'npm ci' });
    await screen.unmount();
  });

  it('stores no environment once every part is cleared, and keeps an uncharacterized stored tool visible as unavailable', async () => {
    const onChange = vi.fn();
    const screen = await renderSection(
      {
        toolchain: { adapterId: 'retired-tool', config: 'x' },
        setupScript: 'echo hi',
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
    expect(onChange).toHaveBeenLastCalledWith({ setupScript: 'echo hi' });
    await screen.unmount();
    const { normalizeMachineEnvironment } =
      await import('./MachineEnvironmentSection');
    expect(
      normalizeMachineEnvironment({
        setupScript: '  \n',
        secretRefs: undefined,
      }),
    ).toBeUndefined();
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
    const { describeMachineEnvironment } =
      await import('./MachineEnvironmentSection');
    const facts = describeMachineEnvironment({
      toolchain: { adapterId: 'mise', config: '[tools]' },
      setupScript: 'apt-get update\n\nnpm ci\n',
      secretRefs: { v: 1, bindings: { NPM_TOKEN: { ref: 'personal-secret' } } },
    });
    expect(facts.map((fact) => fact.id)).toEqual([
      'environment-toolchain',
      'environment-setup',
      'environment-secrets',
    ]);
    expect(facts[0]!.value).toBe('Mise');
    expect(facts[2]!.value).toBe('NPM_TOKEN');
    expect(JSON.stringify(facts)).not.toContain('apt-get');
  });
});
