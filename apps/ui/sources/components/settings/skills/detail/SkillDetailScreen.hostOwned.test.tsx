import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createSkillsSurfaceItem } from '@/dev/testkit/harness/skillsSurfaceHarness';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import {
  ExternalActionRequestEnvelopeV1Schema,
  ExternalActionResponseEnvelopeV1Schema,
} from '@happier-dev/protocol/actions/externalActionApi';
import { SKILL_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import type { SkillListItemV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import { SkillReadResultV1Schema } from '@happier-dev/protocol/prompts/library/skills/skillReadV1';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock({
    router: { push: vi.fn(), replace: vi.fn(), back: vi.fn() },
    navigation: { canGoBack: () => false },
  }).module;
});
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock({ spies: {} }).module;
});

installDisconnectedServerSocketBoundary();
const { storage } = await import('@/sync/domains/state/storage');
const { SkillDetailScreen } = await import('./SkillDetailScreen');

const PLUGIN_ID = 'com.acme.skills';
const PLUGIN_SKILL_ID = `plugin:${PLUGIN_ID}/check`;
const SKILL_MD =
  '---\nname: acme-check\ndescription: Check things for Acme.\n---\n\n# Check\n';

let teardown: (() => Promise<void> | void) | undefined;
afterEach(async () => {
  standardCleanup();
  const { resetPromptLibraryCatalogEngineForTests } =
    await import('@/sync/engine/settings/promptLibraryCatalogEngine');
  const { resetPromptLibraryCatalogSnapshotsForTests } =
    await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
  resetPromptLibraryCatalogEngineForTests();
  resetPromptLibraryCatalogSnapshotsForTests();
  await teardown?.();
  teardown = undefined;
});

/**
 * A plugin-declared Skill reaches the page the way it does in the app: the committed plugin projection names it,
 * and the supplying Machine answers the Account Action transport (the genuine HTTP boundary).
 */
async function pluginSkillHome(origin: string, skill: Partial<SkillListItemV1> = {}) {
  const [
    { normalizePluginUiProjection },
    { createPluginUiExecutionOriginCandidatePublication, unionPluginUiProjections },
    { publishCommittedAppShellPluginUiProjection },
  ] = await Promise.all([
    import('@/sync/domains/plugins/ui/projection'),
    import('@/sync/domains/plugins/ui/projectionUnion'),
    import('@/components/appShell/plugins/committedPluginUiProjection'),
  ]);
  const machine = createMachineFixture({
    id: 'plugin-machine',
    active: true,
    activeAt: Date.now(),
  });
  const published = {
    ...createPlainMachineRowFixture({ id: machine.id, accountId: 'artifact-account', machine }),
    installationId: 'plugin-installation',
  };
  const catalog = createPromptLibraryCatalogBoundary();
  const item = createSkillsSurfaceItem(PLUGIN_SKILL_ID, {
    name: 'acme-check',
    description: 'Check things for Acme.',
    provenance: {
      kind: 'plugin',
      pluginId: PLUGIN_ID,
      occurrenceId: 'acme-runtime',
    },
    ...skill,
  });
  const read = SkillReadResultV1Schema.parse({
    skillId: PLUGIN_SKILL_ID,
    name: 'acme-check',
    skillMd: SKILL_MD,
    revision: item.revision,
    provenance: item.provenance,
    modified: false,
    trust: item.trust,
    cost: item.cost,
    rules: item.rules,
    files: [{ path: 'SKILL.md', bytes: SKILL_MD.length }],
  });
  const fixture = await createPlainArtifactHomeFixture(origin, {
    serverFeatures: createRootLayoutFeaturesResponse(),
    currentAccount: true,
    handleRequest: async (path, init) => {
      if (path === '/v2/account/settings/history')
        return Response.json({ snapshots: [] });
      if (path === '/v1/machines/read-batch' && init?.method === 'POST')
        return createMachineReadBatchResponseFixture(init.body, (id) => (id === machine.id
          ? published
          : null));
      if (path.startsWith('/v1/machines')) return Response.json([published]);
      if (
        path === '/v1/actions/skills.list' ||
        path === '/v1/actions/skills.read'
      ) {
        const actionId = path.endsWith('skills.list')
          ? 'skills.list'
          : 'skills.read';
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse(
          JSON.parse(String(init?.body)),
        );
        const result =
          actionId === 'skills.list'
            ? SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.list'].parse({
                items: [item],
                revision: 'r1',
              })
            : read;
        return Response.json(
          ExternalActionResponseEnvelopeV1Schema.parse({
            v: 1,
            actionId,
            requestId: envelope.requestId,
            execution: { ok: true, result },
          }),
        );
      }
      return catalog.handle(path, init);
    },
  });
  const { adoptHomeProfile } = await import('@/sync/domains/server/serverProfiles');
  const qualified = await adoptHomeProfile({
    source: 'manual',
    descriptor: {
      v: 1, homeServerIdentityId: 'srv_plugin_skill_readonly', canonicalServerUrl: origin, revision: 1,
      endpoints: [{ kind: 'https', url: origin }],
    },
  });
  if (!qualified.serverIdentityId) throw new Error('Expected a qualified Home');
  const scope = { serverId: qualified.serverIdentityId, accountId: 'artifact-account' };
  const originFor = (machineId: string) => ({
    serverIdentityId: qualified.serverIdentityId!,
    materializationRef: {
      machineId,
      pluginId: PLUGIN_ID,
      materializationId: machineId,
    },
  });
  const projection = normalizePluginUiProjection(
    PluginProjectionV2Schema.parse({
      v: 2,
      generation: 1,
      installedPackagesById: {
        [PLUGIN_ID]: {
          id: PLUGIN_ID,
          displayName: 'Acme Skills',
          version: '1.0.0',
          enabled: true,
          occurrenceId: 'acme-runtime',
          executionOrigin: originFor(machine.id),
          source: { kind: 'path', locator: '/plugins/acme' },
        },
      },
      agentsById: {},
      actionsById: {},
      toolsById: {},
      commandsById: {},
      resourcesById: {},
      settingsById: {},
      diagnostics: [],
      familiesById: {
        skills: {
          family: 'skills',
          entriesById: {
            [`${PLUGIN_ID}/check`]: {
              id: `${PLUGIN_ID}/check`,
              pluginId: PLUGIN_ID,
              pluginVersion: '1.0.0',
              occurrenceId: 'acme-runtime',
              executionOrigin: originFor(machine.id),
              definition: { id: 'check', directory: './skills/check' },
            },
          },
        },
      },
    }),
  );
  const union = unionPluginUiProjections([
    {
      machineId: machine.id,
      serverId: scope.serverId,
      projection,
      phase: 'current',
      interactionEnabled: true,
    },
  ]).pluginUiProjection;
  const candidates = createPluginUiExecutionOriginCandidatePublication();
  candidates.publish(union, [], [PLUGIN_ID]);
  const stop = publishCommittedAppShellPluginUiProjection(() => union,
    id => candidates.getSnapshot().get(id) ?? null);
  storage.setState({
    settingsScope: scope,
    profileScope: scope,
    isDataReady: true,
    artifactsLoaded: true,
  });
  storage.getState().applyMachines([createMachineFixture({ ...machine, access: published.access })], true,
    { sourceServerId: scope.serverId, sourceAccountId: scope.accountId });
  teardown = async () => {
    stop();
    await fixture.dispose();
  };
  return fixture;
}

describe('SkillDetailScreen for a Skill a plugin declares', () => {
  it('is read-only like the built-in Skill: no editing, no file changes and no Remove, but it can be copied', async () => {
    await pluginSkillHome('https://skill-detail-plugin-readonly.test');
    const screen = await renderScreen(
      <SkillDetailScreen skillId={PLUGIN_SKILL_ID} />,
    );
    await vi.waitFor(
      async () => {
        await flushHookEffects();
        expect(
          screen.findByTestId('skill.detail.instructions'),
          screen.getTextContent(),
        ).toBeTruthy();
      },
      { timeout: 20_000 },
    );

    expect(screen.findByTestId('skill.detail.instructions:edit')).toBeNull();
    expect(screen.findByTestId('skill.detail.files:add')).toBeNull();
    expect(screen.findByTestId('skill.detail.remove')).toBeNull();
    expect(screen.findByTestId('skill.detail.header.menu')).toBeTruthy();
  });
  it('reads a folded multi-line description as one sentence and says Off once, in Where it is on, not beside the title', async () => {
    await pluginSkillHome('https://skill-detail-plugin-off.test', {
      description: 'Check things\n  for Acme,\nevery morning.',
      rules: [],
    });
    const screen = await renderScreen(<SkillDetailScreen skillId={PLUGIN_SKILL_ID} />);
    await vi.waitFor(
      async () => {
        await flushHookEffects();
        expect(screen.findByTestId('skill.detail.instructions'), screen.getTextContent()).toBeTruthy();
      },
      { timeout: 20_000 },
    );

    expect(screen.getTextContent()).toContain('Check things for Acme, every morning.');
    expect(screen.findByTestId('skill.detail.header.status')).toBeNull();
  });
});
