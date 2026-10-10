import { act, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { HappierUiEnvironmentProvider } from '../../environment/context.js';
import { projectHappierUiEnvironment } from '../../environment/projectEnvironment.js';
import * as authorBarrel from '../../index.public.js';
import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import {
  createSurfaceContext,
  SURFACE_THEME_FIXTURE,
} from '../../surfaceFixture.testSupport.js';

/**
 * The Work primitives as a plugin author reaches them: from the public author barrel, inside a
 * mounted surface's environment, with no Happier core host.
 */
const {
  HAPPIER_WORK_STATUS_BUCKETS,
  HappierWorkMapView,
  HappierWorkSection,
  HappierWorkSummary,
  buildHappierWorkMap,
  resolveHappierWorkStatusBucketLabel,
  resolveHappierWorkTheme,
} = authorBarrel;

function inSurface(
  children: ReactNode,
  translations: Readonly<Record<string, string>> = {},
) {
  return (
    <HappierUiEnvironmentProvider
      environment={projectHappierUiEnvironment(
        createSurfaceContext({ translations }),
      )}
    >
      {children}
    </HappierUiEnvironmentProvider>
  );
}

function byTestId(root: Element, testID: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
}

const ATTENTION = SURFACE_THEME_FIXTURE.colors.attention;

describe('Work primitives for plugin authors', () => {
  it('keeps an independent accessory outside the selected disclosure button', () => {
    const open = vi.fn();
    const dismiss = vi.fn();
    const mounted = mountThroughReactNativeWeb(inSurface(
      <authorBarrel.HappierWorkRowShell testID="work-row" accessibilityLabel="Review work"
        selected expanded onPress={open}
        trailingAccessory={<button data-testid="dismiss" onClick={dismiss}>Dismiss</button>}>
        <span>Review work</span>
      </authorBarrel.HappierWorkRowShell>,
    ));
    try {
      const row = byTestId(mounted.container, 'work-row')!;
      const accessory = byTestId(mounted.container, 'dismiss')!;
      expect(row.getAttribute('role')).toBe('button');
      expect(row.getAttribute('aria-expanded')).toBe('true');
      expect(row.getAttribute('aria-selected')).toBe('true');
      expect(row.contains(accessory)).toBe(false);
      act(() => accessory.click());
      expect(dismiss).toHaveBeenCalledOnce();
      expect(open).not.toHaveBeenCalled();
      act(() => row.click());
      expect(open).toHaveBeenCalledOnce();
    } finally { mounted.unmount(); }
  });

  it('keeps empty invitations and expansion caller-controlled', () => {
    const invite = vi.fn();
    const expand = vi.fn();
    const mounted = mountThroughReactNativeWeb(inSurface(
      <HappierWorkSection testID="notes" title="Notes"
        empty={{ text: 'Add a note', onPress: invite, testID: 'invite' }}
        more={{ label: 'Show more', onPress: expand, testID: 'more' }}>
        <span data-testid="hidden-row" />
      </HappierWorkSection>,
    ));
    try {
      expect(byTestId(mounted.container, 'hidden-row')).toBeNull();
      act(() => byTestId(mounted.container, 'invite')!.click());
      act(() => byTestId(mounted.container, 'more')!.click());
      expect(invite).toHaveBeenCalledOnce();
      expect(expand).toHaveBeenCalledOnce();
      expect(byTestId(mounted.container, 'hidden-row')).toBeNull();
    } finally { mounted.unmount(); }
  });

  it('omits absent facts without leaving separators or an empty line', () => {
    const mounted = mountThroughReactNativeWeb(inSurface(
      <>
        <authorBarrel.HappierFactLine testID="facts" facts={['Linux', null, 'Codex']} />
        <authorBarrel.HappierFactLine testID="empty-facts" facts={[null, '']} />
      </>,
    ));
    try {
      expect(byTestId(mounted.container, 'facts')!.textContent).toBe('Linux · Codex');
      expect(byTestId(mounted.container, 'empty-facts')).toBeNull();
      expect(authorBarrel.joinHappierFacts('Linux', null, '', 'Codex')).toBe('Linux · Codex');
    } finally { mounted.unmount(); }
  });

  it('opens ancestors while keeping the current breadcrumb non-interactive', () => {
    const open = vi.fn();
    const mounted = mountThroughReactNativeWeb(inSurface(
      <authorBarrel.HappierBreadcrumb items={[
        { key: 'root', label: 'Project', testID: 'ancestor', onPress: open },
        { key: 'current', label: 'File', testID: 'current' },
      ]} />,
    ));
    try {
      act(() => byTestId(mounted.container, 'ancestor')!.click());
      expect(open).toHaveBeenCalledOnce();
      expect(byTestId(mounted.container, 'current')!.getAttribute('role')).not.toBe('link');
    } finally { mounted.unmount(); }
  });

  it('publishes the status language: bucket order and localized labels', () => {
    expect(HAPPIER_WORK_STATUS_BUCKETS).toEqual([
      'needs_you',
      'working',
      'finished',
      'idle',
      'offline',
    ]);
    expect(resolveHappierWorkStatusBucketLabel('needs_you')).toBe('Needs you');
    expect(
      resolveHappierWorkStatusBucketLabel('needs_you', (key, fallback) =>
        key === 'happier.plugin-ui.workStatus.needsYou'
          ? 'Braucht dich'
          : (fallback ?? key),
      ),
    ).toBe('Braucht dich');
  });

  it('draws "needs you" in the host\'s attention ink, distinct from its warning', () => {
    const theme = {
      ...SURFACE_THEME_FIXTURE,
      colors: {
        ...SURFACE_THEME_FIXTURE.colors,
        attention: '#945200',
        warning: '#ff9500',
      },
    };
    const { colors } = resolveHappierWorkTheme(theme);
    expect(
      authorBarrel.resolveHappierWorkStatusGlyphColor('attention', colors),
    ).toBe('#945200');
    expect(authorBarrel.HAPPIER_TONE_COLOR_TOKEN.attention).toBe('attention');
  });

  it('rings and tints needs-you work like trouble, in its own hue, and leaves healthy work neutral', () => {
    const theme = {
      ...SURFACE_THEME_FIXTURE,
      colors: {
        ...SURFACE_THEME_FIXTURE.colors,
        attention: '#945200',
        danger: '#c0392b',
      },
    };
    const { colors } = resolveHappierWorkTheme(theme);
    const needsYou = authorBarrel.resolveHappierWorkStatusSurfaceStyle(
      'attention',
      colors,
    );
    const trouble = authorBarrel.resolveHappierWorkStatusSurfaceStyle(
      'danger',
      colors,
    );

    expect(needsYou).toEqual(
      expect.objectContaining({
        borderWidth: 1,
        backgroundColor: expect.any(String),
      }),
    );
    expect(needsYou.borderColor).toBeTruthy();
    expect(needsYou.borderColor).not.toBe(trouble.borderColor);
    expect(
      authorBarrel.resolveHappierWorkStatusSurfaceStyle('neutral', colors),
    ).toBeNull();
  });

  it('draws a Work section from the mounted environment: title, quiet count, and its rows', () => {
    const mounted = mountThroughReactNativeWeb(
      inSurface(
        <HappierWorkSection testID="working" title="Working" count="3">
          <span data-testid="row" />
        </HappierWorkSection>,
      ),
    );
    try {
      const section = byTestId(mounted.container, 'working')!;
      expect(section.textContent).toContain('Working');
      expect(byTestId(section, 'working-count')?.textContent).toBe('3');
      expect(byTestId(section, 'row')).not.toBeNull();
    } finally {
      mounted.unmount();
    }
  });

  it('keeps a loading section titled with reserved rows and no count', () => {
    const mounted = mountThroughReactNativeWeb(
      inSurface(
        <HappierWorkSection
          testID="needs"
          title="Needs you"
          count="2"
          countTone="attention"
          loading
        >
          <span data-testid="row" />
        </HappierWorkSection>,
      ),
    );
    try {
      expect(byTestId(mounted.container, 'needs-count')).toBeNull();
      expect(byTestId(mounted.container, 'needs-loading')).not.toBeNull();
      expect(byTestId(mounted.container, 'row')).toBeNull();
    } finally {
      mounted.unmount();
    }
  });

  it('renders a plugin-declared map through the one renderer: declared edges only and open forwards the node', () => {
    const map = buildHappierWorkMap({
      relationships: 'authored',
      nodes: [
        {
          nodeId: 'lead',
          label: 'Release train',
          parentNodeId: null,
          open: { kind: 'session', sessionId: 'lead' },
        },
        {
          nodeId: 'check',
          label: 'Smoke checks',
          parentNodeId: 'lead',
          open: { kind: 'run', runId: 'check' },
        },
        {
          nodeId: 'solo',
          label: 'Unrelated',
          parentNodeId: null,
          open: { kind: 'session', sessionId: 'solo' },
        },
      ],
    });
    const onOpen = vi.fn();
    const mounted = mountThroughReactNativeWeb(
      inSurface(
        <HappierWorkMapView
          map={map}
          selectedNodeId={null}
          testIDPrefix="map"
          accessibilityLabelForNode={(node) => node.label}
          presentNode={(node) => ({
            tone: node.nodeId === 'check' ? 'attention' : 'neutral',
          })}
          onOpen={(node) => onOpen(node.open)}
        />,
      ),
    );
    try {
      const group = byTestId(mounted.container, 'map-group-lead')!;
      expect(byTestId(group, 'map-item-check')).not.toBeNull();
      expect(byTestId(mounted.container, 'map-group-solo')).toBeNull();

      const needs = byTestId(mounted.container, 'map-node-check')!;
      act(() => {
        needs.click();
      });
      expect(onOpen).toHaveBeenCalledWith({ kind: 'run', runId: 'check' });
    } finally {
      mounted.unmount();
    }
  });

  it('draws a Work summary: mark, title, one fact line, and the owner word in the attention treatment', () => {
    const mounted = mountThroughReactNativeWeb(
      inSurface(
        <HappierWorkSummary
          testID="summary"
          title="Smoke checks"
          phase="attention"
          mark={<span data-testid="mark" />}
          facts={['Workflow run', '7 of 12']}
          trailingState={{ word: 'Waiting for you', tone: 'attention' }}
          accessibilityLabel="Smoke checks, Waiting for you"
        />,
      ),
    );
    try {
      expect(byTestId(mounted.container, 'mark')).not.toBeNull();
      expect(
        byTestId(mounted.container, 'summary:attention-dot'),
      ).not.toBeNull();
      expect(byTestId(mounted.container, 'summary:facts')?.textContent).toBe(
        'Workflow run · 7 of 12',
      );
      const word = byTestId(mounted.container, 'summary:state:label')!;
      expect(word.textContent).toBe('Waiting for you');
      expect(word.style.color).toBe('rgb(148, 82, 0)');
      expect(ATTENTION).toBe('#945200');
    } finally {
      mounted.unmount();
    }
  });

  it('fails loudly rather than guessing a theme outside a mounted surface', () => {
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    try {
      expect(() =>
        mountThroughReactNativeWeb(<HappierWorkSection testID="x" title="X" />),
      ).toThrow(/need a theme/u);
    } finally {
      error.mockRestore();
    }
  });
});
