import * as React from 'react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { WORKFLOW_STARTER_EXAMPLES_V1 } from '@happier-dev/protocol/workflows/builtins/examples';

import { renderScreen } from '@/dev/testkit';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
);
// Navigation is the platform boundary; the picker's own catalog is what is read.
vi.mock('@/components/appShell/workspace/destinationRoute', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

const { WorkflowExamplesSection } = await import('./WorkflowExamplesSection');
const { HostCollection } = await import('@happier-dev/plugin-ui');

type Section = Readonly<{
  group: Readonly<{ key: string }> | null;
  items: readonly Readonly<{ key: string }>[];
}>;

describe('the full examples picker (#184 F2)', () => {
  it('groups the catalog by how each example starts, so an event starter is found with its kind, not last of all', async () => {
    const screen = await renderScreen(<WorkflowExamplesSection />);
    const cards = screen
      .findAllByType(HostCollection)
      .find((node) => node.props.testID === 'workflow-examples:cards')!;
    const sections = cards.props.model.sections as readonly Section[];
    const groupOf = (key: string) =>
      sections.find((section) => section.items.some((item) => item.key === key))
        ?.group?.key;
    expect(sections.map((section) => section.group?.key)).toEqual([
      'runNow',
      'schedule',
      'event',
    ]);
    expect(groupOf('ask-once')).toBe('runNow');
    expect(groupOf('morning-digest')).not.toBe('event');
    expect(groupOf('investigate-new-sentry-issue')).toBe('event');
    // Every example is still offered once.
    expect(sections.flatMap((section) => section.items).length).toBe(
      WORKFLOW_STARTER_EXAMPLES_V1.length,
    );
  });

  it('narrows the catalog from its search field by name and description', async () => {
    const screen = await renderScreen(<WorkflowExamplesSection />);
    const field = screen.findHostByTestId('workflow-examples:search');
    expect(field).not.toBeNull();
    await act(async () => field!.props.onChangeText('sentry'));
    const cards = screen
      .findAllByType(HostCollection)
      .find((node) => node.props.testID === 'workflow-examples:cards')!;
    const keys = (cards.props.model.sections as readonly Section[]).flatMap(
      (section) => section.items.map((item) => item.key),
    );
    expect(keys).toEqual(['investigate-new-sentry-issue']);
  });

});
