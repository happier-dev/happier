import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, createDeferred, createMachineFixture, invokeTestInstanceHandler, renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { createSeededSkillsHome } from '@/dev/testkit/harness/skillsSurfaceHarness';
import { t } from '@/text';

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

// Load the real UI graph during collection, not inside the behavior timeout budget.
installDisconnectedServerSocketBoundary();
const { ScopeSheet } = await import('./CapabilityScopeSection');
const { MachineCapabilitiesSection } = await import('@/components/machines/page/MachineCapabilitiesSection');
const { ProjectCapabilitiesSection } = await import('@/components/projects/context/ProjectCapabilitiesSection');
const { refreshPromptLibraryCatalog, resetPromptLibraryCatalogEngineForTests } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');
const { resetPromptLibraryCatalogSnapshotsForTests } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');

afterEach(() => { standardCleanup(); resetPromptLibraryCatalogEngineForTests(); resetPromptLibraryCatalogSnapshotsForTests(); });

function renderUnavailableSheet(offlineMachine: { name: string; announced: boolean } | null, retry = vi.fn(), state: 'unavailable' | 'loading' = 'unavailable') {
  return renderScreen(
    <ScopeSheet
      testID="scope.skills"
      kind="skill"
      title="Skills"
      list={{ state, total: 0, rows: [], retry }}
      place={{ place: { t: 'project', projectKey: 'invoice-client' }, label: 'invoice-client' }}
      data={{ machines: [], names: {} as never, open: () => {} }}
      offlineMachine={offlineMachine}
    />,
  );
}

describe('capability scope sheet when its list could not be read', () => {
  it.each(['machine', 'project'] as const)('retains the real %s consumer switch and writes only that place through Actions', async (kind) => {
    const home = await createSeededSkillsHome(`https://scope-${kind}-consumer.test`, {
      skills: [{ id: 'review' }],
    });
    const scope = home.storage.getState().settingsScope!;
    const machine = createMachineFixture({ id: 'studio', active: true, activeAt: Date.now() });
    home.storage.getState().applyMachines([machine], true, { sourceServerId: scope.serverId, sourceAccountId: scope.accountId });
    const prefix = kind === 'machine' ? 'machine-page-capabilities' : 'project-capabilities';
    const screen = await renderScreen(kind === 'machine'
      ? <MachineCapabilitiesSection machineId="studio" machineName="Studio" />
      : <ProjectCapabilitiesSection projectKey="invoice-client" projectName="Invoice client" teamName={null} testID={prefix} />);
    try {
      const switchId = `${prefix}.skills.row.review.switch`;
      await vi.waitFor(() => expect(screen.findByTestId(switchId)?.props.value).toBe(false));
      await act(async () => { invokeTestInstanceHandler(screen.findByTestId(switchId), 'onValueChange', true); });
      await vi.waitFor(() => expect(screen.findByTestId(switchId)?.props.value).toBe(true));
      const target = kind === 'machine' ? { t: 'machine', machineId: 'studio' } : { t: 'project', projectKey: 'invoice-client' };
      await vi.waitFor(() => {
        const record = home.catalog.read('skill-rules');
        if (record.key !== 'skill-rules') throw new Error('Expected Skill rules');
        expect(record.value.rules.filter(rule => rule.skillId === 'review'))
          .toEqual([expect.objectContaining({ target, enabled: true })]);
      });
      expect(home.catalog.requests.filter(request => request.key === 'skill-rules')).toHaveLength(1);
    } finally { await screen.unmount(); await home.dispose(); }
  });

  it('speaks its status on the row while keeping the fix and scope switch independent', async () => {
    const catalog = createPromptLibraryCatalogBoundary({ records: [{ key: 'skill-rules', value: { v: 1, rules: [
      { id: 'all', skillId: 'review', target: { t: 'allMachines' }, enabled: true, createdAt: 1, updatedAt: 1 },
    ] } }] });
    const home = await createPlainArtifactHomeFixture('https://scope-row-status.test', { handleRequest: async (path, init) => {
      if (path === '/v2/account/settings/history') return Response.json({ snapshots: [] });
      return catalog.handle(path, init);
    } });
    const onFix = vi.fn();
    const onOpen = vi.fn();
    const screen = await renderScreen(<ScopeSheet testID="scope.skills" kind="skill" title="Skills"
      list={{ state: 'ready', total: 1, rows: [{ id: 'review', kind: 'skill', name: 'Review', rules: [],
        hasRuleHere: false, status: { kind: 'signin', fix: { kind: 'sign_in', onPress: onFix } }, masked: false }], retry: () => {} }}
      place={{ place: { t: 'machine', machineId: 'studio' }, label: 'studio' }}
      data={{ machines: [{ machineId: 'studio', platform: 'posix', agentIds: [] }], names: {} as never, open: onOpen }} offlineMachine={null} />);
    try {
      await act(async () => refreshPromptLibraryCatalog({ serverId: home.home.id, accountId: 'artifact-account' }));
      await vi.waitFor(() => expect(screen.findByTestId('scope.skills.row.review.switch')?.props.value).toBe(true));
      const row = screen.findHostByTestId('scope.skills.row.review')!;
      expect(row.props.accessibilityLabel ?? row.props['aria-label']).toContain(t('capabilities.status.signin'));
      await screen.pressByTestIdAsync('scope.skills.row.review:status:fix');
      expect(onFix).toHaveBeenCalledOnce();
      expect(onOpen).not.toHaveBeenCalled();
      expect(screen.findByTestId('scope.skills.row.review.switch')?.props.value).toBe(true);
    } finally { await screen.unmount(); await home.dispose(); }
  });

  it('keeps a known skill row waiting until its Account rules arrive, then shows the resolved switch', async () => {
    const held = createDeferred<void>();
    const catalog = createPromptLibraryCatalogBoundary({ records: [{ key: 'skill-rules', value: { v: 1, rules: [
      { id: 'all', skillId: 'review', target: { t: 'allMachines' }, enabled: true, createdAt: 1, updatedAt: 1 },
    ] } }] });
    const home = await createPlainArtifactHomeFixture('https://scope-unread-rules.test', { handleRequest: async (path, init) => {
      if (path === '/v1/account/entity-rows/prompt-library') await held.promise;
      if (path === '/v2/account/settings/history') return Response.json({ snapshots: [] });
      return catalog.handle(path, init);
    } });
    const screen = await renderScreen(<ScopeSheet testID="scope.skills" kind="skill" title="Skills"
      list={{ state: 'ready', total: 1, rows: [{ id: 'review', kind: 'skill', name: 'Review', rules: [],
        hasRuleHere: false, status: null, masked: false }], retry: () => {} }}
      place={{ place: { t: 'machine', machineId: 'studio' }, label: 'studio' }}
      data={{ machines: [{ machineId: 'studio', platform: 'posix', agentIds: [] }], names: {} as never, open: () => {} }} offlineMachine={null} />);
    try {
      expect(screen.findByTestId('scope.skills.row.review.switch')).toBeNull();
      expect(screen.findByTestId('scope.skills.row.review.loading')).not.toBeNull();
      await act(async () => {
        held.resolve();
        await refreshPromptLibraryCatalog({ serverId: home.home.id, accountId: 'artifact-account' });
      });
      await vi.waitFor(() => expect(screen.findByTestId('scope.skills.row.review.switch')?.props.value).toBe(true));
      expect(screen.findByTestId('scope.skills.row.review.loading')).toBeNull();
    } finally { held.resolve(); await screen.unmount(); await home.dispose(); }
  });
  it('names the offline machine, not the project, as what the list waits for, with no error and no Retry', async () => {
    const screen = await renderUnavailableSheet({ name: 'studio', announced: false });
    expect(screen.getTextContent()).toContain(
      t('capabilities.scopeSection.whenRunning', { machine: 'studio' }),
    );
    expect(screen.getTextContent()).not.toContain('invoice-client');
    expect(screen.findByTestId('scope.skills.unavailable')).toBeNull();
    expect(screen.getTextContent()).not.toContain(
      t('capabilities.scopeSection.loadFailed'),
    );
    await screen.unmount();
  });

  it('leaves the cause to the page when it already says the machine is not answering', async () => {
    const screen = await renderUnavailableSheet({ name: 'studio', announced: true }, vi.fn(), 'loading');
    const text = screen.getTextContent();
    // One cause, said once by the page: the sheet neither repeats it nor claims the machine "is running".
    expect(text).not.toContain(t('capabilities.scopeSection.whenRunning', { machine: 'studio' }));
    expect(text).not.toContain(t('capabilities.scopeSection.loadFailed'));
    expect(screen.findByTestId('scope.skills.unavailable')).toBeNull();
    // It says only what it waits for, on the reachability owner's one line.
    expect(screen.findByTestId('scope.skills.offline')).not.toBeNull();
    expect(text).toContain(t('projects.checkouts.waiting', { machine: 'studio' }));
    await screen.unmount();
  });

  it('keeps a failed read of a running machine an error with its Retry', async () => {
    const retry = vi.fn();
    const screen = await renderUnavailableSheet(null, retry);
    expect(screen.findByTestId('scope.skills.offline')).toBeNull();
    expect(screen.getTextContent()).toContain(
      t('capabilities.scopeSection.loadFailed'),
    );
    expect(screen.getTextContent()).toContain(t('common.retry'));
    await screen.unmount();
  });

  it('never holds a skeleton for a list its unreachable machine has not answered', async () => {
    const screen = await renderUnavailableSheet({ name: 'studio', announced: false }, vi.fn(), 'loading');
    expect(screen.getTextContent()).toContain(
      t('capabilities.scopeSection.whenRunning', { machine: 'studio' }),
    );
    await screen.unmount();
  });
});
