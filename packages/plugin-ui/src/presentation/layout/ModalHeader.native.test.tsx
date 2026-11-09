import { View } from 'react-native';
import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

// The native host components are the platform boundary; the header's layout rule stays real.
vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Platform: { OS: 'ios' },
}));

import { HappierModalHeader } from './ModalHeader.js';

function renderHeader(
  input: Readonly<{ compact: boolean; actions: boolean }>,
): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <HappierModalHeader
        testID="header"
        title="Let Claude use a window"
        subtitle="Claude sees and acts only in what you choose."
        titleTestID="title"
        actions={input.actions ? <View testID="machine-chip" /> : undefined}
        close={<View testID="close" />}
        compact={input.compact}
      />,
    );
  });
  return renderer;
}

/** The nearest ancestor that also contains `other`: the row the two share. */
function sharedRow(
  node: ReactTestInstance,
  other: ReactTestInstance,
): ReactTestInstance {
  for (
    let current: ReactTestInstance | null = node.parent;
    current;
    current = current.parent
  ) {
    if (current.findAll((candidate) => candidate === other).length > 0)
      return current;
  }
  throw new Error('No shared ancestor.');
}

describe('modal header identity mark', () => {
  function renderWithMark(placement?: 'above'): ReactTestInstance {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <HappierModalHeader
          testID="header"
          leading={<View testID="mark" />}
          leadingPlacement={placement}
          title="Connect Hetzner"
          subtitle="Run coding sessions on Hetzner Cloud servers."
          titleTestID="title"
          subtitleTestID="subtitle"
          close={<View testID="close" />}
        />,
      );
    });
    return renderer.root;
  }

  it('keeps a mark on the title line and stands the subtitle on the band’s one edge beneath it', () => {
    const root = renderWithMark();
    const row = sharedRow(root.findByProps({ testID: 'mark' }), root.findByProps({ testID: 'title' }));
    const subtitle = root.findByProps({ testID: 'subtitle' });
    expect(row.findAll((node) => node === subtitle)).toHaveLength(0);
    expect(sharedRow(subtitle, root.findByProps({ testID: 'mark' })).props.testID).toBe('header');
  });

  it('keeps a way-back control beside its title and subtitle on a wide card', () => {
    const root = renderWithMark('above');
    const row = sharedRow(root.findByProps({ testID: 'mark' }), root.findByProps({ testID: 'title' }));
    expect(row.findAll((node) => node === root.findByProps({ testID: 'subtitle' }))).toHaveLength(1);
  });
});

describe('modal header phone layout', () => {
  it('gives a compact card’s title the row with close and moves the actions and subtitle beneath it', () => {
    const root = renderHeader({ compact: true, actions: true }).root;
    const title = root.findByProps({ testID: 'title' });
    const close = root.findByProps({ testID: 'close' });
    const chip = root.findByProps({ testID: 'machine-chip' });

    const actionsRow = root.findByProps({ testID: 'header-actions-row' });
    expect(actionsRow.findAll((node) => node === chip)).toHaveLength(1);
    // Title and close share a row the actions are not part of.
    const titleRow = sharedRow(title, close);
    expect(titleRow.findAll((node) => node === chip)).toHaveLength(0);
    // The subtitle takes the full width under that row, not the title's column.
    const subtitle = root
      .findAllByType('Text' as never)
      .find(
        (node) =>
          node.props.children ===
          'Claude sees and acts only in what you choose.',
      );
    expect(subtitle).toBeDefined();
    expect(titleRow.findAll((node) => node === subtitle)).toHaveLength(0);
  });

  it('keeps title, actions and close on one row on a wide card', () => {
    const root = renderHeader({ compact: false, actions: true }).root;
    expect(root.findAllByProps({ testID: 'header-actions-row' })).toHaveLength(
      0,
    );
    const chip = root.findByProps({ testID: 'machine-chip' });
    const close = root.findByProps({ testID: 'close' });
    // The actions sit beside close in the trailing group of the title's row.
    expect(sharedRow(chip, close).props.style).toMatchObject({
      flexDirection: 'row',
    });
    expect(
      sharedRow(chip, root.findByProps({ testID: 'title' })).props.testID,
    ).toBe('header');
  });

  it('keeps a compact card without actions on one row', () => {
    const root = renderHeader({ compact: true, actions: false }).root;
    expect(root.findAllByProps({ testID: 'header-actions-row' })).toHaveLength(0);
    const row = sharedRow(root.findByProps({ testID: 'title' }), root.findByProps({ testID: 'close' }));
    expect(row.props.testID).toBe('header');
    expect(row.props.style).toEqual(expect.arrayContaining([expect.objectContaining({ flexDirection: 'row' })]));
  });

  it('draws nothing when there is nothing to draw', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<HappierModalHeader compact />);
    });
    expect(renderer.toJSON()).toBeNull();
  });

  it('puts a compact card’s navigation above the title when the leading slot asks to stand above it', () => {
    let renderer!: ReactTestRenderer;
    const render = (leadingPlacement: 'above' | undefined) => {
      act(() => {
        renderer = create(
          <HappierModalHeader
            testID="header"
            title="Registries"
            subtitle="Where Browse looks for skills."
            titleTestID="title"
            leading={<View testID="back" />}
            {...(leadingPlacement ? { leadingPlacement } : {})}
            close={<View testID="close" />}
            compact
          />,
        );
      });
      const root = renderer.root;
      return { title: root.findByProps({ testID: 'title' }), back: root.findByProps({ testID: 'back' }), close: root.findByProps({ testID: 'close' }) };
    };
    const beside = render(undefined);
    // Without the request the leading slot is a mark: it shares the title's column.
    expect(sharedRow(beside.back, beside.title).findAll((node) => node === beside.close)).toHaveLength(0);
    const above = render('above');
    // The way back shares the first row with close; the title takes its own line under that row.
    expect(sharedRow(above.back, above.close).findAll((node) => node === above.title)).toHaveLength(0);
  });
});
