import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';

import { createPluginSurfaceContextFixture } from '@/dev/testkit/fixtures/pluginSurfaceContextFixture';
import { lightTheme } from '@/theme';
import { HappierStatus } from '@happier-dev/plugin-ui/presentation';

// Metadata does not invoke Markdown, but the renderer's Markdown leaf imports
// this third-party streaming utility, which is absent from this focused graph.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => [],
}));

import {
    createDeclarativeTextResolver,
    readDeclarativeText,
    renderDeclarativeNode,
    type DeclarativeNodeRenderContext,
} from './declarativeNodes';

const context = {
    colors: lightTheme.colors,
    presentationTheme: createPluginSurfaceContextFixture().theme,
    minimumTouchTarget: 44,
    localize: readDeclarativeText,
    resolveAction: () => null,
    renderField: () => null,
    renderCollectionList: () => null,
} satisfies DeclarativeNodeRenderContext;

describe('declarative metadata tone presentation', () => {
  it('normalizes the protocol default tone before it reaches shared metadata', () => {
        const node = renderDeclarativeNode({
            kind: 'metadata',
            entries: [{ label: 'Status', value: 'Value', tone: 'default' }],
        }, context);

        if (!React.isValidElement<{ entries: readonly { tone?: string }[] }>(node)) {
            throw new Error('Expected the metadata renderer to produce a HappierMetadata element.');
        }

    expect(node.props.entries[0]?.tone).toBe('neutral');
  });

  it('converges declarative status on the shared RN status owner', () => {
    const node = renderDeclarativeNode({
      kind: 'status',
      label: 'Indexer',
      value: 'Running',
      tone: 'warning',
    }, context);

    if (!React.isValidElement<{
      tone: string;
      theme: typeof context.presentationTheme;
      accessibilityLiveRegion: string;
    }>(node)) {
      throw new Error('Expected the status renderer to produce a shared status element.');
    }

    expect(node.type).toBe(HappierStatus);
    expect(node.props).toMatchObject({
      tone: 'warning',
      theme: context.presentationTheme,
      accessibilityLiveRegion: 'polite',
    });
  });

  it('names a declarative status meaning that lives only in its tone', () => {
    const node = renderDeclarativeNode({
      kind: 'status',
      // Neutral wording plus a semantic tone: colour is the only channel that
      // currently carries "this is a failure".
      label: 'Deployment',
      value: '12 minutes',
      tone: 'danger',
    }, context);

    if (!React.isValidElement<{ accessibilityLabel?: string }>(node)) {
      throw new Error('Expected the status renderer to produce a shared status element.');
    }

    // The tone reaches assistive technology as a word, prefixed onto the same
    // label/value composition the item and metadata adapters already use.
    expect(node.props.accessibilityLabel).toMatch(/^\S.*: Deployment: 12 minutes$/);
    expect(node.props.accessibilityLabel).not.toBe('Deployment: 12 minutes');
  });

  it('leaves a toneless declarative status to speak its own label and value', () => {
    const node = renderDeclarativeNode({
      kind: 'status',
      label: 'Deployment',
      value: '12 minutes',
      tone: 'default',
    }, context);

    if (!React.isValidElement<{ accessibilityLabel?: string }>(node)) {
      throw new Error('Expected the status renderer to produce a shared status element.');
    }

    expect(node.props.accessibilityLabel).toBeUndefined();
  });

  it('resolves declarative localized text through the supplied surface resolver', () => {
    const localize = createDeclarativeTextResolver(
      (key: string, fallback?: string) => (key === 'acme.ready' ? 'Bereit' : (fallback ?? '')),
    );
    const node = renderDeclarativeNode({
      kind: 'status',
      label: { key: 'acme.ready', fallback: 'Ready' },
      value: { key: 'acme.unknown', fallback: 'Idle' },
      tone: 'default',
    }, { ...context, localize });

    if (!React.isValidElement<{ label: React.ReactElement; value: React.ReactElement }>(node)) {
      throw new Error('Expected the status renderer to produce a shared status element.');
    }

    expect(
      (node.props.label as React.ReactElement<{ children?: unknown }>).props.children,
    ).toBe('Bereit');
    // An unresolved key must fall back to the author's own words, never leak
    // the raw key.
    expect(
      (node.props.value as React.ReactElement<{ children?: unknown }>).props.children,
    ).toBe('Idle');
  });

  it('keeps transcript declarative text on the immutable persisted fallback', () => {
    const node = renderDeclarativeNode({
      kind: 'status',
      label: { key: 'acme.ready', fallback: 'Ready' },
      value: 'Idle',
      tone: 'default',
    }, context);

    if (!React.isValidElement<{ label: React.ReactElement }>(node)) {
      throw new Error('Expected the status renderer to produce a shared status element.');
    }

    expect(
      (node.props.label as React.ReactElement<{ children?: unknown }>).props.children,
    ).toBe('Ready');
  });

  it('passes the host high-contrast fact to the shared status owner', () => {
    const highContrastContext = {
      ...context,
      contrast: 'high',
    } satisfies DeclarativeNodeRenderContext;
    const node = renderDeclarativeNode({
      kind: 'status',
      label: 'Indexer',
      value: 'Running',
      tone: 'warning',
    }, highContrastContext);

    if (!React.isValidElement<{ contrast?: string }>(node)) {
      throw new Error('Expected the status renderer to produce a shared status element.');
    }

    expect(node.props.contrast).toBe('high');
  });

  it('delegates a normalized targeted surface leaf only to the mounted-surface bridge', () => {
        const renderedChild = React.createElement('TargetedSurfaceChild', { testID: 'targeted-surface-child' });
        const renderTargetedSurface = vi.fn(() => renderedChild);
        const node = {
            kind: 'targetedSurface',
            surface: {
                point: { pointId: 'details', protocol: { id: 'review-detail', version: 1 } },
                contributor: {
                    pluginId: 'acme.review',
                    contributionId: 'detail',
                    immutableGenerationId: 'review-generation',
                },
                role: 'detail',
                presentation: 'content',
            },
            input: { reviewId: 'review-42' },
            instanceKey: 'targeted-surface:v1:review-42',
        };

        const result = renderDeclarativeNode(node, {
            ...context,
            renderTargetedSurface,
        });

        expect(renderTargetedSurface).toHaveBeenCalledWith(node);
        expect(result).toBe(renderedChild);
    });
});
