import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';
import {
  DEFAULT_PUBLIC_PROFILE_POLICY_V1,
  PUBLIC_PROFILE_FIELDS_V1,
  PublicProfileSnapshotV1Schema,
} from '@happier-dev/protocol/account/publicProfile';
import { WidgetDefinitionV1Schema } from '@happier-dev/protocol/widgets';

import { renderScreen } from '@/dev/testkit';
import { describeAuthoredWidgetDefinitionV1 } from '@/components/widgets/widgetCatalog';
import { t } from '@/text';
import {
  PublicProfileHiddenBlockNote,
  resolvePublicProfileBlockShareField,
} from './PublicProfileHiddenBlockNote';
import {
  PublicProfileWidgetPreviewProvider,
  PublicProfileWidgetSurface,
} from './PublicProfileWidgetSurface';

const context = {
  handle: 'leeroy',
  identity: { name: 'Leeroy' },
  service: null,
  urls: null,
};
const snapshot = PublicProfileSnapshotV1Schema.parse({
  v: 1,
  computedAtMs: 10,
  period: { startMs: 1, endMs: 9, timeZoneOffsetMinutes: 0 },
  coverage: { status: 'complete_for_supplied_facts', method: 'runtime' },
  fieldCoverage: {},
  facts: { activeDays: 42 },
});
const ownerPolicy = {
  indexable: false,
  fields: Object.fromEntries(
    PUBLIC_PROFILE_FIELDS_V1.map((field) => [field, true]),
  ),
} as typeof DEFAULT_PUBLIC_PROFILE_POLICY_V1;
const visitorPolicy = {
  ...DEFAULT_PUBLIC_PROFILE_POLICY_V1,
  fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields, activeDays: false },
};
const definition = WidgetDefinitionV1Schema.parse({
  v: 1,
  id: 'days',
  name: 'Days',
  sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' },
  inputs: { fields: [] },
  inputSchema: { type: 'object', additionalProperties: false },
  provenance: { source: { kind: 'authored' } },
  body: {
    kind: 'declarative',
    document: { version: 1, root: { kind: 'text', text: 'private' } },
  },
  publicPresentation: {
    kind: 'declarative',
    document: {
      version: 1,
      root: {
        kind: 'metric',
        label: 'Active days',
        data: { kind: 'value', value: { kind: 'public_profile' } },
        value: { path: ['snapshot', 'facts', 'activeDays'], type: 'number' },
      },
    },
  },
});
const descriptor = describeAuthoredWidgetDefinitionV1(definition, {
  kind: 'inline',
  definition,
});
const instance = {
  v: 1 as const,
  id: 'days',
  definition: { kind: 'artifact' as const, artifactId: 'days-definition' },
  bindings: {},
};
const labels = {
  identityLine: '',
  periodTitle: '',
  periodDetail: '',
  emptyLayout: '',
  footerNote: '',
  report: '',
  madeWith: '',
  inert: { success: '', warning: '', error: '', incomplete: '' },
};
const layout = {
  v: 1 as const,
  items: [
    {
      kind: 'widget' as const,
      id: 'days',
      size: 'medium' as const,
      frameStyle: 'plain' as const,
      presentation: {
        kind: 'declarative' as const,
        document: definition.publicPresentation!.document,
      },
    },
  ],
};

describe('in-place hidden blocks on the owner’s page', () => {
  it('names the one unshared item a hidden block needs, and nothing when sharing cannot draw it', () => {
    expect(
      resolvePublicProfileBlockShareField({
        blockId: 'days',
        layout,
        context,
        snapshot,
        policy: visitorPolicy,
      }),
    ).toBe('activeDays');
    expect(
      resolvePublicProfileBlockShareField({
        blockId: 'missing',
        layout,
        context,
        snapshot,
        policy: visitorPolicy,
      }),
    ).toBeNull();
  });

  it('keeps the owner’s values in place, quieted and labelled, with Share for exactly the item it needs', async () => {
    const shared: string[] = [];
    const source = {
      context,
      snapshot,
      metadata: {},
      policy: ownerPolicy,
      appearance: {
        theme: 'auto' as const,
        atmosphere: { source: 'none' as const },
      },
    };
    const tree = (hidden: ReadonlySet<string>) => (
      <PublicProfileWidgetPreviewProvider
        value={{
          kind: 'ready',
          source,
          labels,
          owner: {
            hiddenBlockIds: hidden,
            onlyYou: t('publicIdentity.editor.onlyYou'),
            renderHiddenNote: (blockId: string) => (
              <PublicProfileHiddenBlockNote
                blockId={blockId}
                layout={layout}
                context={context}
                snapshot={snapshot}
                policy={visitorPolicy}
                disabled={false}
                onShare={(field) => shared.push(field)}
              />
            ),
          },
        }}
      >
        <PublicProfileWidgetSurface
          instance={instance}
          descriptor={descriptor}
          testID="block"
        />
      </PublicProfileWidgetPreviewProvider>
    );
    const screen = await renderScreen(tree(new Set(['days'])));
    const text = screen.getTextContent();
    // The owner still reads their own number; visitors' absence is said, not faked.
    expect(text).toContain('42');
    expect(text).toContain(t('publicIdentity.editor.onlyYou'));
    expect(text).toContain(
      t('publicIdentity.editor.hiddenBlock', {
        item: t('publicIdentity.publicData.fields.activeDays'),
      }),
    );
    await act(async () => {
      screen.findByTestId('public-profile-hidden-share-days')!.props.onPress();
    });
    expect(shared).toEqual(['activeDays']);
    // A shown block carries no owner chrome.
    await act(async () => {
      screen.update(tree(new Set()));
    });
    expect(screen.getTextContent()).not.toContain(
      t('publicIdentity.editor.onlyYou'),
    );
    expect(screen.findByTestId('public-profile-hidden-note-days')).toBeNull();
  });
});
