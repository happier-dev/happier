import { describe, expect, it, vi } from 'vitest';
import * as protocol from './terminalMetadata.js';
import { z } from '../../zodRuntimePolicy.js';
import { SessionTerminalMetadataSchema as ReleasedUiTerminalSchema } from './fixtures/uiWeb0212TerminalMetadata.js';

describe('sessionMetadata terminal metadata', () => {
  it('does not parse absent terminal serviceability while retaining validation for present evidence', () => {
    const parse = vi.spyOn(protocol.SessionTerminalControlServiceabilityV1Schema, 'safeParse');
    try {
      for (let index = 0; index < 20; index += 1) {
        expect(protocol.readSessionTerminalControlServiceabilityStateV1(undefined)).toBeNull();
        expect(protocol.readSessionTerminalControlServiceabilityStateV1(null)).toBeNull();
      }
      expect(parse).not.toHaveBeenCalled();
      expect(protocol.readSessionTerminalControlServiceabilityStateV1({ v: 1, state: 'servable', observedAt: 1 })).toBe('servable');
      expect(protocol.readSessionTerminalControlServiceabilityStateV1({ v: 2, state: 'servable', observedAt: 1 })).toBeNull();
    } finally { parse.mockRestore(); }
  });
  it.each(['herdr', 'plain'] as const)('round-trips a flat %s host with a Herdr preference through the ui-web-v0.2.12 reader', (mode) => {
    const metadata = {
      path: '/repo', name: 'original', providerExtension: { retained: true },
      terminal: {
        mode, requested: 'herdr' as const,
        ...(mode === 'herdr' ? { herdr: { sessionName: 'work', socketPath: '/tmp/herdr.sock', terminalId: 'term_1' } } : { fallbackReason: 'headless_runtime' }),
      },
    };
    const wire = protocol.projectSessionMetadataForWire(metadata);
    if (!wire || typeof wire !== 'object' || !('terminal' in wire)) throw new Error('Missing terminal projection');
    const releasedMutation = { ...metadata, name: 'renamed', terminal: ReleasedUiTerminalSchema.parse(wire.terminal) };
    const domain = protocol.normalizeSessionMetadataForRead(releasedMutation);
    expect(domain).toEqual({ ...metadata, name: 'renamed' });
    expect(protocol.projectSessionMetadataForWire(domain)).toEqual({ ...wire, name: 'renamed' });
    expect(metadata.name).toBe('original');
  });

  it('round-trips a holder-terminal (pty) host through the ui-web-v0.2.12 reader and the owner schema', () => {
    const metadata = { path: '/repo', name: 'original', terminal: { mode: 'pty' as const, requested: 'console' as const, pty: { host: 'holder' as const } } };
    const wire = protocol.projectSessionMetadataForWire(metadata);
    expect(wire).toEqual({ ...metadata, terminal: { mode: 'plain', hostKind: 'pty', requested: 'console', pty: { host: 'holder' } } });
    if (!wire || typeof wire !== 'object' || !('terminal' in wire)) throw new Error('Missing terminal projection');
    const releasedMutation = { ...metadata, name: 'renamed', terminal: ReleasedUiTerminalSchema.parse(wire.terminal) };
    expect(protocol.normalizeSessionMetadataForRead(releasedMutation)).toEqual({ ...metadata, name: 'renamed' });
    const owner = protocol.createSessionTerminalMetadataSchema(z, 'owner');
    expect(owner.parse(metadata.terminal)).toEqual(metadata.terminal);
    expect(owner.safeParse({ ...metadata.terminal, pty: { host: 'holder', extra: 1 } }).success).toBe(false);
    expect(owner.safeParse({ ...metadata.terminal, pty: { host: 'runner' } }).success).toBe(false);
    // Values written before `pty` keep parsing and projecting unchanged.
    for (const terminal of [
      { mode: 'windows_console', requested: 'console', windows: { host: 'console', windowId: 'happier-1' } },
      { mode: 'windows_console', requested: 'console', windows: { host: 'console', pid: 456 } },
      { mode: 'tmux', requested: 'tmux', tmux: { target: 'work:1' } },
    ] as const) {
      expect(ReleasedUiTerminalSchema.parse((protocol.projectSessionMetadataForWire({ terminal }) as { terminal: unknown }).terminal)).toEqual(terminal);
      expect(protocol.SessionTerminalMetadataSchema.parse(terminal)).toEqual(terminal);
    }
  });

  it('removes recognized wire selectors before a canonical host change is written', () => {
    const domain = protocol.normalizeSessionMetadataForRead({ terminal: { mode: 'plain', hostKind: 'herdr', requested: 'plain', requestedHostKind: 'herdr' } });
    const wire = protocol.projectSessionMetadataForWire({ terminal: { ...domain.terminal, mode: 'tmux', requested: 'tmux', tmux: { target: 'work:1' } } });
    expect(wire).toEqual({ terminal: { mode: 'tmux', requested: 'tmux', tmux: { target: 'work:1' } } });
  });

  it('normalizes the predecessor additive Herdr selectors without retaining competing host selectors', () => {
    expect(protocol.SessionTerminalMetadataSchema.parse({
      mode: 'plain', hostKind: 'herdr', requested: 'plain', requestedHostKind: 'herdr',
      herdr: { sessionName: 'work', socketPath: '/tmp/herdr.sock', terminalId: 'term_1' },
      providerExtension: { retained: true },
    })).toEqual({
      mode: 'herdr', requested: 'herdr',
      herdr: { sessionName: 'work', socketPath: '/tmp/herdr.sock', terminalId: 'term_1' },
      providerExtension: { retained: true },
    });
  });

  it('parses tmux terminal metadata and preserves unknown fields', () => {
    const parsed = (protocol as any).SessionTerminalMetadataSchema.parse({
      mode: 'tmux',
      requested: 'tmux',
      tmux: { target: 'happy:win-1', tmpDir: '/tmp/x' },
      extra: 'x',
    });
    expect(parsed.mode).toBe('tmux');
    expect((parsed as any).extra).toBe('x');
  });

  it('accepts tmux.tmpDir=null for backward compatibility', () => {
    const parsed = (protocol as any).SessionTerminalMetadataSchema.parse({
      mode: 'tmux',
      tmux: { target: 'happy:win-1', tmpDir: null },
    });
    expect(parsed.mode).toBe('tmux');
    expect((parsed as any).tmux?.tmpDir).toBe(null);
  });

  it('parses zellij terminal metadata and preserves unknown fields', () => {
    const parsed = (protocol as any).SessionTerminalMetadataSchema.parse({
      mode: 'zellij',
      requested: 'zellij',
      zellij: { sessionName: 'happy-session-1' },
      extra: 'x',
    });
    expect(parsed.mode).toBe('zellij');
    expect((parsed as any).extra).toBe('x');
  });

  it('validates the Zellij attachment identity', () => {
    expect(protocol.SessionTerminalMetadataSchema.safeParse({
      mode: 'zellij', zellij: { sessionName: 42, paneId: '9' },
    }).success).toBe(false);
    expect(protocol.SessionTerminalMetadataSchema.parse({
      mode: 'zellij', zellij: { sessionName: 'happier', paneId: '9' },
    }).zellij?.paneId).toBe('9');
  });

  it('parses Herdr terminal identity for attach and pane-move recovery', () => {
    const parsed = protocol.SessionTerminalMetadataSchema.parse({
      mode: 'herdr',
      requested: 'herdr',
      herdr: {
        sessionName: 'default',
        socketPath: '/tmp/herdr.sock',
        terminalId: 'term_1',
        paneId: 'w1:p7',
      },
    });
    expect(parsed.herdr?.terminalId).toBe('term_1');
  });

  it('parses windows terminal metadata', () => {
    const parsed = (protocol as any).SessionTerminalMetadataSchema.parse({
      mode: 'windows_terminal',
      requested: 'windows_terminal',
      windows: {
        host: 'windows_terminal',
        windowId: 'happy-session-1',
        pid: 123,
      },
    });
    expect(parsed.mode).toBe('windows_terminal');
    expect((parsed as any).windows?.windowId).toBe('happy-session-1');
  });

  it('parses windows console metadata', () => {
    const parsed = (protocol as any).SessionTerminalMetadataSchema.parse({
      mode: 'windows_console',
      requested: 'console',
      windows: {
        host: 'console',
        pid: 456,
      },
    });
    expect(parsed.mode).toBe('windows_console');
    expect((parsed as any).windows?.host).toBe('console');
  });

  it('parses recoverable terminal-host lifecycle metadata', () => {
    const parsed = (protocol as any).SessionTerminalMetadataSchema.parse({
      mode: 'tmux', tmux: { target: 'happy:win-1' },
      controlServiceabilityV1: { v: 1, attachmentId: 'attachment-1', state: 'recoverable_unservable', observedAt: 123, reason: 'session_rpc_unavailable' },
    });
    expect(parsed.controlServiceabilityV1.state).toBe('recoverable_unservable');
    expect((protocol as any).SessionTerminalMetadataSchema.safeParse({
      mode: 'tmux', tmux: { target: 'happy:win-1' },
      controlServiceabilityV1: { v: 1, state: 'running', observedAt: 123 },
    }).success).toBe(false);
  });

  it('accepts only explicitly retired legacy mode-less terminal metadata', () => {
    expect((protocol as any).SessionTerminalMetadataSchema.safeParse({
      controlServiceabilityV1: {
        v: 1,
        attachmentId: 'attachment-retired',
        state: 'unknown',
        observedAt: 123,
        reason: 'attachment_retired',
        retired: true,
      },
    }).success).toBe(true);

    expect((protocol as any).SessionTerminalMetadataSchema.safeParse({
      controlServiceabilityV1: {
        v: 1,
        attachmentId: 'attachment-still-live',
        state: 'unknown',
        observedAt: 123,
      },
    }).success).toBe(false);
  });

  it('reads the control-serviceability state only from a well-formed current-version envelope', () => {
    const read = (protocol as any).readSessionTerminalControlServiceabilityStateV1;
    expect(read({ v: 1, state: 'recoverable_unservable', observedAt: 1 })).toBe('recoverable_unservable');
    expect(read({ v: 1, state: 'servable', observedAt: 1, attachmentId: 'a' })).toBe('servable');
    // A host reader that accepted any object carrying `state` would admit these; the schema
    // does not, so both adapters agree that there is no evidence here.
    expect(read({ state: 'servable', observedAt: 1 })).toBeNull();
    expect(read({ v: 2, state: 'servable', observedAt: 1 })).toBeNull();
    expect(read({ v: 1, state: 'unheard_of', observedAt: 1 })).toBeNull();
    expect(read(undefined)).toBeNull();
  });

  it('permits destructive deletion only with explicit terminal retirement evidence', () => {
    const canDelete = (protocol as any).isSessionTerminalPermanentlyAbsent;
    expect(canDelete(undefined)).toBe(false);
    expect(canDelete({ v: 1, state: 'unknown', observedAt: 1 })).toBe(false);
    expect(canDelete({ v: 1, state: 'servable', observedAt: 1 })).toBe(false);
    expect(canDelete({ v: 1, state: 'recoverable_unservable', observedAt: 1 })).toBe(false);
    expect(canDelete({ v: 1, state: 'unknown', observedAt: 1, retired: true })).toBe(true);
  });
});
