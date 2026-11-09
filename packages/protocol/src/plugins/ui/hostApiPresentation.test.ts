import { describe, expect, it } from 'vitest';
import { z } from 'zod/mini';
import { projectPluginUiRenderContextForHostApiVersionV1 } from './hostApiPresentation.js';

describe('destination instance identity across Host API generations', () => {
  it('keeps page navigation out of an installed closed 1.0 page context', () => {
    const reader = z.object({ surface: z.object({ page: z.strictObject({ columnVisible: z.boolean() }) }) });
    const snapshot = { surface: { page: { columnVisible: true, navigation: {
      pageKind: { pluginId: 'happier.triage', localId: 'entry' }, tabIds: ['overview'], presentation: 'local',
    } } } };
    expect(reader.safeParse(snapshot).success).toBe(false);
    expect(reader.safeParse(projectPluginUiRenderContextForHostApiVersionV1(snapshot, '1.0.0')).success).toBe(true);
    expect(projectPluginUiRenderContextForHostApiVersionV1(snapshot, '1.1.0')).toBe(snapshot);
  });
  // Installed API 1.0 destination mounts had these three fields and a closed reader.
  const installedReader = z.object({ surface: z.object({ mount: z.strictObject({
    kind: z.literal('destination'), destination: z.strictObject({ pluginId: z.string(), localId: z.string() }),
    container: z.string(),
  }) }) });
  it.each([false, true])('keeps the installed closed reader usable with statusTint present=%s', statusTint => {
    const snapshot = { surface: { mount: { kind: 'destination',
      destination: { pluginId: 'acme.reviews', localId: 'details' }, container: 'detailsTab',
      instanceKey: 'https://forge.example/acme/widgets/pull/42' },
      theme: { version: 1, ...(statusTint ? { statusTint: { success: '#008800' } } : {}) } } };
    expect(installedReader.safeParse(snapshot).success).toBe(false);
    const legacy = projectPluginUiRenderContextForHostApiVersionV1(snapshot, '1.0.0');
    expect(installedReader.safeParse(legacy).success).toBe(true);
    expect(legacy).not.toHaveProperty('surface.mount.instanceKey');
    expect(legacy).not.toHaveProperty('surface.theme.statusTint');
    expect(projectPluginUiRenderContextForHostApiVersionV1(snapshot, '1.1.0')).toBe(snapshot);
  });
  it('keeps a companion openedFrom out of an installed closed 1.0 surface context', () => {
    const reader = z.object({ surface: z.strictObject({ locale: z.string() }) });
    const snapshot = { surface: { locale: 'en', openedFrom: {
      pageKind: { pluginId: 'happier.triage', localId: 'triage' }, subPath: 'e,happier.scm.forge.github,github-forge,issue,1,56',
    } } };
    expect(reader.safeParse(snapshot).success).toBe(false);
    const legacy = projectPluginUiRenderContextForHostApiVersionV1(snapshot, '1.0.0');
    expect(reader.safeParse(legacy).success).toBe(true);
    expect(projectPluginUiRenderContextForHostApiVersionV1(snapshot, '1.1.0')).toBe(snapshot);
  });
});
