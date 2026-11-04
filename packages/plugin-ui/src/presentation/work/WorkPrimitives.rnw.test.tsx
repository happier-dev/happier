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
  it('separates page-section event groups without adding row dividers', () => {
    const mounted = mountThroughReactNativeWeb(
      inSurface(
        <HappierWorkSection testID="triggers" title="Triggers" anatomy="page">
          <authorBarrel.HappierPageSheetGroup
            header={<span>When a turn ends</span>}
          >
            <authorBarrel.HappierTriggerRow
              title="Review"
              enabled
              toggleLabel="Turn off Review"
              onToggle={() => {}}
            />
            <authorBarrel.HappierTriggerRow
              title="Notify"
              enabled
              toggleLabel="Turn off Notify"
              onToggle={() => {}}
            />
          </authorBarrel.HappierPageSheetGroup>
          <authorBarrel.HappierPageSheetGroup
            header={<span>Every morning</span>}
          >
            <authorBarrel.HappierTriggerRow
              title="Summarize"
              enabled
              toggleLabel="Turn off Summarize"
              onToggle={() => {}}
            />
          </authorBarrel.HappierPageSheetGroup>
        </HappierWorkSection>,
      ),
    );
    try {
      expect(
        byTestId(mounted.container, 'triggers')!.querySelectorAll(
          '[role="separator"]',
        ),
      ).toHaveLength(1);
    } finally {
      mounted.unmount();
    }
  });

  it('keeps an independent accessory outside the selected disclosure button', () => {
    const open = vi.fn();
    const dismiss = vi.fn();
    const mounted = mountThroughReactNativeWeb(
      inSurface(
        <authorBarrel.HappierWorkRowShell
          testID="work-row"
          accessibilityLabel="Review work"
          selected
          expanded
          onPress={open}
          trailingAccessory={
            <button data-testid="dismiss" onClick={dismiss}>
              Dismiss
            </button>
          }
        >
          <span>Review work</span>
        </authorBarrel.HappierWorkRowShell>,
      ),
    );
    try {
      const row = byTestId(mounted.container, 'work-row')!;
      const accessory = byTestId(mounted.container, 'dismiss')!;
      expect(row.getAttribute('role')).toBe('button');
      expect(row.getAttribute('aria-expanded')).toBe('true');
      // Selection is visual here; aria-selected is not valid on a disclosure button.
      expect(row.getAttribute('aria-selected')).toBeNull();
      expect(row.contains(accessory)).toBe(false);
      act(() => accessory.click());
      expect(dismiss).toHaveBeenCalledOnce();
      expect(open).not.toHaveBeenCalled();
      act(() => row.click());
      expect(open).toHaveBeenCalledOnce();
    } finally {
      mounted.unmount();
    }
  });

  it('sets a row\'s below-text actions on its text column, outside the row button', () => {
    const open = vi.fn();
    const decide = vi.fn();
    const mounted = mountThroughReactNativeWeb(
      inSurface(
        <authorBarrel.HappierWorkRowShell
          testID="work-row"
          accessibilityLabel="Approve work"
          density="page"
          onPress={open}
          belowAccessory={
            <button data-testid="decide" onClick={decide}>
              Allow once
            </button>
          }
        >
          <span>Approve work</span>
        </authorBarrel.HappierWorkRowShell>,
      ),
    );
    try {
      const row = byTestId(mounted.container, 'work-row')!;
      const action = byTestId(mounted.container, 'decide')!;
      const slot = byTestId(mounted.container, 'work-row:below')!;
      expect(slot.contains(action)).toBe(true);
      expect(row.contains(action)).toBe(false);
      // Beneath the row, not beside it, and starting where the row's text starts.
      expect(
        row.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(slot.style.paddingLeft).toBe(
        `${authorBarrel.HAPPIER_WORK_PAGE_ROW_METRICS.textInsetPx}px`,
      );
      act(() => action.click());
      expect(decide).toHaveBeenCalledOnce();
      expect(open).not.toHaveBeenCalled();
    } finally {
      mounted.unmount();
    }
  });

  it('sets a page row\'s date in one trailing column, after its own control and outside the row button', () => {
    const { HappierWorkRowShell } = authorBarrel;
    const { container, unmount } = mountThroughReactNativeWeb(
      inSurface(
        <HappierWorkRowShell
          testID="work.row"
          accessibilityLabel="Row"
          density="page"
          onPress={() => {}}
          trailingAccessory={<span data-testid="work.row.control">Review</span>}
          trailingMeta="20m"
        >
          <span>Row</span>
        </HappierWorkRowShell>,
      ),
    );
    const meta = byTestId(container, 'work.row:meta');
    const control = byTestId(container, 'work.row.control');
    expect(meta?.textContent).toBe('20m');
    expect(byTestId(container, 'work.row')?.contains(meta)).toBe(false);
    expect(control!.compareDocumentPosition(meta!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    unmount();
  });

  it('keeps the column on a row with no date, so the controls above and below it share an edge', () => {
    const { HappierWorkRowShell } = authorBarrel;
    const { container, unmount } = mountThroughReactNativeWeb(
      inSurface(
        <HappierWorkRowShell testID="work.row" accessibilityLabel="Row" density="page" onPress={() => {}} trailingMeta={null}>
          <span>Row</span>
        </HappierWorkRowShell>,
      ),
    );
    expect(byTestId(container, 'work.row:meta')?.textContent).toBe('');
    unmount();
  });

  it('keeps empty invitations and expansion caller-controlled', () => {
    const invite = vi.fn();
    const expand = vi.fn();
    const mounted = mountThroughReactNativeWeb(
      inSurface(
        <HappierWorkSection
          testID="notes"
          title="Notes"
          empty={{ text: 'Add a note', onPress: invite, testID: 'invite' }}
          more={{ label: 'Show more', onPress: expand, testID: 'more' }}
        >
          <span data-testid="hidden-row" />
        </HappierWorkSection>,
      ),
    );
    try {
      expect(byTestId(mounted.container, 'hidden-row')).toBeNull();
      act(() => byTestId(mounted.container, 'invite')!.click());
      act(() => byTestId(mounted.container, 'more')!.click());
      expect(invite).toHaveBeenCalledOnce();
      expect(expand).toHaveBeenCalledOnce();
      expect(byTestId(mounted.container, 'hidden-row')).toBeNull();
    } finally {
      mounted.unmount();
    }
  });

  it('omits absent facts without leaving separators or an empty line', () => {
    const mounted = mountThroughReactNativeWeb(
      inSurface(
        <>
          <authorBarrel.HappierFactLine
            testID="facts"
            facts={['Linux', null, 'Codex']}
          />
          <authorBarrel.HappierFactLine
            testID="empty-facts"
            facts={[null, '']}
          />
        </>,
      ),
    );
    try {
      expect(byTestId(mounted.container, 'facts')!.textContent).toBe(
        'Linux · Codex',
      );
      expect(byTestId(mounted.container, 'empty-facts')).toBeNull();
      expect(authorBarrel.joinHappierFacts('Linux', null, '', 'Codex')).toBe(
        'Linux · Codex',
      );
    } finally {
      mounted.unmount();
    }
  });

  it('opens ancestors while keeping the current breadcrumb non-interactive', () => {
    const open = vi.fn();
    const mounted = mountThroughReactNativeWeb(
      inSurface(
        <authorBarrel.HappierBreadcrumb
          items={[
            {
              key: 'root',
              label: 'Project',
              testID: 'ancestor',
              onPress: open,
            },
            { key: 'current', label: 'File', testID: 'current' },
          ]}
        />,
      ),
    );
    try {
      act(() => byTestId(mounted.container, 'ancestor')!.click());
      expect(open).toHaveBeenCalledOnce();
      expect(
        byTestId(mounted.container, 'current')!.getAttribute('role'),
      ).not.toBe('link');
    } finally {
      mounted.unmount();
    }
  });

  it('lets the host cap how far an ancestor link reaches for a finger, so a control flush below it is not covered', () => {
    const reachBelow = (linkHitReach?: Parameters<typeof authorBarrel.HappierBreadcrumb>[0]['linkHitReach']) => {
      const mounted = mountThroughReactNativeWeb(
        <HappierUiEnvironmentProvider
          environment={projectHappierUiEnvironment(createSurfaceContext({ platform: 'ios' }))}
        >
          <authorBarrel.HappierBreadcrumb
            linkHitReach={linkHitReach}
            linkStyle={{ height: 16 }}
            items={[
              { key: 'root', label: 'Project', testID: 'ancestor', onPress: () => {} },
              { key: 'current', label: 'File', testID: 'current' },
            ]}
          />
        </HappierUiEnvironmentProvider>,
      );
      try {
        const frame = byTestId(mounted.container, 'ancestor')!.querySelector<HTMLElement>(
          ':scope > [data-happier-hit-area="true"]',
        );
        return frame === null ? null : Math.abs(Number.parseFloat(getComputedStyle(frame).bottom));
      } finally {
        mounted.unmount();
      }
    };
    // A finger reaches the platform target around the link; the host's declared cap holds on the side it names.
    expect(reachBelow()).toBeGreaterThan(0);
    expect(reachBelow({ bottom: 0 })).toBe(0);
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
    // Over the card's own fill the tint is one opaque colour: a tinted card hides what lies beneath it.
    const opaque = (style: { backgroundColor: string }) => !/rgba\([^)]*,\s*0?\.\d+\s*\)/u.test(style.backgroundColor);
    const onSurface = { ...colors, surface: '#ffffff' };
    const needsYouOnSurface = authorBarrel.resolveHappierWorkStatusSurfaceStyle('attention', onSurface);
    const troubleOnSurface = authorBarrel.resolveHappierWorkStatusSurfaceStyle('danger', onSurface);
    expect(opaque(needsYouOnSurface) && opaque(troubleOnSurface)).toBe(true);
    expect(needsYouOnSurface.backgroundColor).not.toBe(troubleOnSurface.backgroundColor);
    expect(needsYouOnSurface.backgroundColor).not.toBe('rgb(255, 255, 255)');
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

  it('draws a map without an open handler read-only: its cards are not buttons, and a muted card is quieter', () => {
    const map = buildHappierWorkMap({
      relationships: 'authored',
      nodes: [
        { nodeId: 'one', label: 'Level 1', parentNodeId: null },
        { nodeId: 'refused', label: 'One more', parentNodeId: null },
      ],
    });
    const mounted = mountThroughReactNativeWeb(
      inSurface(
        <HappierWorkMapView
          map={map}
          selectedNodeId={null}
          testIDPrefix="map"
          rootLayout="sequence"
          accessibilityLabelForNode={(node) => node.label}
          presentNode={(node) => ({ muted: node.nodeId === 'refused' })}
        />,
      ),
    );
    try {
      const one = byTestId(mounted.container, 'map-node-one')!;
      const refused = byTestId(mounted.container, 'map-node-refused')!;
      expect(one.getAttribute('role')).not.toBe('button');
      expect(refused.getAttribute('role')).not.toBe('button');
      expect(getComputedStyle(one).opacity).not.toBe('0.6');
      expect(getComputedStyle(refused).opacity).toBe('0.6');
    } finally {
      mounted.unmount();
    }
  });

  it("trails a full-width card's status on its row and moves it under the title only inside a lane", () => {
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
          nodeId: 'api',
          label: 'API lane',
          parentNodeId: 'lead',
          open: { kind: 'session', sessionId: 'api' },
        },
        {
          nodeId: 'docs',
          label: 'Docs lane',
          parentNodeId: 'lead',
          open: { kind: 'session', sessionId: 'docs' },
        },
        {
          nodeId: 'solo',
          label: 'Unrelated',
          parentNodeId: null,
          open: { kind: 'session', sessionId: 'solo' },
        },
      ],
    });
    const mounted = mountThroughReactNativeWeb(
      inSurface(
        <HappierWorkMapView
          map={map}
          selectedNodeId={null}
          testIDPrefix="map"
          accessibilityLabelForNode={(node) => node.label}
          presentNode={(node) => ({
            childLayout: node.nodeId === 'lead' ? 'lanes' : 'sequence',
          })}
          renderStatus={(node) => (
            <span data-testid={`status-${node.nodeId}`}>Waiting</span>
          )}
        />,
      ),
    );
    // The row's direct child that holds the status: its own trailing cell, or the title's column.
    const statusCell = (nodeId: string) => {
      const row = byTestId(mounted.container, `map-node-${nodeId}`)!;
      let cell: HTMLElement = byTestId(row, `status-${nodeId}`)!;
      while (cell.parentElement !== row) cell = cell.parentElement!;
      return cell;
    };
    try {
      expect(statusCell('solo').textContent).not.toContain('Unrelated');
      expect(statusCell('api').textContent).toContain('API lane');
    } finally {
      mounted.unmount();
    }
  });

  it('keeps lane cards to their title and state, and gives the fact line only to full-width nodes (lab map-M2)', () => {
    const map = buildHappierWorkMap({
      relationships: 'authored',
      nodes: [
        {
          nodeId: 'lead',
          label: 'Payments v2 rollout',
          parentNodeId: null,
          open: { kind: 'session', sessionId: 'lead' },
        },
        {
          nodeId: 'api',
          label: 'Idempotent retries',
          parentNodeId: 'lead',
          open: { kind: 'session', sessionId: 'api' },
        },
        {
          nodeId: 'ui',
          label: 'Checkout UI retry states',
          parentNodeId: 'lead',
          open: { kind: 'session', sessionId: 'ui' },
        },
      ],
    });
    const mounted = mountThroughReactNativeWeb(
      inSurface(
        <HappierWorkMapView
          map={map}
          selectedNodeId={null}
          testIDPrefix="map"
          accessibilityLabelForNode={(node) => node.label}
          presentNode={(node) => ({
            childLayout: node.nodeId === 'lead' ? 'lanes' : 'sequence',
          })}
          renderSubtitle={(node) => (
            <span data-testid={`subtitle-${node.nodeId}`}>
              Claude · MacBook Pro
            </span>
          )}
        />,
      ),
    );
    try {
      expect(byTestId(mounted.container, 'map-group-lead')).not.toBeNull();
      expect(byTestId(mounted.container, 'subtitle-lead')).not.toBeNull();
      expect(byTestId(mounted.container, 'subtitle-api')).toBeNull();
      expect(byTestId(mounted.container, 'subtitle-ui')).toBeNull();
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

  it('draws a page-density summary for a page of things that all need you: page type steps, a strong title and no corner dot', () => {
    const mounted = mountThroughReactNativeWeb(
      inSurface(
        <HappierWorkSummary
          testID="summary"
          title="Write changelog is waiting for your review"
          phase="attention"
          density="page"
          attentionMark={false}
          mark={<span data-testid="mark" />}
          facts={['Changelog lane']}
          trailingTime="4m"
          accessibilityLabel="Write changelog is waiting for your review"
        />,
      ),
    );
    try {
      expect(byTestId(mounted.container, 'summary:attention-dot')).toBeNull();
      const title = byTestId(mounted.container, 'summary:title')!;
      expect(title.style.fontSize).toBe('14px');
      expect(title.style.lineHeight).toBe('20px');
      expect(title.style.fontWeight).toBe('600');
      const facts = byTestId(mounted.container, 'summary:facts')!;
      expect(facts.style.fontSize).toBe('13px');
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
