import { z } from 'zod';
import { WINDOWS_REMOTE_SESSION_LAUNCH_MODES } from './windowsRemoteSessionLaunchMode.js';
import { lazySchema } from '../lazySchema.js';

/**
 * Session terminal attachment metadata (stored in encrypted `session.metadata`).
 *
 * Keep schemas permissive (passthrough) for forward compatibility.
 * Use factory forms for nohoist/multi-Zod repos.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeTerminalWireSelectors(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const { hostKind, requestedHostKind, ...terminal } = value;
  return {
    ...terminal,
    ...(hostKind === 'herdr'
      ? (terminal.mode === 'plain' ? { mode: 'herdr' } : {})
      : (hostKind === undefined ? {} : { hostKind })),
    ...(requestedHostKind === 'herdr'
      ? (terminal.requested === 'plain' ? { requested: 'herdr' } : {})
      : (requestedHostKind === undefined ? {} : { requestedHostKind })),
  };
}

export function createHerdrTerminalMetadataSchema(zod: typeof z) {
  return zod.object({
    sessionName: zod.string(),
    socketPath: zod.string(),
    terminalId: zod.string(),
    paneId: zod.string().optional(),
  });
}

export function createSessionTerminalMetadataSchema(zod: typeof z) {
  const terminalModeSchema = zod.enum(['plain', 'tmux', 'zellij', 'herdr', 'windows_terminal', 'windows_console']);
  const requestedModeSchema = zod.enum(['plain', 'tmux', 'zellij', 'herdr', ...WINDOWS_REMOTE_SESSION_LAUNCH_MODES]);
  const schema = zod
    .object({
      // Optional only for compatibility with retirement tombstones written by the
      // first attachment-bound serviceability writer before it preserved host mode.
      mode: terminalModeSchema.optional(),
      requested: requestedModeSchema.optional(),
      fallbackReason: zod.string().optional(),
      controlServiceabilityV1: zod.object({
        v: zod.literal(1),
        attachmentId: zod.string().optional(),
        state: zod.enum(['servable', 'recoverable_unservable', 'unknown']),
        observedAt: zod.number(),
        reason: zod.string().optional(),
        retired: zod.boolean().optional(),
      }).passthrough().optional(),
      tmux: zod
        .object({
          target: zod.string(),
          tmpDir: zod.string().nullable().optional(),
        })
        .optional(),
      zellij: zod
        .object({
          sessionName: zod.string(),
          paneId: zod.string().optional(),
          /** Socket-root attestation for hosts written by the v1 terminal-host metadata writer. */
          socketDirV1: zod.string().optional(),
        })
        .optional(),
      herdr: createHerdrTerminalMetadataSchema(zod).optional(),
      windows: zod
        .object({
          host: zod.enum(['windows_terminal', 'console']),
          windowId: zod.string().optional(),
          pid: zod.number().int().optional(),
          title: zod.string().optional(),
        })
        .optional(),
    })
    .passthrough()
    .superRefine((terminal, ctx) => {
      if (terminal.mode !== undefined) return;
      if (terminal.controlServiceabilityV1?.retired === true) return;
      ctx.addIssue({
        code: 'custom',
        path: ['mode'],
        message: 'Terminal mode is required outside legacy retirement tombstones',
      });
    });
  return zod.preprocess(normalizeTerminalWireSelectors, schema);
}

export const SessionTerminalMetadataSchema = lazySchema(() => createSessionTerminalMetadataSchema(z));
export type SessionTerminalMetadata = z.infer<typeof SessionTerminalMetadataSchema>;

/**
 * Released UIs through ui-web-v0.2.12 reject unknown values in both terminal
 * enums, rejecting the entire Session metadata. Keep those enum fields readable
 * and carry Herdr's actual host/request as additive passthrough properties.
 * Domain readers immediately normalize them; they are never a second selector.
 */
export function projectSessionMetadataForWire(metadata: unknown): unknown {
  if (!isRecord(metadata) || !isRecord(metadata.terminal)) return metadata;
  const terminal = normalizeTerminalWireSelectors(metadata.terminal);
  if (!isRecord(terminal)) return metadata;
  return {
    ...metadata,
    terminal: {
      ...terminal,
      ...(terminal.mode === 'herdr' ? { mode: 'plain', hostKind: 'herdr' } : {}),
      ...(terminal.requested === 'herdr' ? { requested: 'plain', requestedHostKind: 'herdr' } : {}),
    },
  };
}

export function normalizeSessionMetadataForRead<T extends { terminal?: unknown }>(
  metadata: T,
): Omit<T, 'terminal'> & { terminal?: SessionTerminalMetadata };
export function normalizeSessionMetadataForRead<T extends { terminal?: unknown }>(
  metadata: T | null,
): (Omit<T, 'terminal'> & { terminal?: SessionTerminalMetadata }) | null;
export function normalizeSessionMetadataForRead<T extends { terminal?: unknown }>(metadata: T | null) {
  if (metadata === null) return null;
  const { terminal, ...rest } = metadata;
  return terminal === undefined
    ? rest
    : { ...rest, terminal: SessionTerminalMetadataSchema.parse(terminal) };
}

export type TerminalControlServiceabilityPolicy = Readonly<{
  hostPresence: 'absent' | 'preserved' | 'retired';
  canRequestStop: boolean;
}>;

export function resolveTerminalControlServiceabilityPolicy(
  value: SessionTerminalMetadata['controlServiceabilityV1'] | null | undefined,
): TerminalControlServiceabilityPolicy {
  if (!value || value.v !== 1) {
    return { hostPresence: 'absent', canRequestStop: false };
  }
  if (value.retired === true) {
    return { hostPresence: 'retired', canRequestStop: false };
  }
  const hasAttachmentId = typeof value.attachmentId === 'string' && value.attachmentId.trim().length > 0;
  return {
    hostPresence: 'preserved',
    canRequestStop: hasAttachmentId
      && (value.state === 'servable' || value.state === 'recoverable_unservable'),
  };
}
