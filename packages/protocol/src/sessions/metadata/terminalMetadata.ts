import { z } from 'zod';
import { WINDOWS_REMOTE_SESSION_LAUNCH_MODES } from './windowsRemoteSessionLaunchMode.js';

/**
 * Session terminal attachment metadata (stored in encrypted `session.metadata`).
 *
 * Keep schemas permissive (passthrough) for forward compatibility.
 * Use factory forms for nohoist/multi-Zod repos.
 */

type TerminalMetadataContext = 'legacy' | 'owner';

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

export function createSessionTerminalControlServiceabilityV1Schema(zod: typeof z, context: TerminalMetadataContext = 'legacy') {
  return zod.object({
    v: zod.literal(1),
    attachmentId: (context === 'owner' ? zod.string().max(2_000) : zod.string()).optional(),
    state: zod.enum(['servable', 'recoverable_unservable', 'unknown']),
    observedAt: zod.number(),
    reason: (context === 'owner' ? zod.string().max(20_000) : zod.string()).optional(),
    retired: zod.boolean().optional(),
  }).passthrough();
}

export const SessionTerminalControlServiceabilityV1Schema = createSessionTerminalControlServiceabilityV1Schema(z);

export function createHerdrTerminalMetadataSchema(zod: typeof z, context: TerminalMetadataContext = 'legacy') {
  const string = (maximum: number) => context === 'owner' ? zod.string().max(maximum) : zod.string();
  const shape = {
    sessionName: string(20_000), socketPath: string(100_000),
    terminalId: string(2_000), paneId: string(2_000).optional(),
  };
  return context === 'owner' ? zod.object(shape).strict() : zod.object(shape);
}

function createTerminalObjectSchema(zod: typeof z, context: TerminalMetadataContext) {
  // Owner envelopes retain their existing bounded, closed policy. Legacy flat
  // metadata remains a round-trip custodian with permissive presentation fields.
  const string = (ownerMax: number) => context === 'owner' ? zod.string().max(ownerMax) : zod.string();
  const object = <T extends z.ZodRawShape>(shape: T) => context === 'owner' ? zod.object(shape).strict() : zod.object(shape);
  const terminalModeSchema = zod.enum(['plain', 'tmux', 'zellij', 'herdr', 'windows_terminal', 'windows_console']);
  const requestedModeSchema = zod.enum(['plain', 'tmux', 'zellij', 'herdr', ...WINDOWS_REMOTE_SESSION_LAUNCH_MODES]);
  return zod.object({
      mode: terminalModeSchema.optional(),
      requested: requestedModeSchema.optional(),
      fallbackReason: string(20_000).optional(),
      controlServiceabilityV1: createSessionTerminalControlServiceabilityV1Schema(zod, context).optional(),
      tmux: object({
        target: string(20_000),
        tmpDir: string(100_000).nullable().optional(),
      }).optional(),
      zellij: object({
        sessionName: string(20_000),
        paneId: string(2_000).optional(),
        socketDirV1: string(100_000).optional(),
      }).optional(),
      herdr: createHerdrTerminalMetadataSchema(zod, context).optional(),
      windows: object({
        host: zod.enum(['windows_terminal', 'console']),
        windowId: string(2_000).optional(),
        pid: zod.number().int().optional(),
        title: string(20_000).optional(),
      }).optional(),
  });
}

function refineTerminalMode(value: { mode?: unknown; controlServiceabilityV1?: { retired?: boolean } }, ctx: z.RefinementCtx) {
  if (value.mode === undefined && value.controlServiceabilityV1?.retired !== true) {
    ctx.addIssue({
      code: 'custom',
      path: ['mode'],
      message: 'Mode-less terminal metadata is accepted only for an explicitly retired legacy attachment',
    });
  }
}

function createOwnerTerminalSchema(zod: typeof z) {
  const schema = createTerminalObjectSchema(zod, 'owner').extend({
    controlServiceabilityV1: createSessionTerminalControlServiceabilityV1Schema(zod, 'owner').strict().optional(),
  }).strict().superRefine(refineTerminalMode);
  return zod.preprocess(normalizeTerminalWireSelectors, schema);
}

function createLegacyTerminalSchema(zod: typeof z) {
  return zod.preprocess(normalizeTerminalWireSelectors, createTerminalObjectSchema(zod, 'legacy').passthrough().superRefine(refineTerminalMode));
}

export function createSessionTerminalMetadataSchema(zod: typeof z, context: 'owner'): ReturnType<typeof createOwnerTerminalSchema>;
export function createSessionTerminalMetadataSchema(zod: typeof z, context?: 'legacy'): ReturnType<typeof createLegacyTerminalSchema>;
export function createSessionTerminalMetadataSchema(zod: typeof z, context: TerminalMetadataContext = 'legacy') {
  return context === 'owner' ? createOwnerTerminalSchema(zod) : createLegacyTerminalSchema(zod);
}

export const SessionTerminalMetadataSchema = createSessionTerminalMetadataSchema(z);
export type SessionTerminalMetadata = z.infer<typeof SessionTerminalMetadataSchema>;

/** Flat metadata only: the released ui-web-v0.2.12 terminal enums reject Herdr.
 * Additive selectors preserve its reader and round-trip writes; domain readers
 * normalize them immediately. Account-owned envelopes keep their strict shape.
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

export function normalizeSessionMetadataForRead<T extends { terminal?: unknown }>(metadata: T): Omit<T, 'terminal'> & { terminal?: SessionTerminalMetadata };
export function normalizeSessionMetadataForRead<T extends { terminal?: unknown }>(metadata: T | null): (Omit<T, 'terminal'> & { terminal?: SessionTerminalMetadata }) | null;
export function normalizeSessionMetadataForRead<T extends { terminal?: unknown }>(metadata: T | null) {
  if (metadata === null) return null;
  const { terminal, ...rest } = metadata;
  return terminal === undefined ? rest : { ...rest, terminal: SessionTerminalMetadataSchema.parse(terminal) };
}

/**
 * The one reader for the terminal control-serviceability state held in owner metadata. Hosts hold
 * this evidence in different views (decoded owner metadata, the renderable list projection, the
 * CLI's decrypted row), so the shape is parsed here rather than per host: a malformed or
 * foreign-version envelope is `null` (no evidence), never a fabricated state.
 */
export function readSessionTerminalControlServiceabilityStateV1(
  value: unknown,
): 'servable' | 'recoverable_unservable' | 'unknown' | null {
  const parsed = SessionTerminalControlServiceabilityV1Schema.safeParse(value);
  return parsed.success ? parsed.data.state : null;
}

export function isSessionTerminalPermanentlyAbsent(
  value: SessionTerminalMetadata['controlServiceabilityV1'] | null | undefined,
): boolean {
  return value?.v === 1 && value.retired === true;
}
