import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { MarkdownEditor } from '@happier-dev/plugin-ui';
import { MarkdownCodeEditorField } from '@/components/ui/markdown/editor/MarkdownCodeEditorField';
import { CorePluginUiPresentationScope } from './CorePluginUiPresentationScope';
import { PluginUiPrivateMarkdownEditor } from './PluginUiPrivateMarkdownEditor';

describe('plugin-ui MarkdownEditor renders through the app Markdown editor', () => {
  afterEach(standardCleanup);

  it('mounts the host editor with the plugin value, returns edits, and reseeds on a value it did not emit', async () => {
    const edits: string[] = [];
    function Author(props: Readonly<{ value: string }>) {
      const [value, setValue] = React.useState(props.value);
      React.useEffect(() => setValue(props.value), [props.value]);
      return (
        <MarkdownEditor
          accessibilityLabel="Notes"
          placeholder="Add notes…"
          presentation="document"
          value={value}
          onChange={(next) => {
            edits.push(next);
            setValue(next);
          }}
        />
      );
    }
    const tree = (value: string) => (
      <CorePluginUiPresentationScope>
        <Author value={value} />
      </CorePluginUiPresentationScope>
    );
    const screen = await renderScreen(tree('# Plan'));
    try {
      const field = async () => {
        // The editor graph loads on demand, as the diff viewer's does.
        await vi.waitFor(async () => {
          await flushHookEffects();
          expect(screen.tree.root.findAllByType(PluginUiPrivateMarkdownEditor).length).toBeGreaterThan(0);
        });
        const fields = screen.tree.root.findAllByType(MarkdownCodeEditorField);
        expect(
          fields,
          'the app Markdown editor, not a plugin text field',
        ).toHaveLength(1);
        return fields[0]!;
      };
      const mounted = await field();
      expect(mounted.props.value).toBe('# Plan');
      expect(mounted.props.language).toBe('markdown');
      expect(
        mounted.props.presentation,
        'a document is the page, unframed',
      ).toBe('canvas');
      const firstSeed = mounted.props.resetKey;

      await act(async () => {
        mounted.props.onChange('# Plan\n\n- ship it');
      });
      expect(edits, 'an edit reaches the plugin').toEqual([
        '# Plan\n\n- ship it',
      ]);
      const echoed = await field();
      expect(echoed.props.value).toBe('# Plan\n\n- ship it');
      expect(
        echoed.props.resetKey,
        'its own edit never reseeds the editor',
      ).toBe(firstSeed);

      await screen.update(tree(''));
      await flushHookEffects();
      const cleared = await field();
      expect(cleared.props.value).toBe('');
      expect(
        cleared.props.resetKey,
        'a value the editor did not emit reseeds it',
      ).not.toBe(firstSeed);
    } finally {
      await screen.unmount();
    }
  });
});
