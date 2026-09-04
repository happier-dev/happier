import { describe, expect, it } from 'vitest';

import { ZellijActionTimeoutError } from './actions';
import { createZellijTerminalControlPort, type ZellijControlActions } from './control';

const SHIFT_TAB = `${String.fromCharCode(0x1b)}[Z`;
const BASE_ENV = { ZELLIJ_SOCKET_DIR: '/tmp/sock' } as const;

type Recorder = {
  actions: ZellijControlActions;
  writes: Array<{ paneId: string; text: string; env: Readonly<Record<string, string>> }>;
  enters: string[];
  escapes: string[];
  dumps: string[];
};

function recordingActions(opts?: Readonly<{
  dumpScreenReturn?: string;
  overrides?: Partial<ZellijControlActions>;
}>): Recorder {
  const writes: Recorder['writes'] = [];
  const enters: string[] = [];
  const escapes: string[] = [];
  const dumps: string[] = [];
  const actions: ZellijControlActions = {
    async writeBytesChunked(params) {
      writes.push({ paneId: params.paneId, text: params.text, env: params.env });
    },
    async sendEnter(params) {
      enters.push(params.paneId);
    },
    async sendEscape(params) {
      escapes.push(params.paneId);
    },
    async dumpScreen(params) {
      dumps.push(params.paneId);
      return opts?.dumpScreenReturn ?? '';
    },
    ...opts?.overrides,
  };
  return { actions, writes, enters, escapes, dumps };
}

const OMIT_PANE = Symbol('omit-pane');

function makePort(rec: Recorder, paneId: string | typeof OMIT_PANE = 'terminal_2', nowMs = () => 7) {
  return createZellijTerminalControlPort({
    actions: rec.actions,
    zellijBinary: 'zellij',
    env: BASE_ENV,
    sessionName: 'happy',
    ...(paneId === OMIT_PANE ? {} : { paneId }),
    nowMs,
  });
}

describe('createZellijTerminalControlPort', () => {
  it('exposes the zellij host kind', () => {
    expect(makePort(recordingActions()).hostKind).toBe('zellij');
  });

  it('is a control-only surface that is NOT a prompt-injection surface (A6 fence)', () => {
    const port = makePort(recordingActions());
    expect('injectUserPrompt' in port).toBe(false);
    expect(typeof port.sendLiteralText).toBe('function');
    expect(typeof port.sendRawSequence).toBe('function');
    expect(typeof port.sendSpecialKey).toBe('function');
    expect(typeof port.captureScreen).toBe('function');
  });

  it('writes literal text without submitting (no sendEnter)', async () => {
    const rec = recordingActions();
    const result = await makePort(rec).sendLiteralText('/effort high');

    expect(result.status).toBe('sent');
    expect(rec.writes).toEqual([
      { paneId: 'terminal_2', text: '/effort high', env: { ...BASE_ENV, ZELLIJ_SESSION_NAME: 'happy' } },
    ]);
    expect(rec.enters).toEqual([]);
  });

  it('writes raw escape sequences literally', async () => {
    const rec = recordingActions();
    const result = await makePort(rec).sendRawSequence(SHIFT_TAB);

    expect(result.status).toBe('sent');
    expect(rec.writes.map((w) => w.text)).toEqual([SHIFT_TAB]);
  });

  it('sends Enter and Escape through native zellij actions', async () => {
    const rec = recordingActions();
    await makePort(rec).sendSpecialKey('Enter');
    await makePort(rec).sendSpecialKey('Escape');

    expect(rec.enters).toEqual(['terminal_2']);
    expect(rec.escapes).toEqual(['terminal_2']);
  });

  it('sends ShiftTab as the raw ESC [ Z sequence and NEVER a named S-Tab', async () => {
    const rec = recordingActions();
    const result = await makePort(rec).sendSpecialKey('ShiftTab');

    expect(result.status).toBe('sent');
    expect(rec.writes.map((w) => w.text)).toEqual([SHIFT_TAB]);
    expect(rec.enters).toEqual([]);
    expect(rec.writes.some((w) => w.text.includes('S-Tab'))).toBe(false);
  });

  it('sends Tab as a raw tab byte', async () => {
    const rec = recordingActions();
    await makePort(rec).sendSpecialKey('Tab');
    expect(rec.writes.map((w) => w.text)).toEqual(['\t']);
  });

  it('sends selection arrows as terminal escape sequences', async () => {
    const rec = recordingActions();
    const port = makePort(rec);

    await port.sendSpecialKey('ArrowUp');
    await port.sendSpecialKey('ArrowDown');

    expect(rec.writes.map((write) => write.text)).toEqual(['\u001b[A', '\u001b[B']);
  });

  it('captures the FULL pane via dump-screen and strips ANSI via the shared normalizer', async () => {
    const esc = String.fromCharCode(0x1b);
    const rec = recordingActions({ dumpScreenReturn: `${esc}[2mtop${esc}[0m\nmiddle\nbottom  \n` });
    const result = await makePort(rec, 'terminal_2', () => 999).captureScreen();

    expect(rec.dumps).toEqual(['terminal_2']);
    expect(result).toEqual({
      status: 'captured',
      capture: { text: 'top\nmiddle\nbottom', styledText: `${esc}[2mtop${esc}[0m\nmiddle\nbottom  \n`, capturedAtMs: 999, hostKind: 'zellij' },
    });
  });

  it('returns a typed unsupported result (no best-effort) when there is no pane id', async () => {
    const rec = recordingActions();
    const port = makePort(rec, OMIT_PANE);

    await expect(port.sendLiteralText('x')).resolves.toEqual({ status: 'unsupported', reason: 'no_target' });
    await expect(port.sendSpecialKey('Enter')).resolves.toEqual({ status: 'unsupported', reason: 'no_target' });
    await expect(port.captureScreen()).resolves.toEqual({ status: 'unsupported', reason: 'no_target' });
    expect(rec.writes).toEqual([]);
    expect(rec.enters).toEqual([]);
    expect(rec.dumps).toEqual([]);
  });

  it('maps an inactive/dead zellij session to a typed host_dead result', async () => {
    const rec = recordingActions({
      overrides: {
        async dumpScreen() {
          throw new Error('zellij dump-screen failed: There is no active session');
        },
        async writeBytesChunked() {
          throw new Error('zellij write failed: There is no active session');
        },
      },
    });
    const port = makePort(rec);

    await expect(port.captureScreen()).resolves.toEqual({ status: 'host_dead', recoverable: false });
    await expect(port.sendLiteralText('x')).resolves.toEqual({ status: 'host_dead', recoverable: false });
  });

  it('maps a zellij action timeout to a typed timeout failure', async () => {
    const rec = recordingActions({
      overrides: {
        async writeBytesChunked() {
          throw new ZellijActionTimeoutError('write');
        },
      },
    });

    await expect(makePort(rec).sendRawSequence(SHIFT_TAB)).resolves.toEqual({
      status: 'failed',
      reason: 'timeout',
    });
  });
});
