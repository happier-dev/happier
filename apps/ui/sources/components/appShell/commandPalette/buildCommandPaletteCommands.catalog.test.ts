import { it, expect, vi } from 'vitest';
import { buildCommandPaletteCommands } from './buildCommandPaletteCommands';
let mockedState: unknown = { settings: {} };
vi.mock('@/sync/domains/state/storage', async () => {
  const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
  return createStorageModuleStub({ storage: { getState: () => mockedState } });
});
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock({ spies: { show: vi.fn(() => 'action-input') } }).module;
});
// Owner decision 1127: catalog placements, rather than a hand-picked switch, own palette discovery.
it('lists generic catalog Actions once and executes complete input through the UI executor', async () => {
  mockedState = { settings: { experiments: true, featureToggles: { 'execution.runs': true } } };
  const execute = vi.fn(async () => ({ ok: true, result: {} }));
  const commands = buildCommandPaletteCommands({
    sessionsById: {}, isDev: false, activeSessionId: null,
    features: { executionRunsEnabled: true, voiceEnabled: false },
    nav: { push: () => {}, openNewSession: () => {}, navigateToSession: () => {} },
    actions: { execute }, alert: () => {},
  });
  const next = commands.find(command => command.id === 'action:session.pending.next');
  expect(next).toBeDefined();
  await next!.action();
  expect(execute).toHaveBeenCalledWith('session.pending.next', {}, { defaultSessionId: null, surface: 'ui' });
  expect(commands.filter(command => command.actionSpecId === 'review.start')).toHaveLength(1);
  expect(commands.some(command => command.actionSpecId === 'ui.voice_global.reset')).toBe(false);
});

it('opens incomplete generic Actions in the existing form and dispatches its submitted input', async () => {
  const { Modal } = await import('@/modal');
  mockedState = { settings: { experiments: true, featureToggles: { 'execution.runs': true } } };
  const execute = vi.fn(async () => ({ ok: true, result: {} }));
  const commands = buildCommandPaletteCommands({
    sessionsById: { s1: { id: 's1', serverId: 'server-a', metadata: { machineId: 'm1', path: '/repo' } } },
    isDev: false, activeSessionId: null,
    features: { executionRunsEnabled: false, voiceEnabled: false },
    nav: { push: () => {}, openNewSession: () => {}, navigateToSession: () => {} },
    actions: { execute }, alert: () => {},
  });
  const fork = commands.find(command => command.id === 'action:session.open');
  expect(fork).toBeDefined();
  await fork!.action();
  expect(execute).not.toHaveBeenCalled();
  const shown = vi.mocked(Modal.show).mock.calls.at(-1)?.[0];
  expect(shown).toBeDefined();
  const form = (shown as unknown as { props: { form: import('@/components/plugins/actions/actionInputForm').ActionInputForm } }).props.form;
  expect(form.getInput()).not.toHaveProperty('sessionId');
  form.replaceInput({ ...form.getInput(), sessionId: 's1' });
  await form.submit();
  expect(execute).toHaveBeenCalledWith('session.open', expect.objectContaining({ sessionId: 's1' }), { defaultSessionId: null, surface: 'ui' });
});

it('labels only the Voice preset that the derived shortcut actually invokes', () => {
  mockedState = { settings: {} };
  const commands = buildCommandPaletteCommands({
    sessionsById: {}, isDev: false, activeSessionId: null,
    features: { executionRunsEnabled: false, voiceEnabled: true },
    shortcutLabels: { 'action:ui.voice_global.set_muted': 'Ctrl+Shift+M' },
    nav: { push: () => {}, openNewSession: () => {}, navigateToSession: () => {} },
    actions: { execute: async () => ({ ok: true, result: {} }) }, alert: () => {},
  });
  const presets = commands.filter(command => command.actionSpecId === 'ui.voice_global.set_muted');
  expect(presets).toHaveLength(2);
  expect(presets.map(command => command.shortcut)).toEqual(['Ctrl+Shift+M', undefined]);
});
