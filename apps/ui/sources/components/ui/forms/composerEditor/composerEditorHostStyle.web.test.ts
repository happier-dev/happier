import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

describe('resolveComposerEditorHostStyle', () => {
  it('sizes the field at the in-app text size when the caller hands it a style system entry with no readable size', async () => {
    const { lightTheme } = await import('@/theme');
    const { resolveComposerEditorHostStyle } = await import('./composerEditorHostStyle.web');
    const { MULTI_TEXT_INPUT_BASE_FONT_SIZE } = await import('../multiTextInputTypography');
    // A Unistyles entry on web carries its metrics as CSS classes, behind an opaque runtime key: the
    // DOM host cannot read them (QA-LAYOUT V2: the Workflow prompt stayed 16px at 200%).
    const styleSystemEntry = { unistyles_composer: { opaque: true } } as never;
    const atDefault = resolveComposerEditorHostStyle({ theme: lightTheme as never, uiFontScale: 1, textStyle: styleSystemEntry, placeholderInk: undefined });
    const atLarge = resolveComposerEditorHostStyle({ theme: lightTheme as never, uiFontScale: 2, textStyle: styleSystemEntry, placeholderInk: undefined });

    expect(atDefault.fontSize).toBe(MULTI_TEXT_INPUT_BASE_FONT_SIZE);
    expect(atLarge.fontSize).toBe(MULTI_TEXT_INPUT_BASE_FONT_SIZE * 2);
  });

  it('keeps a size the caller declares, scaled', async () => {
    const { lightTheme } = await import('@/theme');
    const { resolveComposerEditorHostStyle } = await import('./composerEditorHostStyle.web');
    const style = resolveComposerEditorHostStyle({ theme: lightTheme as never, uiFontScale: 2, textStyle: { fontSize: 13 }, placeholderInk: undefined });
    expect(style.fontSize).toBe(26);
  });
});
