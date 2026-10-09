import * as React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

installSettingsViewCommonModuleMocks();

const { NewBotDraftHeader } = await import('./NewBotDraftHeader');
const { createComposerTextStore } =
  await import('@/components/sessions/agentInput/composerTextStore');
const { t } = await import('@/text');

function texts(root: ReactTestInstance): string[] {
  return root
    .findAll(
      (node) =>
        typeof node.type === 'string' &&
        typeof node.props.children === 'string',
    )
    .map((node) => node.props.children as string);
}

describe('NewBotDraftHeader (b-new, D30)', () => {
  it('keeps an empty name empty, shows the naming hint while naming, and writes typed names through the draft owner', async () => {
    const nameStore = createComposerTextStore('');
    const written: string[] = [];
    const onSessionNameChange = vi.fn((value: string) => {
      written.push(value);
      nameStore.setPrompt(value);
    });
    const screen = await renderScreen(
      <NewBotDraftHeader botCreation={{ nameStore, onSessionNameChange }} />,
    );
    const field = screen.root.find(
      (node) =>
        node.props.testID === 'new-bot-name' &&
        typeof node.props.onChangeText === 'function',
    );
    // Empty means automatic naming: the placeholder is never the value.
    expect(field.props.value).toBe('');
    expect(field.props.placeholder).toBe(t('bots.name.placeholder'));
    expect(texts(screen.root)).toContain(t('bots.create.description'));

    await act(async () => {
      field.props.onFocus();
    });
    expect(texts(screen.root)).toContain(t('bots.name.hint'));
    expect(texts(screen.root)).not.toContain(t('bots.create.description'));

    await act(async () => {
      field.props.onChangeText('Release captain');
    });
    expect(written).toEqual(['Release captain']);
    await act(async () => {
      field.props.onBlur();
    });
    expect(texts(screen.root)).toContain(t('bots.create.description'));
    const settled = screen.root.find(
      (node) =>
        node.props.testID === 'new-bot-name' &&
        typeof node.props.onChangeText === 'function',
    );
    expect(settled.props.value).toBe('Release captain');
  });
});
