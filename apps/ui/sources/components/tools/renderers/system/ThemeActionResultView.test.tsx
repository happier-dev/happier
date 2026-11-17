import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { TranscriptListShell } from '@/components/sessions/transcript/viewport/shell/TranscriptListShell';
import { resolveConversationTranscriptListShellFrame } from '@/components/sessions/transcript/viewport/shell/transcriptListShellCapabilities';
import { createWebDomScrollObservation } from '@/components/sessions/transcript/viewport/driver/webDomObservation';

// The external recycler mounts the real transcript header and its nested Collection.
vi.mock('@legendapp/list/react-native', async () =>
  (await import('@/dev/testkit/mocks/legendList')).createLegendListModuleMock({ renderItems: true, renderItemLimit: 12 }),
);

vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
);
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);

const { ThemeActionResultView } = await import('./ThemeActionResultView');
type Props = import('./themeActionResultViewTypes').ThemeActionResultViewProps;

const MINIATURE = {
  mode: 'light',
  canvas: '#EFE8DA',
  raised: '#FAF6EE',
  text: '#2A251E',
  mutedText: '#6E6557',
  accent: '#9C5A2E',
  border: '#E0D8C8',
  radius: 'round',
} as const;

function props(overrides: Partial<Props> = {}): Props {
  return {
    theme: {
      name: 'Notebook',
      mode: 'light',
      miniature: MINIATURE,
      created: true,
    },
    phase: { kind: 'trying' },
    busy: null,
    here: 'this Mac',
    onKeep: vi.fn(),
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    onRetry: vi.fn(),
    onTryOption: vi.fn(),
    onEdit: vi.fn(),
    onUseOtherDevices: vi.fn(),
    testID: 'card',
    ...overrides,
  };
}

const has = (screen: Awaited<ReturnType<typeof renderScreen>>, id: string) =>
  screen.tree.findAll((node) => node.props?.testID === id).length > 0;

function renderResultInTranscript(input: Props) {
  return renderScreen(<TranscriptListShell<{ id: string }>
    data={[{ id: 'theme-result' }]} dataKey="theme-options"
    keyExtractor={item => item.id} renderItem={() => null}
    frame={resolveConversationTranscriptListShellFrame({ platformOS: 'web' })}
    webDomObservation={createWebDomScrollObservation()}
    header={<ThemeActionResultView {...input} />}
  />);
}

describe('ThemeActionResultView', () => {
  it('windows device failure records in the transcript without dropping outcomes', async () => {
    const screen = await renderResultInTranscript(props({ phase: { kind: 'kept' }, distribution: {
      applied: [], failed: Array.from({ length: 200 }, (_, index) => ({ label: `Failed-device-${index}`, reason: 'failed' as const })),
    } }));
    const failures = screen.tree.findAll(node => typeof node.type === 'string'
      && typeof node.props.children === 'string' && /Failed-device-\d+/.test(node.props.children));
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.length).toBeLessThan(200);
    console.info('[theme-window-cost] device failures', { source: 200, mounted: failures.length });
    await screen.unmount();
  });

  it('windows a data-sized set of proposed themes without losing selection or the try operation', async () => {
    const input = props({ options: Array.from({ length: 200 }, (_, index) => ({
      key: `choice-${index}`, name: `Choice ${index}`, description: 'Proposal', miniature: MINIATURE,
    })), currentOptionKey: 'choice-0' });
    const screen = await renderResultInTranscript(input);
    await act(async () => {
      for (const node of screen.tree.findAll(node => typeof node.type === 'string'
        && node.props.role === 'radiogroup' && typeof node.props.onLayout === 'function')) {
        node.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 960, height: 600 } } });
      }
    });
    const choices = screen.tree.findAll(node => typeof node.type === 'string'
      && typeof node.props.testID === 'string' && /^card:option:choice-\d+$/.test(node.props.testID));
    expect(choices.length).toBeGreaterThan(0);
    expect(choices.length).toBeLessThan(200);
    console.info('[theme-window-cost] transcript', { source: input.options!.length, mounted: choices.length });
    const next = screen.tree.findAll(node => node.props.testID === 'card:option:choice-1' && typeof node.props.onPress === 'function')[0];
    await pressTestInstanceAsync(next!);
    expect(input.onTryOption).toHaveBeenCalledWith('choice-1');
    expect(input.onTryOption).toHaveBeenCalledTimes(1);
    await screen.unmount();
  });

  it('shows supported layout changes in B4 even when the palette and radius are unchanged', async () => {
    const { prepareThemeCss } = await import('@/theme/css/prepareThemeCss');
    const { ThemePalettePreview } = await import('@/components/settings/appearance/ThemeModePreview');
    const before = prepareThemeCss('[data-surface="composer"] { height: 12px; }').light;
    const after = prepareThemeCss('[data-surface="composer"] { height: 28px; }').light;
    const screen = await renderScreen(<ThemeActionResultView {...props({
      before: MINIATURE,
      beforeSurfaceStyles: before,
      theme: { ...props().theme, surfaceStyles: after },
    })} />);
    const faces = screen.tree.findAllByType(ThemePalettePreview);
    // The host renderer has no layout engine: inspect final layout inputs of the
    // rendered composers after the real compiler and card composition.
    const composerHeights = faces.map(face => face.findAll(node => {
      const style = Array.isArray(node.props.style) ? Object.assign({}, ...node.props.style) : node.props.style;
      return style?.position === 'absolute' && style?.bottom === '6%';
    }).map(node => {
      const style = Array.isArray(node.props.style) ? Object.assign({}, ...node.props.style) : node.props.style;
      return style.height;
    }).at(-1));
    expect(composerHeights).toEqual([12, 28]);
    await screen.unmount();
  });

  it('offers Keep and Undo while trying, and other devices only after Keep (try first, finding 2)', async () => {
    const trying = props();
    const screen = await renderScreen(<ThemeActionResultView {...trying} />);
    expect(has(screen, 'card:keep')).toBe(true);
    expect(has(screen, 'card:undo')).toBe(true);
    expect(
      has(screen, 'card:devices'),
      'an unsaved try is never distributed',
    ).toBe(false);
    await pressTestInstanceAsync(
      screen.tree.findAll((node) => node.props?.testID === 'card:keep')[0]!,
    );
    expect(trying.onKeep).toHaveBeenCalledTimes(1);
    await screen.unmount();

    const kept = await renderScreen(
      <ThemeActionResultView {...props({ phase: { kind: 'kept' } })} />,
    );
    expect(has(kept, 'card:keep'), 'Keep leaves once the theme is kept').toBe(
      false,
    );
    expect(has(kept, 'card:devices')).toBe(true);
    await kept.unmount();
  });

  it('shows a failure with its typed code and a retry, never a generic outcome (P02)', async () => {
    const failed = props({
      phase: {
        kind: 'failed',
        operation: 'keep',
        code: 'theme_undo_handle_unknown',
      },
    });
    const screen = await renderScreen(<ThemeActionResultView {...failed} />);
    const code = screen.tree.findAll(
      (node) => node.props?.testID === 'card:code',
    )[0];
    expect(code?.props.children).toBe('theme_undo_handle_unknown');
    expect(has(screen, 'card:retry')).toBe(true);
    await screen.unmount();
  });

  it('offers Redo after Undo, and only the facts the result carries', async () => {
    const screen = await renderScreen(
      <ThemeActionResultView
        {...props({ phase: { kind: 'undone', restoredName: 'Happier' } })}
      />,
    );
    expect(has(screen, 'card:redo')).toBe(true);
    expect(has(screen, 'card:coverage')).toBe(false);
    expect(has(screen, 'card:hides')).toBe(false);
    await screen.unmount();
    const reshaped = await renderScreen(
      <ThemeActionResultView
        {...props({
          coverage: { total: 14, native: 11, webOnly: 3 },
          hides: ['sidebar'],
          onRevealWebOnly: vi.fn(),
        })}
      />,
    );
    expect(has(reshaped, 'card:coverage')).toBe(true);
    expect(has(reshaped, 'card:which')).toBe(true);
    expect(has(reshaped, 'card:hides')).toBe(true);
    await reshaped.unmount();
  });
});
