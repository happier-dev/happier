import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SkillReadResultV1 } from '@happier-dev/protocol/prompts/library/skills/skillReadV1';
import { SkillReadResultV1Schema } from '@happier-dev/protocol/prompts/library/skills/skillReadV1';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

import { createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';
import { t } from '@/text';

import { skillSource } from '../skillsCollectionModel';
import { SkillSourceSection } from './SkillSourceSection';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('@shopify/react-native-skia', async () => (await import('@/dev/testkit/mocks/reactNativeSkia')).createReactNativeSkiaMock());
// Select the real browser paint adapter; native Skia handles do not exist in this Node host.
vi.mock('@/components/sessions/bots/face/BotFaceRasterView', async () => import('@/components/sessions/bots/face/BotFaceRasterView.web'));

afterEach(() => {
  standardCleanup();
  storage.setState({ machines: {} });
});

function read(
  provenance: SkillReadResultV1['provenance'],
  upstream?: SkillReadResultV1['upstream'],
): SkillReadResultV1 {
  return {
    skillId: 's',
    name: 'code-review',
    skillMd: '---\nname: code-review\n---\n',
    revision: 'r1',
    provenance,
    ...(upstream ? { upstream } : {}),
    modified: false,
    trust: 'text_only',
    cost: { descriptionTokens: 10, bodyTokens: 1400 },
    rules: [],
    files: [{ path: 'SKILL.md', bytes: 120 }],
  };
}

const common = {
  machineName: (id: string) => id,
  checkNow: () => undefined,
  checking: false,
  checkedAt: null,
  checkFailed: false,
  onViewUpdate: () => undefined,
  update: async () => ({ ok: true as const, revision: 'r2' }),
  testID: 'src',
};

describe('SkillSourceSection', () => {
  it('keeps legacy written origin neutral and only opens a creator with an accessible identity', async () => {
    const { presentSkillMaker } = await import('../skillMaker');
    const { createSessionListRenderableSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
    const creator = { kind: 'agent' as const, accountId: 'me', sessionId: 'maker' };
    const scope = { accountId: 'me', serverId: 'home' };
    const maker = presentSkillMaker({ creator }, scope, createSessionListRenderableSessionFixture({ id: 'maker',
      metadata: { path: '/project', name: 'Researcher', bot: { kind: 'bot' } } }));
    const open = vi.fn();
    const screen = await renderScreen(<SkillSourceSection {...common} read={read({ kind: 'written' })}
      updatePolicy="manual" maker={maker} onOpenCreator={open} />);
    try {
      expect(screen.findAll(node => node.props.testID === 'src:source' && node.props.title !== undefined)[0]?.props.title)
        .toBe(t('capabilities.skills.maker.createdHere'));
      expect(screen.getTextContent()).not.toContain(t('capabilities.skillDetail.source.writtenByYou'));
      expect(screen.findByTestId('src:maker')).not.toBeNull();
      await screen.pressByTestId('src:openCreator');
      expect(open).toHaveBeenCalledOnce();
      await screen.update(<SkillSourceSection {...common} read={read({ kind: 'written' })} updatePolicy="manual"
        maker={presentSkillMaker({ creator }, scope)} onOpenCreator={open} />);
      expect(screen.findByTestId('src:openCreator')).toBeNull();
      expect(screen.findByTestId('src:maker')).not.toBeNull();
    } finally { await screen.unmount(); }
  });

  it('keeps digest-pinned index skills on the existing update and outside-reference path', async () => {
    const provenance = {
      kind: 'wellKnown' as const,
      indexUrl: 'https://skills.example.test/.well-known/skills/index.json',
      name: 'code-review',
      digest: `sha256:${'a'.repeat(64)}`,
    };
    const screen = await renderScreen(
      <SkillSourceSection {...common} read={withReference(provenance)} updatePolicy="manual" />,
    );
    expect(screen.findByTestId('src:source')).not.toBeNull();
    expect(screen.getTextContent()).toContain('skills.example.test');
    expect(screen.findByTestId('src:checkNow')).not.toBeNull();
    expect(screen.findByTestId('src:auto')).not.toBeNull();
    expect(screen.findByTestId('src:pin')).not.toBeNull();
    expect(screen.findHostByTestId('src:outsideReferences')).not.toBeNull();
    expect(skillSource({ provenance }, common.machineName)).toEqual({ kind: 'link', host: 'skills.example.test' });
    expect(screen.getTextContent()).toContain(t('capabilities.skillDetail.source.noDigestPublished'));
    await screen.update(<SkillSourceSection {...common} read={read({ ...provenance, publishedDigest: `sha256:${'b'.repeat(64)}` })} updatePolicy="manual" />);
    expect(screen.getTextContent()).toContain(t('capabilities.skillDetail.source.verifiedByDigest'));
    expect(screen.getTextContent()).not.toContain(t('capabilities.skillDetail.source.noDigestPublished'));
  });

  it('names the supplying plugin and omits unknown source metadata without claiming personal ownership', async () => {
    const pluginId = 'com.acme.skills';
    const pluginRead = SkillReadResultV1Schema.parse({ ...read({
      kind: 'plugin', pluginId, occurrenceId: 'acme-runtime',
    }), revision: '1:1' });
    const projection = normalizePluginUiProjection(PluginProjectionV2Schema.parse({ v: 2, generation: 1,
      installedPackagesById: { [pluginId]: { id: pluginId, displayName: 'Acme Skills', enabled: true,
        source: { kind: 'path', locator: '/plugins/acme' } } },
    }));
    const source = skillSource(pluginRead, common.machineName, projection.installedPackagesById);
    if (source?.kind !== 'plugin') throw new Error('Canonical plugin source metadata must be available');
    const screen = await renderScreen(<SkillSourceSection {...common} read={pluginRead}
      pluginSource={source} updatePolicy="manual" />);
    expect(screen.findByTestId('src:source')).not.toBeNull();
    expect(screen.getTextContent()).toContain('Acme Skills');
    expect(screen.getTextContent()).not.toContain(t('capabilities.skillDetail.source.descriptionOwn'));
    expect(screen.findByTestId('src:checkNow')).toBeNull();
    expect(screen.findByTestId('src:auto')).toBeNull();
    expect(screen.findByTestId('src:pin')).toBeNull();

    await screen.update(<SkillSourceSection {...common} read={pluginRead} updatePolicy="manual" />);
    expect(screen.findByTestId('src:source')).toBeNull();
    expect(screen.getTextContent()).not.toContain(pluginId);
    expect(screen.getTextContent()).not.toContain(t('capabilities.skillDetail.source.descriptionOwn'));
    await screen.update(<SkillSourceSection {...common} read={pluginRead}
      pluginSource={source} updatePolicy="manual" />);
    expect(screen.getTextContent()).toContain('Acme Skills');
  });

  it('a built-in skill says it follows Happier once, in its source row', async () => {
    const screen = await renderScreen(
      <SkillSourceSection {...common} read={read({ kind: 'first_party' })} updatePolicy="manual" />,
    );
    expect(screen.getTextContent().match(/follows its version|updates with Happier/g) ?? []).toHaveLength(1);
  });

  it('a written origin offers no update controls without claiming its maker', async () => {
    const screen = await renderScreen(
      <SkillSourceSection
        {...common}
        read={read({ kind: 'written' })}
        updatePolicy="manual"
      />,
    );
    expect(screen.getTextContent()).toContain(t('capabilities.skills.maker.createdHere'));
    expect(screen.findAllByTestId('src:checkNow')).toHaveLength(0);
    expect(screen.findAllByTestId('src:auto')).toHaveLength(0);
    expect(screen.findAllByTestId('src:pin')).toHaveLength(0);
  });

  it('a registry skill shows its update state with Check now, automatic updates and pinning', async () => {
    const screen = await renderScreen(
      <SkillSourceSection
        {...common}
        updatePolicy="manual"
        read={read(
          {
            kind: 'registry',
            registry: {
              sourceId: 'skills-sh',
              format: 'skills-sh',
              sourceUrl: 'https://github.com/anthropics/skills',
              itemId: 'code-review',
              importedAt: 1,
              ref: {
                kind: 'gitTree',
                repo: 'anthropics/skills',
                path: 'skills/code-review',
                commit: '4f2a1c9aaaa',
                treeSha: 't',
              },
            },
          } as SkillReadResultV1['provenance'],
          { state: 'current' },
        )}
      />,
    );
    expect(screen.getTextContent()).toContain('anthropics/skills');
    expect(screen.getTextContent()).toContain('Up to date');
    expect(screen.findAllByTestId('src:checkNow').length).toBeGreaterThan(0);
    expect(screen.findAllByTestId('src:auto').length).toBeGreaterThan(0);
  });
  const withReference = (provenance: SkillReadResultV1['provenance']): SkillReadResultV1 => ({
    ...read(provenance),
    skillMd: '---\nname: code-review\n---\nFollow [the checklist](../../shared/checklist.md).',
  });

  it('notes the files an imported skill points at that its copy lacks', async () => {
    const screen = await renderScreen(
      <SkillSourceSection {...common} read={withReference({ kind: 'upload', importedAt: 1 })} updatePolicy="manual" />,
    );
    expect(screen.findHostByTestId('src:outsideReferences')).not.toBeNull();
    expect(screen.getTextContent()).toContain('../../shared/checklist.md');
  });

  it('says nothing for a skill written here, whose references are the author’s own', async () => {
    const screen = await renderScreen(
      <SkillSourceSection {...common} read={withReference({ kind: 'written' })} updatePolicy="manual" />,
    );
    expect(screen.findHostByTestId('src:outsideReferences')).toBeNull();
  });
  it('writes the folder a found skill came from relative to that machine\'s home', async () => {
    const machine = createMachineFixture({ id: 'mac-1' });
    storage.setState({
      machines: { 'mac-1': { ...machine, metadata: { ...machine.metadata!, homeDir: '/home/leeroy' } } },
    });
    const screen = await renderScreen(
      <SkillSourceSection
        {...common}
        read={read({ kind: 'machine', machineId: 'mac-1', path: '/home/leeroy/.claude/skills/code-review', importedAt: 1 } as SkillReadResultV1['provenance'])}
        updatePolicy="manual"
      />,
    );
    expect(screen.getTextContent()).toContain('~/.claude/skills/code-review');
    expect(screen.getTextContent()).not.toContain('/home/leeroy');
  });
});
