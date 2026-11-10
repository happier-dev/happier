import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act, createDeferred, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import type { CodeEditorProps, TextEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPromptRegistrySkillFixture } from '@/dev/testkit/harness/promptMachineTransferBoundary';
import {
  PromptBundleArtifactHeaderV1Schema,
  PromptBundleBodyV1Schema,
} from '@happier-dev/protocol/prompts/library/promptBundleSchemas';
import {
  ARTIFACT_PLAIN_DATA_KEY_MARKER,
  encodePlainArtifactStoredContent,
} from '@happier-dev/protocol/storage/artifactStoredContent';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import type { PromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';

// The person's answer to Remove's confirmation is the boundary (the shared modal presenter).
const modalSpies = vi.hoisted(() => ({
  confirm: vi.fn(async () => false),
  alert: vi.fn(),
}));
const skillEditorBoundary = vi.hoisted(() => ({ flush: vi.fn(async () => undefined) }));
const navigation = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }));
const removal = vi.hoisted(() => ({ enabled: false, callback: null as null | ((event: { data: { action: unknown } }) => void) }));
vi.mock('@react-navigation/native', async () =>
  (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock({
    usePreventRemove: (enabled, callback) => { removal.enabled = enabled; removal.callback = callback; },
  }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router: navigation }).module);
const clipboardPlatform = vi.hoisted(() => ({ os: 'web' }));
const clipboard = vi.hoisted(() => ({ setStringAsync: vi.fn(async (_text: string) => true) }));
vi.mock('expo-clipboard', () => clipboard);
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
  Platform: { get OS() { return clipboardPlatform.os; } },
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
// The native/browser editor engine is external; its real Markdown field and skill save owners remain mounted.
vi.mock('@/components/ui/code/editor/CodeEditor', async () => {
  const React = await import('react');
  return { CodeEditor: React.forwardRef<TextEditorHandle, CodeEditorProps>((props, ref) => {
    React.useImperativeHandle(ref, () => ({ getValue: () => props.value, flushPendingChange: skillEditorBoundary.flush }), [props.value]);
    return React.createElement('SkillEditorBoundary', { testID: 'skill.test.editor', value: props.value, onChangeText: props.onChange });
  }) };
});
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock({ spies: modalSpies }).module;
});

// The browser download / share sheet is the platform boundary of Export.
const fileSaves = vi.hoisted(() => ({ saveFileBytes: vi.fn(async (_input: { bytes: Uint8Array; fileName: string; mimeType: string }) => 'saved' as const) }));
vi.mock('@/sync/runtime/files/saveFileBytes', () => fileSaves);

installDisconnectedServerSocketBoundary();
const { storage } = await import('@/sync/domains/state/storage');
const { resetPromptLibraryCatalogEngineForTests } =
  await import('@/sync/engine/settings/promptLibraryCatalogEngine');
const { resetPromptLibraryCatalogSnapshotsForTests } =
  await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
const { useSkillDetail } = await import('./useSkillDetail');
const { useReachRules } = await import('@/sync/domains/capabilities/reach/useReachRules');
const { useSkillsLibrary } = await import('@/sync/domains/skills/useSkillsLibrary');
const { getPromptLibraryCatalogValue } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
const { readPresentationNotice, retirePresentationNotice } = await import('@/components/sessions/presentation/presentationNotices');
const { SkillInstructionsSection, useSkillTextAutosave } = await import('./SkillInstructionsSection');
const { ItemList } = await import('@/components/ui/lists/ItemList');
const { skillTextFile, readSkillText } = await import('./skillFileContent');
const { groupSkillsByFolder } = await import('../skillsCollectionModel');
const { useSkillsUpdates } = await import('../updates/useSkillsUpdates');
const { retrySkillRules } = await import('../add/skillInstall');
const { useMountedActionExecution } = await import('@/components/approvals/useMountedActionExecution');
const { useDraftReachRules } = await import('@/components/capabilities/where/WhereItsOnControl');
const { SKILL_ACTION_OUTPUT_SCHEMAS_V1 } = await import('@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1');

afterEach(() => {
  clipboardPlatform.os = 'web';
  standardCleanup();
  resetPromptLibraryCatalogEngineForTests();
  resetPromptLibraryCatalogSnapshotsForTests();
  vi.useRealTimers();
  retirePresentationNotice();
});

const SKILL_MD =
  '---\nname: release-notes\ndescription: Draft release notes from merged pull requests.\n---\n\n# Release notes\n';

it('honors native clipboard policy for the skill source link', async () => {
  clipboardPlatform.os = 'ios';
  const { normalizeActionsSettingsV1, setActionApprovalOverride } = await import('@happier-dev/protocol/actions/actionSettings');
  let policy: 'off' | 'allowed' = 'off';
  const url = 'https://github.com/fixture/skills';
  const fixture = createPromptRegistrySkillFixture({ sourceId: 'clipboard', itemId: 'review', title: 'release-notes',
    files: [{ path: 'SKILL.md', content: SKILL_MD }] });
  if (fixture.item.payload.kind !== 'skill') throw new Error('Expected skill fixture');
  const home = await seededHome('https://skill-clipboard.test', async path => path === '/v2/account/settings'
    ? Response.json({ version: 1, content: { t: 'plain', v: { actionsSettingsV1:
      normalizeActionsSettingsV1({ ...setActionApprovalOverride({ settings: normalizeActionsSettingsV1({}),
        actionId: 'clipboard.write', surface: 'ui', approvalRequired: false }),
        actions: { 'clipboard.write': { disabledSurfaces: policy === 'off' ? ['ui'] : [] } } }),
    } } }) : null, { header: { skillLock: {
      provenance: { kind: 'link', url, ref: fixture.item.payload.skill.ref }, updatePolicy: 'manual',
    } } });
  await home.hydrateAccountSettings();
  const { SkillDetailScreen } = await import('./SkillDetailScreen');
  const { CapabilityDetailHeader } = await import('@/components/capabilities/detail/CapabilityDetailHeader');
  const screen = await renderScreen(<SkillDetailScreen skillId="release-notes" />);
  try {
    await vi.waitFor(() => expect(screen.findByType(CapabilityDetailHeader).props.menuItems
      .some((item: { id: string }) => item.id === 'copyLink')).toBe(true));
    clipboard.setStringAsync.mockClear();
    const copyLink = () => screen.findByType(CapabilityDetailHeader).props.menuItems
      .find((item: { id: string }) => item.id === 'copyLink').onSelect();
    await act(async () => { await copyLink(); });
    expect(clipboard.setStringAsync).not.toHaveBeenCalled();
    policy = 'allowed';
    await home.hydrateAccountSettings();
    await act(async () => { await copyLink(); });
    expect(clipboard.setStringAsync).toHaveBeenCalledWith(url);
  } finally { await screen.unmount(); await home.dispose(); }
});

it('the existing new route guards an edited Write draft and keeps its text when departure is cancelled', async () => {
  const home = await seededHome('https://skill-new-exit.test');
  const { SkillDetailScreen } = await import('./SkillDetailScreen');
  const screen = await renderScreen(<SkillDetailScreen skillId={null} />);
  const text = `${SKILL_MD}\nNew instructions.`;
  await vi.waitFor(() => expect(screen.findByTestId('skill.draft.header')).not.toBeNull());
  await act(async () => screen.findByType(SkillInstructionsSection).props.draft.onChange(text));
  expect(removal.enabled).toBe(true);
  await act(async () => removal.callback!({ data: { action: { type: 'GO_BACK' } } }));
  expect(modalSpies.alert).toHaveBeenCalled();
  await act(async () => modalSpies.alert.mock.calls.at(-1)![2].find((button: { style?: string }) => button.style === 'cancel').onPress());
  expect(screen.findByType(SkillInstructionsSection).props.draft.text).toBe(text);
  expect(home.boundary.list()).toHaveLength(1);
  await home.dispose();
});

it('locks the explicit Write document while its create is pending so an acknowledgement cannot discard newer typing', async () => {
  const started = createDeferred<void>(), release = createDeferred<void>();
  const home = await seededHome('https://skill-write-pending.test', async (path, init) => {
    if (path === '/v1/artifacts' && init?.method === 'POST') { started.resolve(); await release.promise; }
    return null;
  });
  const { SkillDetailScreen } = await import('./SkillDetailScreen');
  const { CodeEditor } = await import('@/components/ui/code/editor/CodeEditor');
  const screen = await renderScreen(<SkillDetailScreen skillId={null} />);
  try {
    await vi.waitFor(() => expect(screen.findByTestId('skill.draft.header')).not.toBeNull());
    await act(async () => screen.findByType(SkillInstructionsSection).props.draft.onChange(SKILL_MD));
    await act(async () => { screen.pressByTestId('skill.draft.add'); });
    await started.promise;
    expect(screen.findByType(CodeEditor).props.readOnly).toBe(true);
    await act(async () => screen.findByType(SkillInstructionsSection).props.draft.onChange(`${SKILL_MD}\nNew text.`));
    expect(screen.findByType(SkillInstructionsSection).props.draft.text).toBe(SKILL_MD);
  } finally {
    await act(async () => release.resolve());
    await screen.unmount();
    await home.dispose();
  }
});

async function seededHome(
  origin: string,
  handleRequest?: (path: string, init?: RequestInit) => Promise<Response | null>,
  options: Readonly<{ records?: readonly PromptLibraryRecordV1[]; header?: Record<string, unknown>; text?: string;
    handleExternalRequest?: (url: string) => Promise<Response | null> }> = {},
) {
  const catalog = createPromptLibraryCatalogBoundary({ records: options.records });
  const home = await createPlainArtifactHomeFixture(origin, {
    serverFeatures: createRootLayoutFeaturesResponse(),
    handleExternalRequest: options.handleExternalRequest,
    handleRequest: async (path, init) => {
      const intercepted = await handleRequest?.(path, init);
      if (intercepted) return intercepted;
      if (path === '/v2/account/settings/history')
        return Response.json({ snapshots: [] });
      return catalog.handle(path, init);
    },
  });
  const header = PromptBundleArtifactHeaderV1Schema.parse({
    v: 1,
    kind: 'prompt_bundle.v2',
    title: 'release-notes',
    bundleSchemaId: 'skills.skill_md_v1',
    ...options.header,
  });
  const body = PromptBundleBodyV1Schema.parse({
    v: 1,
    createdAtMs: 1,
    updatedAtMs: 1,
    entries: [
      {
        path: 'SKILL.md',
        contentKind: 'utf8',
        contentBase64: encodeBase64(new TextEncoder().encode(options.text ?? SKILL_MD)),
      },
    ],
  });
  const seeded = await home.boundary.handle('/v1/artifacts', {
    method: 'POST',
    body: JSON.stringify({
      id: 'release-notes',
      header: encodePlainArtifactStoredContent(header),
      body: encodePlainArtifactStoredContent({ body: JSON.stringify(body) }),
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
    }),
  });
  expect(seeded?.status).toBe(200);
  // Rows were seeded at the Home boundary; the global Artifact inventory has not synced.
  storage.setState({ isDataReady: true, artifactsLoaded: false });
  return { ...home, catalog };
}

describe('SkillDetailScreen instructions autosave', () => {
  it('deletes a newly written Skill on the first attempt after changing its reach', async () => {
    const home = await seededHome('https://skill-first-delete.test');
    const author = await renderHook(() => useMountedActionExecution(home.home.id));
    let detail: Awaited<ReturnType<typeof renderHook<ReturnType<typeof useSkillDetail>>>> | undefined;
    try {
      await vi.waitFor(() => expect(author.getCurrent().ready).toBe(true));
      const result = await author.getCurrent().execute('skills.create', {
        name: 'release-notes', files: [skillTextFile('SKILL.md', SKILL_MD)],
      });
      const created = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.create'].parse(result.ok ? result.result : null);
      detail = await renderHook(() => useSkillDetail(created.skillId));
      await vi.waitFor(() => expect(detail!.getCurrent().status).toBe('ready'));
      const reach = await renderHook(() => useReachRules('skill', created.skillId));
      try {
        await vi.waitFor(() => expect(reach.getCurrent().status).toBe('ready'));
        for (const rules of [
          [{ target: { t: 'allMachines' as const }, enabled: true }],
          [{ target: { t: 'allMachines' as const }, enabled: false }],
          [{ target: { t: 'allMachines' as const }, enabled: false },
            { target: { t: 'machine' as const, machineId: 'b71f24d9-1ae1-40c8-b61e-932184189daf' }, enabled: true }],
        ]) {
          await act(async () => {
            expect(await reach.getCurrent().change({ kind: 'replace', rules })).toEqual({ ok: true });
          });
        }
      } finally { await reach.unmount(); }
      modalSpies.confirm.mockResolvedValue(true);
      await act(async () => {
        expect(await detail!.getCurrent().remove()).toBe(true);
      });
      expect(home.boundary.read(created.skillId)).toBeNull();
    } finally {
      modalSpies.confirm.mockReset().mockResolvedValue(false);
      await detail?.unmount(); await author.unmount(); await home.dispose();
    }
  });
  it('deletes with its acknowledged save revision before React commits the save', async () => {
    const home = await seededHome('https://skill-save-delete.test');
    const detail = await renderHook(() => useSkillDetail('release-notes'));
    try {
      await vi.waitFor(() => expect(detail.getCurrent().status).toBe('ready'));
      modalSpies.confirm.mockResolvedValue(true);
      await act(async () => {
        expect(await detail.getCurrent().update({ files: [{ kind: 'upsert', file: skillTextFile('SKILL.md', `${SKILL_MD}Saved.\n`) }] })).toMatchObject({ ok: true });
        expect(await detail.getCurrent().remove()).toBe(true);
      });
      expect(home.boundary.read('release-notes')).toBeNull();
    } finally {
      modalSpies.confirm.mockReset().mockResolvedValue(false);
      await detail.unmount(); await home.dispose();
    }
  });
  it('shows the typed delete refusal instead of an unknown error', async () => {
    const home = await seededHome('https://skill-delete-refusal.test', async (path, init) =>
      init?.method === 'DELETE' && path.startsWith('/v1/artifacts/release-notes/')
        ? Response.json({ error: 'version_mismatch' }, { status: 409 }) : null);
    const { SkillDetailScreen } = await import('./SkillDetailScreen');
    const screen = await renderScreen(<SkillDetailScreen skillId="release-notes" />);
    try {
      await vi.waitFor(() => expect(screen.findByTestId('skill.detail.remove')).not.toBeNull());
      modalSpies.alert.mockClear();
      modalSpies.confirm.mockResolvedValue(true);
      await screen.pressByTestIdAsync('skill.detail.remove');
      await vi.waitFor(() => expect(modalSpies.alert).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('revision_conflict')));
      expect(home.boundary.read('release-notes')).not.toBeNull();
    } finally {
      modalSpies.confirm.mockReset().mockResolvedValue(false);
      await screen.unmount(); await home.dispose();
    }
  });
  it.each(['done', 'preview'] as const)('keeps the skill editor and draft when %s cannot confirm its snapshot', async target => {
    const home = await seededHome(`https://skill-unconfirmed-${target}.test`);
    function Instructions() {
      const detail = useSkillDetail('release-notes');
      // The section receives an already loaded body in the real detail page. Keep that input
      // explicit here: this test exercises the native flush, not asynchronous library discovery.
      return <ItemList><SkillInstructionsSection skillId="release-notes" skillMd={SKILL_MD} readOnly={false}
        onSave={text => detail.update({ files: [{ kind: 'upsert', file: skillTextFile('SKILL.md', text) }] })}
        onDirtyChange={detail.setHold} readTheirs={async () => {
          const latest = await detail.readLatest();
          return latest ? { text: latest.skillMd, revision: latest.revision } : null;
        }} adoptTheirs={async () => { const latest = await detail.readLatest(); if (latest) detail.adopt(latest); }} testID="instructions" /></ItemList>;
    }
    const screen = await renderScreen(<Instructions />);
    try {
      expect(screen.findByTestId('instructions:edit')).not.toBeNull();
      await screen.pressByTestIdAsync('instructions:edit');
      expect(screen.findByTestId('instructions:editor')).not.toBeNull();
      modalSpies.alert.mockClear();
      skillEditorBoundary.flush.mockRejectedValueOnce(new Error('snapshot_unconfirmed'));
      if (target === 'done') await screen.pressByTestIdAsync('instructions:done');
      else {
        const { SegmentedTabBar } = await import('@/components/ui/navigation/SegmentedTabBar');
        await act(async () => { screen.findByType(SegmentedTabBar).props.onSelectTab('preview'); });
      }
      await vi.waitFor(() => expect(modalSpies.alert).toHaveBeenCalled());
      expect(screen.findByTestId('instructions:editor')).not.toBeNull();
      expect(screen.findAllByTestId('instructions:preview')).toHaveLength(0);
    } finally { await screen.unmount(); await home.dispose(); }
  });

  it('keeps the draft Off choice through the mounted create Action, stored rules and library projection', async () => {
    const home = await seededHome('https://skill-draft-off.test');
    const draft = await renderHook(() => ({ reach: useDraftReachRules('skill'), action: useMountedActionExecution(home.home.id) }));
    try {
      await vi.waitFor(() => expect(draft.getCurrent().action.ready).toBe(true));
      await act(async () => {
        await draft.getCurrent().reach.onChange({ kind: 'replace', rules: [{ target: { t: 'allMachines' }, enabled: false }] });
      });
      expect(draft.getCurrent().reach.rules.map(rule => rule.enabled)).toEqual([false]);
      const created = await draft.getCurrent().action.execute('skills.create', {
        name: 'release-notes', files: [skillTextFile('SKILL.md', SKILL_MD)], where: draft.getCurrent().reach.where,
      });
      expect(created, JSON.stringify(created)).toMatchObject({ ok: true });
      const receipt = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.create'].parse(created.ok ? created.result : null);
      expect(receipt.incomplete).toBeUndefined();
      const record = home.catalog.read('skill-rules');
      if (record.key !== 'skill-rules') throw new Error('Expected skill rules');
      expect(record.value.rules.filter(rule => rule.skillId === receipt.skillId)).toMatchObject([{ enabled: false }]);
      const listed = await draft.getCurrent().action.execute('skills.list', {});
      const library = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.list'].parse(listed.ok ? listed.result : null);
      expect(library.items.find(item => item.skillId === receipt.skillId)?.rules).toMatchObject([{ enabled: false }]);
    } finally { await draft.unmount(); await home.dispose(); }
  });

  it('saves once per pause with the newest text, and a revision conflict keeps the text and stops saving', async () => {
    vi.useFakeTimers();
    const saves: string[] = [];
    let answer: { ok: true; revision: string } | { ok: false; code: string } = {
      ok: true,
      revision: 'r2',
    };
    const onSave = vi.fn(async (text: string) => {
      saves.push(text);
      return answer;
    });
    const hook = await renderHook(() =>
      useSkillTextAutosave({ saved: SKILL_MD, onSave }),
    );
    try {
      await act(async () => {
        hook.getCurrent().setText(`${SKILL_MD}a`);
        hook.getCurrent().setText(`${SKILL_MD}ab`);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      expect(saves).toEqual([]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(saves).toEqual([`${SKILL_MD}ab`]);
      expect(hook.getCurrent().saveState.kind).toBe('saved');

      answer = { ok: false, code: 'revision_conflict' };
      await act(async () => {
        hook.getCurrent().setText(`${SKILL_MD}abc`);
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(hook.getCurrent().saveState.kind).toBe('conflict');
      expect(hook.getCurrent().text).toBe(`${SKILL_MD}abc`);
      await act(async () => {
        hook.getCurrent().setText(`${SKILL_MD}abcd`);
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(saves).toEqual([`${SKILL_MD}ab`, `${SKILL_MD}abc`]);
      expect(hook.getCurrent().text).toBe(`${SKILL_MD}abcd`);
    } finally {
      await hook.unmount();
    }
  });
});

describe('SkillDetailScreen over the real skills Actions', () => {
  it.each(['keepMine', 'takeTheirs'] as const)('retains dirty instructions and outside-reference warnings through width/focus changes, then resolves %s against the current revision', async choice => {
    const original = `${SKILL_MD}\nRead [the checklist](../../shared/checklist.md).\n`;
    const mine = `${original}\nMy unsaved instructions.\n`;
    const theirs = `${original}\nAnother device's instructions.\n`;
    const home = await seededHome(`https://skill-editor-continuity-${choice.toLowerCase()}.test`, undefined, {
      text: original, header: { skillLock: { provenance: { kind: 'upload', importedAt: 1 }, updatePolicy: 'manual' } },
    });
    const { SkillDetailScreen } = await import('./SkillDetailScreen');
    const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
    const { Dimensions } = await import('react-native');
    const windowSize = Dimensions.get('window');
    const dimensions = vi.spyOn(Dimensions, 'get');
    const view = (active: boolean) => <PluginSurfaceFocusEligibilityProvider active={active}>
      <SkillDetailScreen skillId="release-notes" />
    </PluginSurfaceFocusEligibilityProvider>;
    const screen = await renderScreen(view(true));
    const otherDevice = await renderHook(() => useSkillDetail('release-notes'));
    const editor = () => screen.findHostByTestId('skill.test.editor')!;
    try {
      await vi.waitFor(() => expect(screen.findByTestId('skill.detail.instructions:edit')).not.toBeNull());
      await vi.waitFor(() => expect(otherDevice.getCurrent().status).toBe('ready'));
      await screen.pressByTestIdAsync('skill.detail.instructions:edit');
      await act(async () => { editor().props.onChangeText(mine); });
      for (const [width, active] of [[390, true], [1440, false], [390, true]] as const) {
        dimensions.mockReturnValue({ ...windowSize, width });
        await screen.update(view(active));
        expect(editor().props.value).toBe(mine);
        expect(screen.findByTestId('skill.detail.source:outsideReferences')).not.toBeNull();
        expect(screen.getTextContent()).toContain('../../shared/checklist.md');
        expect(screen.findByTestId('skill.detail.files')).not.toBeNull();
        expect(screen.findByTestId('skill.detail.where')).not.toBeNull();
        expect(screen.findByTestId('skill.detail.remove')).not.toBeNull();
      }
      await act(async () => {
        expect(await otherDevice.getCurrent().update({ files: [{ kind: 'upsert', file: skillTextFile('SKILL.md', theirs) }] }))
          .toMatchObject({ ok: true });
      });
      await vi.waitFor(() => expect(screen.findByTestId('skill.detail.instructions:reviewBoth')).not.toBeNull());
      expect(editor().props.value).toBe(mine);
      await screen.pressByTestIdAsync('skill.detail.instructions:reviewBoth');
      await vi.waitFor(() => expect(screen.findByTestId('skill.detail.instructions:review')).not.toBeNull());
      const { DiffViewer } = await import('@/components/ui/code/diff/DiffViewer');
      expect(screen.findByType(DiffViewer).props).toMatchObject({ oldText: theirs, newText: mine });
      await screen.pressByTestIdAsync(`skill.detail.instructions:${choice}`);
      const expected = choice === 'keepMine' ? mine : theirs;
      await vi.waitFor(async () => expect((await otherDevice.getCurrent().readLatest())?.skillMd).toBe(expected));
      await vi.waitFor(() => expect(editor().props.value).toBe(expected));
      expect(screen.findByTestId('skill.detail.instructions:review')).toBeNull();
      expect(screen.findByTestId('skill.detail.instructions:conflict')).toBeNull();
      expect(screen.findByTestId('skill.detail.source:outsideReferences')).not.toBeNull();
    } finally { dimensions.mockRestore(); await otherDevice.unmount(); await screen.unmount(); await home.dispose(); }
  });

  it.each(['draft', 'duplicate'] as const)('retains the %s acknowledgment and repairs only rules after a refused CAS', async entry => {
    let refuse = true;
    let refusedWrites = 0;
    modalSpies.confirm.mockResolvedValue(true);
    navigation.push.mockClear(); navigation.replace.mockClear();
    const home = await seededHome(`https://skill-${entry}-partial.test`, async (path, init) => {
      if (refuse && path.endsWith('/prompt-library/skill-rules') && init?.method === 'POST') {
        refusedWrites++;
        return Response.json({ status: 'conflict', revision: 2 });
      }
      return null;
    });
    const { SkillDetailScreen } = await import('./SkillDetailScreen');
    const { CapabilityDetailHeader } = await import('@/components/capabilities/detail/CapabilityDetailHeader');
    const screen = await renderScreen(<SkillDetailScreen skillId={entry === 'draft' ? null : 'release-notes'} />);
    try {
      if (entry === 'draft') await screen.pressByTestIdAsync('skill.draft.add');
      else {
        await vi.waitFor(() => expect(screen.findByType(CapabilityDetailHeader).props.menuItems).toBeDefined());
        await act(async () => { await screen.findByType(CapabilityDetailHeader).props.menuItems.find((item: { id: string }) => item.id === 'duplicate').onSelect(); });
      }
      await vi.waitFor(() => expect(refusedWrites).toBeGreaterThan(0));
      const ids = home.boundary.list().map(row => row.id);
      expect(ids).toHaveLength(2);
      const createdId = ids.find(id => id !== 'release-notes')!;
      const partialID = `skill.${entry === 'draft' ? 'draft' : 'detail'}.partial`;
      expect(screen.findByTestId(partialID)).not.toBeNull();
      expect(navigation.push).not.toHaveBeenCalled();
      expect(navigation.replace).not.toHaveBeenCalled();
      const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
      const repair = () => screen.findAllByType(SurfaceStateCard).find(node => node.props.testID === partialID)!.props.action.onPress();
      // A refused retry stays recoverable; it must never repeat the content write.
      await act(async () => { await repair(); });
      expect(home.boundary.list().map(row => row.id)).toEqual(ids);
      expect(screen.findByTestId(partialID)).not.toBeNull();
      refuse = false;
      await act(async () => { await repair(); });
      expect(home.boundary.list().map(row => row.id)).toEqual(ids);
      const record = home.catalog.read('skill-rules');
      expect(record.value).toMatchObject({ rules: expect.arrayContaining([expect.objectContaining({ skillId: createdId, enabled: true })]) });
      expect(entry === 'draft' ? navigation.replace : navigation.push).toHaveBeenCalledWith(expect.stringContaining(createdId));
    } finally { await screen.unmount(); await home.dispose(); modalSpies.confirm.mockResolvedValue(false); }
  });

  it('honors the delete Action waiver without a local removal dialog', async () => {
    modalSpies.confirm.mockClear();
    const home = await seededHome('https://skill-delete-waived.test', async (path) => path === '/v2/account/settings'
      ? Response.json({ version: 1, content: { t: 'plain', v: { actionsSettingsV1: { v: 1,
        approvalWaivedSurfaces: { 'skills.delete': ['ui'] },
      } } } }) : null);
    await home.hydrateAccountSettings();
    const detail = await renderHook(() => useSkillDetail('release-notes'));
    try {
      await vi.waitFor(() => expect(detail.getCurrent().status).toBe('ready'));
      let removed: boolean | 'cancelled' | undefined;
      await act(async () => { removed = await detail.getCurrent().remove(); });
      expect(removed).toBe(true);
      expect(home.boundary.read('release-notes')).toBeNull();
      expect(modalSpies.confirm).not.toHaveBeenCalled();
    } finally { await detail.unmount(); await home.dispose(); }
  });

  it('keeps rules retry incomplete on a refused Account CAS and recovers without reinstalling', async () => {
    let refuse = true;
    let refusedWrites = 0;
    // Accept the shared admission prompt so the test reaches the real Account CAS.
    modalSpies.confirm.mockResolvedValue(true);
    const home = await seededHome('https://skill-rules-retry.test', async (path, init) => {
      if (refuse && path.endsWith('/prompt-library/skill-rules') && init?.method === 'POST') {
        refusedWrites += 1;
        return Response.json({ status: 'conflict', revision: 2 });
      }
      return null;
    });
    const author = await renderHook(() => {
      const library = useSkillsLibrary();
      return { ...useMountedActionExecution(library.scope), retry: library.retry };
    });
    try {
      await vi.waitFor(() => expect(author.getCurrent().ready).toBe(true));
      const input = { skillId: 'release-notes', change: { kind: 'replace' as const,
        rules: [{ target: { t: 'allMachines' as const }, enabled: true }] } };
      expect(await retrySkillRules(author.getCurrent().execute, input)).toBe(false);
      expect(refusedWrites).toBeGreaterThan(0);
      expect(home.catalog.read('skill-rules').value).not.toMatchObject({ rules: expect.arrayContaining([expect.objectContaining({ skillId: 'release-notes' })]) });
      refuse = false;
      await act(async () => { author.getCurrent().retry(); });
      await vi.waitFor(() => expect(getPromptLibraryCatalogValue(storage.getState().settingsScope, 'skill-rules').status).toBe('ready'));
      expect(await retrySkillRules(author.getCurrent().execute, input)).toBe(true);
      expect(home.boundary.list()).toHaveLength(1);
      expect(home.catalog.read('skill-rules').value).toMatchObject({ rules: expect.arrayContaining([expect.objectContaining({ skillId: 'release-notes', enabled: true })]) });
    } finally { modalSpies.confirm.mockResolvedValue(false); await author.unmount(); await home.dispose(); }
  });

  it('keeps a second-device edit when applying choices from an older reviewed revision, then reloads the review', async () => {
    modalSpies.confirm.mockResolvedValue(true);
    const commit = '2'.repeat(40);
    const url = 'https://github.com/fixture/skills';
    const upstreamText = `${SKILL_MD}\nUpstream instructions.`;
    const upstream = createPromptRegistrySkillFixture({ sourceId: 'reviewed-update', itemId: 'review', title: 'release-notes',
      files: [{ path: 'SKILL.md', content: upstreamText }] });
    if (upstream.item.payload.kind !== 'skill') throw new Error('Expected a skill fixture');
    const skill = upstream.item.payload.skill;
    const ref = { ...skill.ref, commit };
    const externalRequests: string[] = [];
    const home = await seededHome('https://skill-reviewed-update.test', undefined, { header: { skillLock: {
      provenance: { kind: 'link', url, ref: { ...ref, commit: '1'.repeat(40), treeSha: '4'.repeat(40) } },
      updatePolicy: 'manual', upstream: { state: 'update_available', latest: ref }, importedDigest: 'old-digest',
    } }, handleExternalRequest: async request => {
      externalRequests.push(request);
      if (request === 'https://api.github.com/repos/fixture/skills') return Response.json({ name: 'skills', default_branch: 'main' });
      if (request.includes('/marketplace.json') || request.endsWith('/plugin.json')) return new Response(null, { status: 404 });
      if (request.includes('/commits/')) return Response.json({ sha: commit });
      if (request.includes('/git/trees/')) return Response.json({ sha: ref.treeSha, tree: [
        { path: 'review', type: 'tree', mode: '040000', sha: ref.treeSha },
        ...skill.files.map(file => ({ path: `review/${file.path}`, type: 'blob', mode: '100644', sha: file.blobSha, size: file.size })),
      ] });
      if (request.endsWith('/review/SKILL.md')) return new Response(upstreamText);
      return new Response(null, { status: 404 });
    } });
    const hook = await renderHook(() => { const library = useSkillsLibrary(); return { library, updates: useSkillsUpdates(library) }; });
    try {
      await vi.waitFor(() => expect(hook.getCurrent().library.items.find(item => item.skillId === 'release-notes')).toBeDefined());
      await act(async () => { await hook.getCurrent().updates.loadDiff('release-notes'); });
      const reviewed = hook.getCurrent().library.items.find(item => item.skillId === 'release-notes')!;
      const applyReviewed = hook.getCurrent().updates.apply;
      expect(hook.getCurrent().updates.diffs.get(reviewed.skillId), JSON.stringify({ diff: hook.getCurrent().updates.diffs.get(reviewed.skillId), externalRequests, requests: home.requests })).toMatchObject({ status: 'ready' });
      const stored = home.boundary.read(reviewed.skillId)!;
      if (stored.bodyVersion === undefined) throw new Error('The reviewed skill must have a body revision');
      const otherText = `${SKILL_MD}\nSecond device edit.`;
      const body = PromptBundleBodyV1Schema.parse({ v: 1, createdAtMs: 1, updatedAtMs: 2,
        entries: [{ path: 'SKILL.md', contentKind: 'utf8', contentBase64: encodeBase64(new TextEncoder().encode(otherText)) }] });
      home.boundary.replaceStoredRow({ ...stored, bodyVersion: stored.bodyVersion + 1,
        body: encodePlainArtifactStoredContent({ body: JSON.stringify(body) }) });
      const account = await import('@/sync/ops/actions/actionAccountContext');
      const reader = await account.captureLazyActionAccountContext(home.home.id);
      try { await reader.fetchArtifact(reviewed.skillId); } finally { reader.dispose(); }
      await act(async () => { hook.getCurrent().library.retry(); });
      await vi.waitFor(() => expect(hook.getCurrent().library.items.find(item => item.skillId === reviewed.skillId)!.revision).not.toBe(reviewed.revision));
      const newest = hook.getCurrent().library.items.find(item => item.skillId === reviewed.skillId)!;
      // A still-live callback from the old review must carry its revision even after the list refreshed.
      await act(async () => { await applyReviewed(newest, { 'SKILL.md': 'theirs' }); });
      expect(hook.getCurrent().updates.applies.get(reviewed.skillId)).toMatchObject({ status: 'failed', code: 'revision_conflict' });
      expect(home.boundary.readPlainBody(reviewed.skillId)).toBe(JSON.stringify(body));
      await vi.waitFor(() => expect(hook.getCurrent().updates.diffs.get(reviewed.skillId)).toMatchObject({ status: 'ready', revision: newest.revision }));
    } finally { modalSpies.confirm.mockResolvedValue(false); await hook.unmount(); await home.dispose(); }
  });

  it('publishes a rule flip immediately, offers Undo after acknowledgement, and rolls back a refused write', async () => {
    const issued = createDeferred<void>();
    const reply = createDeferred<void>();
    let held = true;
    let refuse = false;
    const home = await seededHome('https://skill-rule-undo.test', async (path, init) => {
      if (path.endsWith('/prompt-library/skill-rules') && init?.method === 'POST') {
        if (held) { issued.resolve(); await reply.promise; }
        if (refuse) return Response.json({ status: 'conflict', revision: 3 });
      }
      return null;
    });
    const author = await renderHook(() => useReachRules('skill', 'release-notes'));
    const reader = await renderHook(() => useReachRules('skill', 'release-notes'));
    const library = await renderHook(() => useSkillsLibrary());
    try {
      await vi.waitFor(() => expect(author.getCurrent().status).toBe('ready'));
      await vi.waitFor(() => expect(library.getCurrent().items.some(item => item.skillId === 'release-notes')).toBe(true));
      let change!: ReturnType<ReturnType<typeof useReachRules>['change']>;
      act(() => { change = author.getCurrent().change({ kind: 'replace', rules: [{ target: { t: 'allMachines' }, enabled: true }] }); });
      await issued.promise;
      expect(reader.getCurrent().rules[0]?.enabled).toBe(true);
      expect(getPromptLibraryCatalogValue(storage.getState().settingsScope, 'skill-rules').value?.rules.find(rule => rule.skillId === 'release-notes')?.enabled).toBe(true);
      expect(library.getCurrent().items.find(item => item.skillId === 'release-notes')?.rules[0]?.enabled).toBe(true);
      expect(readPresentationNotice()?.undo).toBeUndefined();
      held = false;
      await act(async () => { reply.resolve(); expect(await change).toEqual({ ok: true }); });
      expect(reader.getCurrent().rules[0]?.enabled).toBe(true);
      expect(readPresentationNotice()?.undo).toBeDefined();
      await act(async () => { readPresentationNotice()!.undo!.run(); });
      await vi.waitFor(() => expect(reader.getCurrent().rules).toEqual([]));
      await vi.waitFor(() => expect(library.getCurrent().items.find(item => item.skillId === 'release-notes')?.rules).toEqual([]));
      // Empty display is optimistic: the next refusal must start only after Undo's HTTP receipt.
      await vi.waitFor(() => expect(home.catalog.read('skill-rules').value).toMatchObject({
        rules: expect.not.arrayContaining([expect.objectContaining({ skillId: 'release-notes' })]),
      }));
      retirePresentationNotice();
      refuse = true;
      await act(async () => { expect(await author.getCurrent().change({ kind: 'replace', rules: [{ target: { t: 'allMachines' }, enabled: true }] })).toEqual({ ok: false, message: 'conflict' }); });
      await vi.waitFor(() => expect(reader.getCurrent().rules).toEqual([]));
      await vi.waitFor(() => expect(library.getCurrent().items.find(item => item.skillId === 'release-notes')?.rules).toEqual([]));
      expect(readPresentationNotice()?.undo).toBeUndefined();
    } finally {
      reply.resolve();
      await library.unmount(); await reader.unmount(); await author.unmount(); await home.dispose();
    }
  });
  it('updates with the read revision, answers revision_conflict to a stale edit, and Remove asks before skills.delete', async () => {
    const home = await seededHome('https://skill-detail.test');
    const mine = await renderHook(() => useSkillDetail('release-notes'));
    const stale = await renderHook(() => useSkillDetail('release-notes'));
    try {
      await vi.waitFor(() => expect(mine.getCurrent().status).toBe('ready'), {
        timeout: 10_000,
      });
      await vi.waitFor(() => expect(stale.getCurrent().status).toBe('ready'), {
        timeout: 10_000,
      });
      expect(mine.getCurrent().read?.provenance).toEqual({ kind: 'written' });
      stale.getCurrent().setHold(true);
      const first = mine.getCurrent().read!.revision;

      let result:
        | Awaited<ReturnType<ReturnType<typeof useSkillDetail>['update']>>
        | undefined;
      await act(async () => {
        result = await mine
          .getCurrent()
          .update({
            files: [
              {
                kind: 'upsert',
                file: skillTextFile('SKILL.md', `${SKILL_MD}One.\n`),
              },
            ],
          });
      });
      expect(result).toMatchObject({ ok: true });
      expect(mine.getCurrent().read!.revision).not.toBe(first);
      await act(async () => {
        result = await mine
          .getCurrent()
          .update({
            files: [
              {
                kind: 'upsert',
                file: skillTextFile('SKILL.md', `${SKILL_MD}Two.\n`),
              },
            ],
          });
      });
      expect(result).toMatchObject({ ok: true });

      await act(async () => {
        result = await stale
          .getCurrent()
          .update({
            files: [
              {
                kind: 'upsert',
                file: skillTextFile('SKILL.md', `${SKILL_MD}Stale.\n`),
              },
            ],
          });
      });
      expect(result).toEqual({ ok: false, code: 'revision_conflict' });
      const latest = await mine.getCurrent().readLatest();
      expect(latest?.skillMd).toBe(`${SKILL_MD}Two.\n`);

      modalSpies.confirm.mockResolvedValueOnce(false);
      let removed: boolean | 'cancelled' | undefined;
      await act(async () => {
        removed = await mine.getCurrent().remove();
      });
      expect(removed).toBe('cancelled');
      expect(modalSpies.confirm).toHaveBeenCalledTimes(1);
      expect((await mine.getCurrent().readLatest())?.skillId).toBe(
        'release-notes',
      );

      modalSpies.confirm.mockResolvedValueOnce(true);
      await act(async () => {
        removed = await mine.getCurrent().remove();
      });
      expect(removed).toBe(true);
      expect(modalSpies.confirm).toHaveBeenCalledTimes(2);
      expect(await mine.getCurrent().readLatest()).toBeNull();
    } finally {
      await stale.unmount();
      await mine.unmount();
      await home.dispose();
    }
  });

  it('moves the skill to another folder through artifact.folder.set and the reloaded library lists it there, even when its old placement was only a legacy header', async () => {
    const home = await seededHome('https://skill-folder-move.test', undefined, {
      records: [{ key: 'folders', value: { v: 1, folders: [
        { id: 'old', name: 'Old', parentId: null }, { id: 'work', name: 'Work', parentId: null },
      ] } }],
      header: { folderId: 'old' },
    });
    const detail = await renderHook(() => useSkillDetail('release-notes'));
    const library = await renderHook(() => useSkillsLibrary());
    try {
      await vi.waitFor(() => expect(library.getCurrent().items.find((item) => item.skillId === 'release-notes')?.folderId).toBe('old'), { timeout: 10_000 });
      await vi.waitFor(() => expect(detail.getCurrent().folders.status).toBe('ready'), { timeout: 10_000 });
      let moved: boolean | undefined;
      await act(async () => { moved = await detail.getCurrent().moveToFolder('work'); });
      expect(moved).toBe(true);
      expect(home.catalog.read('folders')).toMatchObject({ key: 'folders', value: {
        artifactHeadersById: { 'release-notes': { folderId: 'work' } },
      } });
      await vi.waitFor(() => expect(library.getCurrent().items.find((item) => item.skillId === 'release-notes')?.folderId).toBe('work'), { timeout: 10_000 });
      // Reopening reads the personal placement again; a transient optimistic DTO cannot satisfy this.
      const reopened = await renderHook(() => useSkillsLibrary());
      try {
        await vi.waitFor(() => expect(reopened.getCurrent().items.find(item => item.skillId === 'release-notes')?.folderId).toBe('work'));
        const groups = groupSkillsByFolder(reopened.getCurrent().items, { v: 1, folders: [
          { id: 'old', name: 'Old', parentId: null }, { id: 'work', name: 'Work', parentId: null },
        ] });
        expect(groups?.find(group => group.id === 'work')?.rows.map(item => item.skillId)).toEqual(['release-notes']);
        expect(groups?.some(group => group.id === 'old')).toBe(false);
        await act(async () => { expect(await detail.getCurrent().moveToFolder(null)).toBe(true); });
        await vi.waitFor(() => expect(library.getCurrent().items.find(item => item.skillId === 'release-notes')?.folderId).toBeNull());
        await vi.waitFor(() => expect(reopened.getCurrent().items.find(item => item.skillId === 'release-notes')?.folderId).toBeNull());
        // The legacy header is deliberately unchanged: canonical personal placement must win it.
        expect(home.boundary.read('release-notes')?.header).toBe(encodePlainArtifactStoredContent(
          PromptBundleArtifactHeaderV1Schema.parse({ v: 1, kind: 'prompt_bundle.v2', title: 'release-notes',
            bundleSchemaId: 'skills.skill_md_v1', folderId: 'old' }),
        ));
      } finally { await reopened.unmount(); }
    } finally {
      await library.unmount(); await detail.unmount(); await home.dispose();
    }
  });

  it('exports the skill as an Agent Skills zip through skills.export and hands those bytes to the person', async () => {
    const home = await seededHome('https://skill-export.test');
    const detail = await renderHook(() => useSkillDetail('release-notes'));
    try {
      await vi.waitFor(() => expect(detail.getCurrent().status).toBe('ready'), { timeout: 10_000 });
      let exported: boolean | undefined;
      await act(async () => { exported = await detail.getCurrent().exportZip(); });
      expect(exported).toBe(true);
      const saved = fileSaves.saveFileBytes.mock.calls[0]![0];
      expect(saved).toMatchObject({ fileName: 'release-notes.zip', mimeType: 'application/zip' });
      const { readSkillZipFilesV1 } = await import('@happier-dev/protocol/prompts/library/skills/skillZipV1');
      const files = await readSkillZipFilesV1(saved.bytes);
      expect(files.map((file) => file.path)).toEqual(['release-notes/SKILL.md']);
      expect(readSkillText(files[0]!.contentBase64)).toBe(SKILL_MD);
    } finally {
      await detail.unmount(); await home.dispose();
    }
  });
});
