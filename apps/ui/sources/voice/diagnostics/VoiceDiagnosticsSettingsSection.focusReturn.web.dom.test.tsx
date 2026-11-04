/**
 * @vitest-environment jsdom
 *
 * This exercises the real Settings consumer, the diagnostics action, and the
 * real react-native-web Switch. The daemon/status transport is the only
 * boundary replaced: focus must return to a control that still exists after a
 * successful per-session opt-out removes the action that had focus.
 */
import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { createMachineFixture, createDeferred, waitForTestEvent } from '@/dev/testkit';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createPlainMachineReadHttpResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { installBrowserStorageLockBoundary } from '@/dev/testkit/harness/browserStorageLockBoundary';
import { VoiceSpeechDiagnosticsConfigureRequestV1Schema, VoiceSpeechDiagnosticsRevokeCaptureRequestV1Schema, VoiceSpeechDiagnosticsStatusResponseV1Schema, resolveVoiceSpeechDiagnosticsStoragePolicy } from '@happier-dev/protocol/voice/diagnostics';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { tLoose } from '@/text';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const boundary = vi.hoisted(() => ({
  voice: null as VoiceSettings | null,
  sessionId: 'focused-diagnostics-session' as string | null,
  revokeCaptureAuthorization: vi.fn(async () => {}),
}));

vi.mock('react-native', async () => {
  const { getVitestNodeBuiltin } = await import('@/dev/vitestNodeBuiltins');
  const { createRequire } = getVitestNodeBuiltin<Pick<typeof import('node:module'), 'createRequire'>>('node:module');
  const actual: Record<string, unknown> = await vi.importActual(createRequire(import.meta.url).resolve('react-native-web'));
  return (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(actual);
});

vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});


vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('@hugeicons/react-native', () => ({ HugeiconsIcon: () => null }));
vi.mock('@/utils/web/radixCjs', async () => (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsRealModule());
vi.mock('@/utils/web/reactDomCjs', async () => {
  const actual = await vi.importActual<typeof import('react-dom')>('react-dom');
  return { requireReactDOM: () => actual };
});
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('socket.io-client', async (importOriginal) => (
  await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
installSessionActionRpcBoundary(async request => {
  if (request.method === `m1:${RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_REVOKE_CAPTURE}`) {
    VoiceSpeechDiagnosticsRevokeCaptureRequestV1Schema.parse(request.params);
    await boundary.revokeCaptureAuthorization();
    return { ok: true };
  }
  if (request.method === `m1:${RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_STATUS}`) return VoiceSpeechDiagnosticsStatusResponseV1Schema.parse({
      ok: true as const,
      root: '/private/m1',
      settings: boundary.voice!.diagnostics,
      artifacts: [],
      health: {
        captureFailure: false,
        cleanup: { status: 'healthy' as const, code: null, ownedEntryCount: 0 },
      },
      backupPolicy: resolveVoiceSpeechDiagnosticsStoragePolicy('daemon_desktop'),
  });
  if (request.method === `m1:${RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_CONFIGURE}`) return VoiceSpeechDiagnosticsStatusResponseV1Schema.parse({
    ok: true, root: '/private/m1', settings: VoiceSpeechDiagnosticsConfigureRequestV1Schema.parse(request.params).settings, artifacts: [],
    health: { captureFailure: false, cleanup: { status: 'healthy', code: null, ownedEntryCount: 0 } },
    backupPolicy: resolveVoiceSpeechDiagnosticsStoragePolicy('daemon_desktop'),
  });
  throw new Error(`Unexpected diagnostics RPC: ${request.method}`);
});
const { storage } = await import('@/sync/domains/state/storage');
const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
const { setVoiceSessionSnapshot, resetVoiceSessionStoreForTests } = await import('@/voice/session/voiceSessionStore');
let home: Awaited<ReturnType<typeof serveAccountHomes>>;
let disconnect: (() => Promise<void>) | undefined;
let restoreBrowserLocks: (() => void) | undefined;

import { VoiceDiagnosticsSettingsSection } from './VoiceDiagnosticsSettingsSection';
import { VoiceDiagnosticsIndicator } from './VoiceDiagnosticsIndicator';
import { ModalProvider } from '@/modal';
import {
  publishVoiceDiagnosticsRuntimeStatus,
  beginVoiceDiagnosticsRevocationObligation,
  resetVoiceDiagnosticsRuntimeStatusForTests,
} from './runtimeStatus';
import { resetVoiceDiagnosticsRevocationForTests } from './runtimeRevocation';
import { resetVoiceDiagnosticsSessionPolicyForTests } from './capturePolicy';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function requireElement(selector: string): HTMLElement {
  const element = container?.querySelector(selector);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Missing element: ${selector}`);
  }
  return element;
}

async function waitForControlRemoval(selector: string): Promise<void> {
  await waitForTestEvent((notify) => {
    const observer = new MutationObserver(notify);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, () => container?.querySelector(selector), value => value === null);
  expect(container?.querySelector(selector)).toBeNull();
}

async function waitForConfirmation(): Promise<HTMLElement> {
  const confirm = await waitForTestEvent((notify) => {
    const observer = new MutationObserver(notify);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, () => document.querySelector('[data-testid="web-modal-confirm"]'), value => value instanceof HTMLElement);
  if (!(confirm instanceof HTMLElement)) throw new Error('Missing real diagnostics confirmation control');
  return confirm;
}

async function waitForFocus(target: HTMLElement | null): Promise<void> {
  await waitForTestEvent((notify) => {
    document.addEventListener('focusin', notify);
    return () => document.removeEventListener('focusin', notify);
  }, () => document.activeElement, value => value === target);
}

function pressWithPointer(node: HTMLElement): void {
  const base = { bubbles: true, cancelable: true, button: 0, clientX: 4, clientY: 4 };
  node.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
  node.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
  node.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0 }));
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
  });
}

async function renderSettings(surface?: React.ReactNode): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <ModalProvider>{surface ?? <VoiceDiagnosticsSettingsSection
        voice={boundary.voice!}
        setVoice={(voice) => storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({ voice }, storage.getState().settings))}
      />}</ModalProvider>,
    );
  });
  await flush();
}

describe('VoiceDiagnosticsSettingsSection web focus return', () => {
  beforeEach(async () => {
    restoreBrowserLocks = installBrowserStorageLockBoundary();
    boundary.voice = voiceSettingsParse({
      executionMachine: { mode: 'fixed', machineId: 'm1' },
      diagnostics: {
        v: 1,
        enabled: true,
        consentVersion: 1,
        captureSttInput: true,
        captureTtsOutput: false,
      },
    });
    home = await serveAccountHomes({ homes: [{ key: 'diagnostics', serverUrl: 'https://diagnostics-focus.test', accountId: 'account-a',
      settings: { voice: boundary.voice } }],
      route: ({ path, method, body }) => path === '/v1/machines'
        ? Response.json([createPlainMachineRowFixture({ id: 'm1', accountId: 'account-a' })])
        : createPlainMachineReadHttpResponseFixture(path,
        { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, 'account-a') ?? undefined });
    disconnect = await home.restoreActiveConnection();
    resetVoiceSessionStoreForTests();
    boundary.sessionId = 'focused-diagnostics-session';
    const machine = createMachineFixture({ id: 'm1', storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, activeAt: Date.now() });
    storage.setState({ machines: { m1: machine }, machineListByServerId: { [home.homes.diagnostics!.id]: [machine] } });
    setVoiceSessionSnapshot({ adapterId: 'local_conversation', sessionId: boundary.sessionId, status: 'connected', mode: 'listening', canStop: true });
    boundary.revokeCaptureAuthorization.mockClear();
    resetVoiceDiagnosticsRuntimeStatusForTests();
    resetVoiceDiagnosticsRevocationForTests();
    resetVoiceDiagnosticsSessionPolicyForTests();
    publishVoiceDiagnosticsRuntimeStatus({ machineId: 'm1', phase: 'active' });
  });

  afterEach(async () => {
    const activeRoot = root;
    if (activeRoot) {
      await act(async () => {
        activeRoot.unmount();
      });
    }
    container?.remove();
    container = null;
    root = null;
    await disconnect?.();
    await home?.dispose();
    restoreBrowserLocks?.();
  });

  it('returns focus to the persistent diagnostics-enabled Switch after session opt-out removes its focused action', async () => {
    await renderSettings();

    const sessionOptOut = requireElement(`[aria-label="${tLoose('settingsVoice.diagnostics.sessionOptOut')}"]`);
    const diagnosticsEnabledSwitch = requireElement(`[aria-label="${tLoose('settingsVoice.diagnostics.enabled')}"]`);
    sessionOptOut.focus();
    expect(document.activeElement).toBe(sessionOptOut);

    await act(async () => {
      pressWithPointer(sessionOptOut);
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();
    const confirm = await waitForConfirmation();
    await act(async () => { pressWithPointer(confirm); });
    await flush();

    expect(boundary.revokeCaptureAuthorization).toHaveBeenCalledTimes(1);
    expect(container?.querySelector(`[aria-label="${tLoose('settingsVoice.diagnostics.sessionOptOut')}"]`)).toBeNull();
    await waitForFocus(diagnosticsEnabledSwitch);
    expect(document.activeElement).toBe(diagnosticsEnabledSwitch);
  });

  it('returns focus to the stable indicator fallback after the real opt-out confirmation is pressed', async () => {
    const fallback = React.createRef<HTMLButtonElement>();
    await renderSettings(<>
      <button ref={fallback}>Diagnostics status</button>
      <VoiceDiagnosticsIndicator sessionId={boundary.sessionId} focusFallbackRef={fallback} />
    </>);
    const optOut = requireElement(`[aria-label="${tLoose('settingsVoice.diagnostics.sessionOptOut')}"]`);
    optOut.focus();
    await act(async () => { pressWithPointer(optOut); });
    await flush();
    const confirm = await waitForConfirmation();
    await act(async () => { pressWithPointer(confirm); });
    await waitForControlRemoval(`[aria-label="${tLoose('settingsVoice.diagnostics.sessionOptOut')}"]`);
    await waitForFocus(fallback.current);
    expect(document.activeElement).toBe(fallback.current);
  });

  it('keeps user focus elsewhere when the acknowledged opt-out settles after navigation within the page', async () => {
    const response = createDeferred<void>();
    const revokeStarted = createDeferred<void>();
    boundary.revokeCaptureAuthorization.mockImplementationOnce(async () => { revokeStarted.resolve(); await response.promise; });
    const fallback = React.createRef<HTMLButtonElement>();
    const elsewhere = React.createRef<HTMLButtonElement>();
    await renderSettings(<>
      <button ref={fallback}>Diagnostics status</button><button ref={elsewhere}>Other action</button>
      <VoiceDiagnosticsIndicator sessionId={boundary.sessionId} focusFallbackRef={fallback} />
    </>);
    const optOut = requireElement(`[aria-label="${tLoose('settingsVoice.diagnostics.sessionOptOut')}"]`);
    optOut.focus();
    await act(async () => { pressWithPointer(optOut); });
    await flush();
    const confirm = await waitForConfirmation();
    await act(async () => { pressWithPointer(confirm); });
    await revokeStarted.promise;
    expect(boundary.revokeCaptureAuthorization).toHaveBeenCalledOnce();
    elsewhere.current!.focus();
    await act(async () => { response.resolve(); });
    await waitForControlRemoval(`[aria-label="${tLoose('settingsVoice.diagnostics.sessionOptOut')}"]`);
    expect(document.activeElement).toBe(elsewhere.current);
  });

  it('returns focus to the stable fallback after exact-machine shutdown removes its retry control', async () => {
    beginVoiceDiagnosticsRevocationObligation({ kind: 'machine_policy', machineId: 'm1' }, 'failed');
    const fallback = React.createRef<HTMLButtonElement>();
    await renderSettings(<>
      <button ref={fallback}>Diagnostics status</button>
      <VoiceDiagnosticsIndicator focusFallbackRef={fallback} />
    </>);
    const retry = requireElement(`[aria-label="${tLoose('settingsVoice.diagnostics.retryShutdown')}"]`);
    retry.focus();
    await act(async () => { pressWithPointer(retry); });
    await waitForControlRemoval(`[aria-label="${tLoose('settingsVoice.diagnostics.retryShutdown')}"]`);
    await waitForFocus(fallback.current);
    expect(document.activeElement).toBe(fallback.current);
  });
});
