import * as React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { MountedAuthoringActionExecute } from '@/sync/ops/actions/sessionAuthoringActions';
import { CapabilityAddModalBody } from '@/components/capabilities/add/CapabilityAddModal';
import { SkillUploadInput } from './SkillUploadInput';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const device = vi.hoisted(() => ({ os: 'web' as 'web' | 'ios' | 'android' }));
const documentPicker = vi.hoisted(() => ({ getDocumentAsync: vi.fn(async () => ({ canceled: true, assets: null })) }));
vi.mock('expo-document-picker', () => documentPicker);

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  const native = await createReactNativeWebMock();
  return { ...native, Platform: { ...native.Platform, get OS() { return device.os; } } };
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

// The browser's file drop is the platform boundary: the test drops one skill folder through it. Reading the
// folder, previewing and adding stay the real owners.
const drop = vi.hoisted(() => ({ names: ['grill-me'], onFilesDropped: null as null | ((event: { dataTransfer: unknown }) => Promise<void>) }));
vi.mock('@/hooks/ui/useWebFileDropZone', () => ({
  useWebFileDropZone: (params: { onFilesDropped: (event: { dataTransfer: unknown }) => Promise<void> }) => {
    drop.onFilesDropped = params.onFilesDropped;
    return {};
  },
}));
vi.mock('@/utils/files/webDroppedEntries', () => ({
  readWebDroppedEntries: async () => drop.names.map(name => ({
    file: new File([`---\nname: ${name}\ndescription: Interview the plan.\n---\nAsk.`], 'SKILL.md'), relativePath: `${name}/SKILL.md`,
  })),
}));

afterEach(() => {
  standardCleanup();
  drop.onFilesDropped = null;
  drop.names = ['grill-me'];
  device.os = 'web';
  documentPicker.getDocumentAsync.mockClear();
});

const PREVIEW = {
  path: 'grill-me',
  name: 'grill-me',
  description: 'Interview the plan.',
  files: [],
  trust: 'text_only',
  cost: { descriptionTokens: 20, bodyTokens: 300 },
  provenance: { kind: 'upload', importedAt: 1 },
} as const;

/** The Action transport is the boundary: the preview finds one skill, the add itself is refused. */
const execute: MountedAuthoringActionExecute = async (_actionId, input) => {
  const dryRun = (input as { dryRun?: boolean }).dryRun === true;
  const answer: ActionExecuteResult = dryRun
    ? { ok: true, result: { items: [PREVIEW] } }
    : { ok: false, error: 'install failed', errorCode: 'skill_install_failed' };
  return answer;
};

/** The Upload mode inside the real Add dialog body, as the Skills page opens it. */
async function renderUpload(answer: MountedAuthoringActionExecute, onSelectAdded: (id: string) => void = () => {}, onAdded: (id: string) => void = () => {}, dropOnMount = true) {
  const onClose = vi.fn();
  const config = {
    title: 'Add a skill',
    testID: 'skills.add',
    initialModeKey: 'upload',
    modes: [
      {
        key: 'upload',
        label: 'Upload',
        icon: 'upload' as const,
        kind: 'input' as const,
        ownsTools: true,
        renderBody: (ctx: never) => (
          <SkillUploadInput ctx={ctx} execute={answer} onAdded={onAdded} onSelectAdded={id => { onSelectAdded(id); onClose(); }} onDone={() => {}} testID="upload" />
        ),
      },
    ],
    catalog: { query: '', onQueryChange: () => {}, searchPlaceholder: '', items: [], itemKey: () => '', anatomy: {}, loading: false, empty: null },
    renderDetail: () => null,
    detailFooter: () => ({ primary: { label: '', onPress: async () => null } }),
  };
  const screen = await renderScreen(<CapabilityAddModalBody config={config as never} onClose={onClose} />);
  if (dropOnMount) await act(async () => {
    await drop.onFilesDropped?.({ dataTransfer: {} });
  });
  const pressPrimary = async () => {
    const button = screen.findAll((node) => node.props?.testID === 'skills.add:primary' && typeof node.props?.onPress === 'function')[0];
    if (!button) throw new Error('primary is not pressable');
    await act(async () => {
      await button.props.onPress();
    });
  };
  return { screen, pressPrimary, onClose };
}

describe('SkillUploadInput', () => {
  it.each(['ios', 'android'] as const)('offers ZIP but not folder picking on %s, and cancellation starts no preview or install', async os => {
    device.os = os;
    const answer = vi.fn<MountedAuthoringActionExecute>();
    const { screen } = await renderUpload(answer, undefined, undefined, false);
    expect(screen.findByTestId('upload.zip')).not.toBeNull();
    expect(screen.findByTestId('upload.folder')).toBeNull();
    await screen.pressByTestIdAsync('upload.zip');
    await vi.waitFor(() => expect(documentPicker.getDocumentAsync).toHaveBeenCalledOnce());
    expect(documentPicker.getDocumentAsync).toHaveBeenCalledWith({ multiple: false, type: ['application/zip'] });
    expect(answer).not.toHaveBeenCalled();
    expect(screen.findByTestId('upload.error')).toBeNull();
  });

  for (const missingRules of [false, true]) it(`retains a real batch content failure while repairing rules (missing rules: ${missingRules})`, async () => {
    const { createSkillInstallActionHarness } = await import('@/dev/testkit/harness/skillInstallActionHarness');
    const harness = createSkillInstallActionHarness();
    drop.names = ['grill-me', 'to-prd', 'not-selected'];
    harness.setContentUnavailableAfter(1);
    harness.setRulesUnavailable(missingRules);
    const onAdded = vi.fn();
    const { screen } = await renderUpload(harness.execute, () => {}, onAdded);
    const collection = () => screen.find(node => node.props?.testID === 'skills.add:collection' && node.props?.anatomy);
    const row = await renderScreen(<>{collection().props.anatomy.leadingControl({ ...PREVIEW, path: 'not-selected', name: 'not-selected' })}</>);
    await row.pressByTestIdAsync('upload.item.not-selected.tick');
    await screen.pressByTestIdAsync('upload.add');
    expect(harness.artifacts.size).toBe(1);
    expect(onAdded).not.toHaveBeenCalled();
    expect(screen.findByTestId('upload.add-error')).not.toBeNull();
    expect(screen.getTextContent()).toContain('to-prd');
    expect(screen.getTextContent()).not.toContain('Couldn’t add to-prd, not-selected');
    // The refreshed checklist preserves the unticked skill and drops the one already held.
    const unselected = collection().props.anatomy.leadingControl({ ...PREVIEW, path: 'not-selected', name: 'not-selected' });
    expect(unselected.props.checked).toBe(false);
    harness.setRulesUnavailable(false);
    await screen.pressByTestIdAsync('upload.add');
    expect(harness.rules().map(rule => rule.skillId)).toEqual(['skill-1']);
    expect(harness.artifacts.size).toBe(1);
    expect(onAdded).not.toHaveBeenCalled();
    expect(screen.findByTestId('upload.add-error')).not.toBeNull();
    harness.setContentUnavailableAfter(null);
    await screen.pressByTestIdAsync('upload.add');
    expect(onAdded).toHaveBeenCalledExactlyOnceWith('skill-1');
    expect([...harness.artifacts.keys()]).toEqual(['skill-1', 'skill-2']);
    expect(harness.rules().map(rule => rule.skillId)).toEqual(['skill-1', 'skill-2']);
  });

  it('opens one uploaded skill straight in its details and adds it with the Where picked there (G8)', async () => {
    const installs: Record<string, unknown>[] = [];
    const answer: MountedAuthoringActionExecute = async (_actionId, input) => {
      if ((input as { dryRun?: boolean }).dryRun) return { ok: true, result: { items: [PREVIEW] } };
      installs.push(input as Record<string, unknown>);
      return { ok: true, result: { skillIds: ['uploaded'], includedInSessionId: null } };
    };
    const selected: string[] = [];
    const { screen, pressPrimary, onClose } = await renderUpload(answer, (id) => selected.push(id));
    expect(screen.findByTestId('upload.detail.title')).not.toBeNull();
    // One found skill shows one Add: its details' primary, not a second one in the footer.
    expect(screen.findByTestId('upload.add')).toBeNull();
    expect(screen.find(node => node.props.testID === 'skills.add:primary' && typeof node.props.display === 'string').props.display).toBe('primary');
    const { WhereItsOnControl } = await import('@/components/capabilities/where/WhereItsOnControl');
    const narrowed = { kind: 'write', write: { place: { t: 'machine', machineId: 'machine-1' }, state: 'on' } } as const;
    await act(async () => {
      await screen.findByType(WhereItsOnControl).props.onChange(narrowed);
    });
    await pressPrimary();
    expect(installs).toHaveLength(1);
    expect(installs[0]).toMatchObject({ source: { kind: 'upload' }, where: narrowed });
    expect(installs[0]).not.toHaveProperty('selectPaths');
    expect(onClose).toHaveBeenCalled();
    expect(selected).toEqual(['uploaded']);
  });

  it('says an uploaded skill named like a library skill is added as a separate copy', async () => {
    const answer: MountedAuthoringActionExecute = async () => ({ ok: true, result: { items: [{ ...PREVIEW, sameNameInLibrary: true }] } });
    const { screen } = await renderUpload(answer);
    expect(screen.findByTestId('upload.detail.sameName')).not.toBeNull();
    expect(screen.getTextContent()).toContain('You already have a skill named grill-me. This adds a separate copy.');
  });

  it('shows no same-name note for a new uploaded skill', async () => {
    const answer: MountedAuthoringActionExecute = async () => ({ ok: true, result: { items: [PREVIEW] } });
    const { screen } = await renderUpload(answer);
    expect(screen.findByTestId('upload.detail.title')).not.toBeNull();
    expect(screen.findByTestId('upload.detail.sameName')).toBeNull();
  });

  it('keeps an acknowledged upload open and retries its rules without another install', async () => {
    const writes: string[] = [];
    const answer: MountedAuthoringActionExecute = async (actionId, input) => {
      if (actionId === 'skills.install' && (input as { dryRun?: boolean }).dryRun)
        return { ok: true, result: { items: [PREVIEW] } };
      writes.push(actionId);
      return actionId === 'skills.install'
        ? { ok: true, result: { skillIds: ['uploaded'], includedInSessionId: null, incomplete: [{ skillId: 'uploaded', step: 'rules' }] } }
        : { ok: true, result: { ok: true, revision: 2, items: [{ skillId: 'uploaded', previous: [], rules: [] }] } };
    };
    const selected: string[] = [];
    const { screen, pressPrimary, onClose } = await renderUpload(answer, (id) => selected.push(id));
    await pressPrimary();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.findByTestId('upload.detail.title')).not.toBeNull();
    expect(screen.findByTestId('skills.add:primary-error')).not.toBeNull();
    await pressPrimary();
    expect(selected).toEqual(['uploaded']);
    expect(writes).toEqual(['skills.install', 'skills.rules.set']);
  });

  it('keeps the details and their Add after a failed Add, with the failure beside it', async () => {
    const { screen, pressPrimary, onClose } = await renderUpload(execute);
    await pressPrimary();
    // The same skill is still there to retry, and nothing else says the Add failed.
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.findByTestId('upload.detail.title')).toBeTruthy();
    expect(screen.findByTestId('skills.add:primary-error')).toBeTruthy();
    expect(screen.findByTestId('upload.error')).toBeNull();
  });
});
