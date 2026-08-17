import {
  createPluginUiTestkit,
  createSurfaceContextFixture,
  SURFACE_CONTEXT_THEME_FIXTURE,
} from '@happier-dev/plugin-sdk/testing';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { act, useEffect, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Button } from '../components/Button.js';
import { Divider } from '../components/Foundation.js';
import { Form, Select, TextField } from '../components/Form.js';
import { Image } from '../components/Image.js';
import { List } from '../components/List.js';
import { useSurfaceContext } from '../components/PluginUiProvider.js';
import { Tabs } from '../components/Tabs.js';
import { TargetedSurface } from '../components/TargetedSurface.js';
import { Text } from '../components/Text.js';
import { createSurfaceContext, SURFACE_THEME_FIXTURE } from '../surfaceFixture.testSupport.js';
import { defineUiSurface } from '../surfaceEntry.js';
import { createPluginUiRnwSemanticSurfaceAdapter } from './rnwSemanticAdapter.testSupport.js';

const identity = {
  pluginId: 'com.acme.semantic-rnw',
  pluginVersion: '1.0.0',
  viewId: 'review',
  generation: 'generation-1',
  sessionId: 'session-1',
} as const;

describe('plugin-ui RNW semantic fixture adapter', () => {
  it('uses the SDK testing context builder rather than a duplicate local fixture', () => {
    expect(createSurfaceContext).toBe(createSurfaceContextFixture);
    expect(SURFACE_THEME_FIXTURE).toBe(SURFACE_CONTEXT_THEME_FIXTURE);
  });

  it('mounts the real author surface, projects bounded semantics, invokes a real press, updates, and disposes', async () => {
    let presses = 0;

    function AuthorSurface() {
      const { locale } = useSurfaceContext();
      return (
        <>
          <Button title={`Save review (${locale})`} onPress={() => { presses += 1; }} />
          <Button title="Unavailable review" disabled onPress={() => { presses += 100; }} />
        </>
      );
    }

    const initialSurface = createSurfaceContext();
    const bodyChildCount = document.body.children.length;
    const fixture = await createPluginUiTestkit({
      identity,
      surface: defineUiSurface(AuthorSurface),
      surfaceContext: initialSurface,
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
    });

    const enabled = await fixture.getByRole('button', { name: 'Save review (en-GB)' });
    expect(enabled).toEqual({ role: 'button', name: 'Save review (en-GB)' });
    expect(enabled).not.toHaveProperty('handle');
    expect(enabled).not.toHaveProperty('revision');

    const disabled = await fixture.getByRole('button', {
      name: 'Unavailable review',
      state: { disabled: true },
    });
    await expect(fixture.press(disabled)).rejects.toMatchObject({ code: 'stale_surface' });

    await fixture.press(enabled);
    expect(presses).toBe(1);

    await act(async () => {
      await fixture.updateSurface({ ...initialSurface, locale: 'de-CH' });
    });
    await expect(fixture.press(enabled)).rejects.toMatchObject({ code: 'stale_surface' });

    const updated = await fixture.getByRole('button', { name: 'Save review (de-CH)' });
    await fixture.press(updated);
    expect(presses).toBe(2);

    await fixture.dispose();
    expect(document.body.children).toHaveLength(bodyChildCount);
  });

  it('renders the exact declared targeted child across replacement, uninstall, and reinstall', async () => {
    const targetPluginId = 'com.acme.target';
    const contributorPluginId = 'com.acme.contributor';
    const contributionId = 'review-source';
    const pointId = 'sources';
    const protocol = { id: 'review-sources', version: 1 } as const;
    const rendererId = 'review-detail';
    const mounts = { current: [] as unknown[] };
    const manifestFor = (generation: string) => definePlugin({
      id: contributorPluginId,
      version: '1.0.0',
      ui: {
        renderers: [{
          id: rendererId,
          kind: 'declarative',
          root: { kind: 'text', text: `External child (${generation})` },
        }],
      },
    }).manifest;
    let contributorManifest = manifestFor('contributor-generation-a');

    const contextFor = (targetGeneration: string, contributorGeneration?: string) => {
      const surface = contributorGeneration === undefined ? undefined : {
        point: { pointId, protocol },
        contributor: {
          pluginId: contributorPluginId,
          contributionId,
          immutableGenerationId: contributorGeneration,
        },
        role: 'detail',
        presentation: 'content',
      } as const;
      return createSurfaceContext({
        targetedContributions: {
          target: { pluginId: targetPluginId, immutableGenerationId: targetGeneration },
          points: surface === undefined ? [] : [{
            pointId,
            protocols: [{
              protocol,
              contributions: [{
                contributor: surface.contributor,
                protocol,
                descriptor: { kind: 'review', label: 'External review' },
                operations: [],
                surfaces: [surface],
              }],
            }],
          }],
        },
      });
    };
    const admittedMount = (targetGeneration: string, contributorGeneration: string) => ({
      kind: 'targetedSurface',
      target: { pluginId: targetPluginId, immutableGenerationId: targetGeneration },
      point: { pointId, protocol },
      contributor: {
        pluginId: contributorPluginId,
        contributionId,
        immutableGenerationId: contributorGeneration,
      },
      role: 'detail',
      presentation: 'content',
      inputSchema: {
        type: 'object',
        properties: { entryId: { type: 'string', minLength: 1 } },
        required: ['entryId'],
        additionalProperties: false,
      },
      rendererChain: [{ pluginId: contributorPluginId, localId: rendererId }],
      selectedRenderer: {
        identity: { pluginId: contributorPluginId, localId: rendererId },
        renderer: {
          kind: 'declarative',
          contributionId: rendererId,
          model: { visible: true },
        },
        availability: { state: 'available', reason: 'available', diagnostics: [] },
      },
      executionOrigin: {
        serverIdentityId: 'srv_external',
        materializationRef: {
          machineId: 'machine-external',
          materializationId: `materialization-${contributorGeneration}`,
          pluginId: contributorPluginId,
        },
      },
      resourceCapability: { readable: true, dynamic: true },
      contributorTargetedContributions: {
        target: {
          pluginId: contributorPluginId,
          immutableGenerationId: contributorGeneration,
        },
        points: [],
      },
    });

    function TargetSurface() {
      const { targetedContributions } = useSurfaceContext();
      const surface = targetedContributions.points[0]?.protocols[0]?.contributions[0]?.surfaces[0];
      if (!surface) return <Text value="External review unavailable" />;
      return (
        <TargetedSurface
          surface={surface}
          input={{ entryId: 'review-42' }}
          instanceKey="review-42"
          fallback={<Text value="External review unavailable" />}
        />
      );
    }

    mounts.current = [admittedMount('target-generation-a', 'contributor-generation-a')];
    const fixture = await createPluginUiTestkit({
      identity: {
        ...identity,
        pluginId: targetPluginId,
        generation: 'target-generation-a',
      },
      surface: defineUiSurface(TargetSurface),
      surfaceContext: contextFor('target-generation-a', 'contributor-generation-a'),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({
        targetedSurfaces: {
          readCurrentMounts: () => mounts.current,
          readContributorManifest: () => contributorManifest,
        },
      }),
    });

    try {
      await expect(fixture.getByText('External child (contributor-generation-a)'))
        .resolves.toBeDefined();

      mounts.current = [admittedMount('target-generation-a', 'contributor-generation-b')];
      contributorManifest = manifestFor('contributor-generation-b');
      await act(async () => {
        await fixture.updateSurface(contextFor('target-generation-a', 'contributor-generation-b'));
      });
      await expect(fixture.getByText('External child (contributor-generation-b)'))
        .resolves.toBeDefined();

      mounts.current = [];
      await act(async () => {
        await fixture.updateSurface(contextFor('target-generation-a'));
      });
      await expect(fixture.getByText('External review unavailable')).resolves.toBeDefined();

      mounts.current = [admittedMount('target-generation-b', 'contributor-generation-c')];
      contributorManifest = manifestFor('contributor-generation-c');
      await act(async () => {
        await fixture.updateSurface(contextFor('target-generation-b', 'contributor-generation-c'));
      });
      await expect(fixture.getByText('External child (contributor-generation-c)'))
        .resolves.toBeDefined();
    } finally {
      await fixture.dispose();
    }
  });

  it('queries real Text, implicit TextField, and asynchronously loaded Image semantics', async () => {
    function AuthorSurface() {
      return (
        <>
          <Text value="Review ready" />
          <TextField
            label="Review title"
            placeholder="Write a title"
            value="Draft review"
            onChange={() => undefined}
          />
          <Image resource="review-logo" accessibilityLabel="Review logo" />
        </>
      );
    }

    const fixture = await createPluginUiTestkit({
      identity,
      surface: defineUiSurface(AuthorSurface),
      surfaceContext: createSurfaceContext(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        readResource: async () => ({
          contentType: 'image/png',
          digest: `sha256:${'1'.repeat(64)}`,
          bytes: new Uint8Array([137, 80, 78, 71]),
        }),
      },
    });

    await expect(fixture.getByText('Review ready')).resolves.toEqual({ content: 'Review ready' });
    await expect(fixture.getByRole('textbox', {
      label: 'Review title',
      placeholder: 'Write a title',
      value: 'Draft review',
    })).resolves.toEqual({
      role: 'textbox',
      name: 'Review title',
      label: 'Review title',
      placeholder: 'Write a title',
      value: 'Draft review',
    });
    await expect(fixture.findByRole('image', { name: 'Review logo' })).resolves.toEqual({
      role: 'image',
      name: 'Review logo',
    });

    await fixture.dispose();
  });

  it('invokes a real controlled List option without inventing a test-only selection path', async () => {
    function AuthorSurface() {
      const [selected, setSelected] = useState<'current' | 'previous'>('current');
      return (
        <List accessibilityLabel="Review versions">
          <List.Item
            title="Current review"
            accessibilityRole="option"
            selected={selected === 'current'}
            onPress={() => setSelected('current')}
          />
          <List.Item
            title="Previous review"
            accessibilityRole="option"
            selected={selected === 'previous'}
            onPress={() => setSelected('previous')}
          />
        </List>
      );
    }

    const fixture = await createPluginUiTestkit({
      identity,
      surface: defineUiSurface(AuthorSurface),
      surfaceContext: createSurfaceContext(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
    });

    try {
      const previous = await fixture.getByRole('option', {
        name: 'Previous review',
        state: { selected: false },
      });

      await fixture.press(previous);

      await expect(fixture.getByRole('option', {
        name: 'Previous review',
        state: { selected: true },
      })).resolves.toEqual({
        role: 'option',
        name: 'Previous review',
        state: { selected: true },
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('invokes public Select radio and checkbox choices through the same bounded semantic action', async () => {
    function AuthorSurface() {
      const [selectedVersion, setSelectedVersion] = useState<'current' | 'previous'>('current');
      const [selectedLabels, setSelectedLabels] = useState<readonly ('needs-follow-up' | 'ready')[]>(['ready']);
      return (
        <>
          <Select
            label="Review version"
            options={[
              { value: 'current', label: 'Current review' },
              { value: 'previous', label: 'Previous review' },
            ]}
            value={selectedVersion}
            onChange={(next) => {
              if (typeof next === 'string' && (next === 'current' || next === 'previous')) {
                setSelectedVersion(next);
              }
            }}
          />
          <Select
            label="Review labels"
            multiple
            options={[
              { value: 'needs-follow-up', label: 'Needs follow-up' },
              { value: 'ready', label: 'Ready' },
            ]}
            value={selectedLabels}
            onChange={(next) => {
              if (Array.isArray(next) && next.every((value): value is 'needs-follow-up' | 'ready' => (
                value === 'needs-follow-up' || value === 'ready'
              ))) {
                setSelectedLabels(next);
              }
            }}
          />
        </>
      );
    }

    const fixture = await createPluginUiTestkit({
      identity,
      surface: defineUiSurface(AuthorSurface),
      surfaceContext: createSurfaceContext(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
    });

    try {
      const previous = await fixture.getByRole('radio', {
        name: 'Previous review',
        state: { checked: false },
      });

      await fixture.press(previous);

      await expect(fixture.getByRole('radio', {
        name: 'Previous review',
        state: { checked: true },
      })).resolves.toEqual({
        role: 'radio',
        name: 'Previous review',
        state: { checked: true },
      });

      const needsFollowUp = await fixture.getByRole('checkbox', {
        name: 'Needs follow-up',
        state: { checked: false },
      });

      await fixture.press(needsFollowUp);

      await expect(fixture.getByRole('checkbox', {
        name: 'Needs follow-up',
        state: { checked: true },
      })).resolves.toEqual({
        role: 'checkbox',
        name: 'Needs follow-up',
        state: { checked: true },
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('keeps directly mounted public composite semantics observable through the fixture', async () => {
    function AuthorSurface() {
      const [tab, setTab] = useState('overview');
      return (
        <>
          <Form
            hints={{ fields: [] }}
            value={{}}
            onChange={() => undefined}
            onSubmit={() => undefined}
          />
          <Select
            label="Review scope"
            options={[
              { value: 'current', label: 'Current review' },
              { value: 'all', label: 'All reviews' },
            ]}
            value="current"
            onChange={() => undefined}
          />
          <Tabs value={tab} onValueChange={setTab} ariaLabel="Review sections">
            <Tabs.Item value="overview" title="Overview"><Text value="Overview content" /></Tabs.Item>
            <Tabs.Item value="history" title="History"><Text value="History content" /></Tabs.Item>
          </Tabs>
          <Divider accessibilityLabel="Review sections divider" />
        </>
      );
    }

    const fixture = await createPluginUiTestkit({
      identity,
      surface: defineUiSurface(AuthorSurface),
      surfaceContext: createSurfaceContext(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
    });

    try {
      await expect(fixture.getByRole('form')).resolves.toMatchObject({ role: 'form' });
      await expect(fixture.getByRole('radiogroup', { name: 'Review scope' })).resolves.toEqual({
        role: 'radiogroup',
        name: 'Review scope',
      });
      await expect(fixture.getByRole('tabpanel', { name: 'Overview' })).resolves.toEqual({
        role: 'tabpanel',
        name: 'Overview',
      });
      await expect(fixture.getByRole('separator', { name: 'Review sections divider' })).resolves.toEqual({
        role: 'separator',
        name: 'Review sections divider',
      });

      await fixture.press(await fixture.getByRole('tab', { name: 'History' }));
      await expect(fixture.getByRole('tabpanel', { name: 'History' })).resolves.toEqual({
        role: 'tabpanel',
        name: 'History',
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('reads text from the mounted document when the ambient NodeFilter global is unavailable', async () => {
    function AuthorSurface() {
      return <Text value="Document-owned semantic text" />;
    }

    vi.stubGlobal('NodeFilter', undefined);
    try {
      const fixture = await createPluginUiTestkit({
        identity,
        surface: defineUiSurface(AuthorSurface),
        surfaceContext: createSurfaceContext(),
        adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      });
      try {
        await expect(fixture.getByText('Document-owned semantic text'))
          .resolves.toEqual({ content: 'Document-owned semantic text' });
      } finally {
        await fixture.dispose();
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not press an identical role/name replacement after an author re-render', async () => {
    let firstPresses = 0;
    let replacementPresses = 0;

    function AuthorSurface() {
      const [replacementVisible, setReplacementVisible] = useState(false);
      return (
        <>
          <Button title="Replace retry" onPress={() => { setReplacementVisible(true); }} />
          {replacementVisible ? (
            <Button key="replacement" title="Retry review" onPress={() => { replacementPresses += 1; }} />
          ) : (
            <Button key="original" title="Retry review" onPress={() => { firstPresses += 1; }} />
          )}
        </>
      );
    }

    const fixture = await createPluginUiTestkit({
      identity,
      surface: defineUiSurface(AuthorSurface),
      surfaceContext: createSurfaceContext(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
    });
    const retained = await fixture.getByRole('button', { name: 'Retry review' });

    await fixture.press(await fixture.getByRole('button', { name: 'Replace retry' }));
    await expect(fixture.press(retained)).rejects.toMatchObject({ code: 'stale_surface' });
    expect(firstPresses).toBe(0);
    expect(replacementPresses).toBe(0);

    await fixture.dispose();
  });

  it('keeps a retained control bound to itself after keyed siblings reorder', async () => {
    let firstReviewPresses = 0;
    let secondReviewPresses = 0;

    function AuthorSurface() {
      const [reversed, setReversed] = useState(false);
      const reviewButtons = reversed ? [
        <Button key="second" title="Second review" onPress={() => { secondReviewPresses += 1; }} />,
        <Button key="first" title="First review" onPress={() => { firstReviewPresses += 1; }} />,
      ] : [
        <Button key="first" title="First review" onPress={() => { firstReviewPresses += 1; }} />,
        <Button key="second" title="Second review" onPress={() => { secondReviewPresses += 1; }} />,
      ];
      return (
        <>
          <Button title="Reverse reviews" onPress={() => { setReversed(true); }} />
          {reviewButtons}
        </>
      );
    }

    const fixture = await createPluginUiTestkit({
      identity,
      surface: defineUiSurface(AuthorSurface),
      surfaceContext: createSurfaceContext(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
    });
    const retained = await fixture.getByRole('button', { name: 'First review' });

    await fixture.press(await fixture.getByRole('button', { name: 'Reverse reviews' }));
    await fixture.press(retained);

    expect(firstReviewPresses).toBe(1);
    expect(secondReviewPresses).toBe(0);
    await fixture.dispose();
  });

  it('revalidates retained semantic facts before pressing a still-mounted element', async () => {
    let retryPresses = 0;

    function AuthorSurface() {
      const [renamed, setRenamed] = useState(false);
      return (
        <>
          <Button title="Rename retry" onPress={() => { setRenamed(true); }} />
          <Button title={renamed ? 'Retry review now' : 'Retry review'} onPress={() => { retryPresses += 1; }} />
        </>
      );
    }

    const fixture = await createPluginUiTestkit({
      identity,
      surface: defineUiSurface(AuthorSurface),
      surfaceContext: createSurfaceContext(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
    });
    const retained = await fixture.getByRole('button', { name: 'Retry review' });

    await fixture.press(await fixture.getByRole('button', { name: 'Rename retry' }));
    await expect(fixture.press(retained)).rejects.toMatchObject({ code: 'stale_surface' });
    expect(retryPresses).toBe(0);

    await fixture.dispose();
  });

  it('restores the document body when the initial author render fails', async () => {
    const initialRenderFailure = new Error('initial author render failed');
    const bodyChildCount = document.body.children.length;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    function ThrowingAuthorSurface() {
      throw initialRenderFailure;
    }

    try {
      await expect(createPluginUiTestkit({
        identity: { ...identity, generation: 'initial-render-failure' },
        surface: defineUiSurface(ThrowingAuthorSurface),
        surfaceContext: createSurfaceContext(),
        adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      })).rejects.toBe(initialRenderFailure);
      expect(document.body.children).toHaveLength(bodyChildCount);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('shares a throwing adapter cleanup with public retire and dispose while removing its container', async () => {
    const cleanupFailure = new Error('author cleanup failed');
    const bodyChildCount = document.body.children.length;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    function ThrowingCleanupAuthorSurface() {
      useEffect(() => () => { throw cleanupFailure; }, []);
      return <Text value="Cleanup failure surface" />;
    }

    try {
      const fixture = await createPluginUiTestkit({
        identity: { ...identity, generation: 'throwing-cleanup' },
        surface: defineUiSurface(ThrowingCleanupAuthorSurface),
        surfaceContext: createSurfaceContext(),
        adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      });
      const [retired, disposed] = await Promise.allSettled([
        fixture.retire('author cleanup failure'),
        fixture.dispose(),
      ]);

      expect(retired).toEqual({ status: 'rejected', reason: cleanupFailure });
      expect(disposed).toEqual({ status: 'rejected', reason: cleanupFailure });
      expect(document.body.children).toHaveLength(bodyChildCount);
    } finally {
      consoleError.mockRestore();
    }
  });
});
