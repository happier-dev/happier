import { z } from '../../zodRuntimePolicy.js';
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
  return zod.looseObject({
    v: zod.literal(1),
    attachmentId: zod.optional((context === 'owner' ? zod.string().check(zod.maxLength(2_000)) : zod.string())),
    state: zod.enum(['servable', 'recoverable_unservable', 'unknown']),
    observedAt: zod.number(),
    reason: zod.optional((context === 'owner' ? zod.string().check(zod.maxLength(20_000)) : zod.string())),
    retired: zod.optional(zod.boolean()),
  });
}

export const SessionTerminalControlServiceabilityV1Schema = createSessionTerminalControlServiceabilityV1Schema(z);

export function createHerdrTerminalMetadataSchema(zod: typeof z, context: TerminalMetadataContext = 'legacy') {
  const string = (maximum: number) => context === 'owner' ? zod.string().check(zod.maxLength(maximum)) : zod.string();
  const shape = {
    sessionName: string(20_000), socketPath: string(100_000),
    terminalId: string(2_000), paneId: zod.optional(string(2_000)),
  };
  return context === 'owner' ? zod.strictObject(shape) : zod.object(shape);
}

function createTerminalObjectSchema(zod: typeof z, context: TerminalMetadataContext) {
  // Owner envelopes retain their existing bounded, closed policy. Legacy flat
  // metadata remains a round-trip custodian with permissive presentation fields.
  const string = (ownerMax: number) => context === 'owner' ? zod.string().check(zod.maxLength(ownerMax)) : zod.string();
  const object = <T extends z.core.$ZodShape>(shape: T) => context === 'owner' ? zod.strictObject(shape) : zod.object(shape);
  const terminalModeSchema = zod.enum(['plain', 'tmux', 'zellij', 'herdr', 'windows_terminal', 'windows_console']);
  const requestedModeSchema = zod.enum(['plain', 'tmux', 'zellij', 'herdr', ...WINDOWS_REMOTE_SESSION_LAUNCH_MODES]);
  return zod.object({
      mode: zod.optional(terminalModeSchema),
      requested: zod.optional(requestedModeSchema),
      fallbackReason: zod.optional(string(20_000)),
      controlServiceabilityV1: zod.optional(createSessionTerminalControlServiceabilityV1Schema(zod, context)),
      tmux: zod.optional(object({
        target: string(20_000),
        tmpDir: zod.optional(zod.nullable(string(100_000))),
      })),
      zellij: zod.optional(object({
        sessionName: string(20_000),
        paneId: zod.optional(string(2_000)),
        socketDirV1: zod.optional(string(100_000)),
      })),
      herdr: zod.optional(createHerdrTerminalMetadataSchema(zod, context)),
      windows: zod.optional(object({
        host: zod.enum(['windows_terminal', 'console']),
        windowId: zod.optional(string(2_000)),
        pid: zod.optional(zod.number().check(zod.int())),
        title: zod.optional(string(20_000)),
      })),
  });
}

function refineTerminalMode(value: { mode?: unknown; controlServiceabilityV1?: { retired?: boolean } }, ctx: z.core.$RefinementCtx) {
  if (value.mode === undefined && value.controlServiceabilityV1?.retired !== true) {
    ctx.addIssue({
      code: 'custom',
      path: ['mode'],
      message: 'Mode-less terminal metadata is accepted only for an explicitly retired legacy attachment',
    });
  }
}

function createOwnerTerminalSchema(zod: typeof z) {
  const schema = (<T extends z.ZodMiniObject>(schema: T) => zod.core.clone(schema, { ...schema._zod.def, catchall: zod.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(zod.extend(createTerminalObjectSchema(zod, 'owner'), {
    controlServiceabilityV1: zod.optional((<T extends z.ZodMiniObject>(schema: T) => zod.core.clone(schema, { ...schema._zod.def, catchall: zod.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(createSessionTerminalControlServiceabilityV1Schema(zod, 'owner'))),
  })).check(zod.superRefine(refineTerminalMode));
  return (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new zod.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(zod.transform(normalizeTerminalWireSelectors), schema);
}

function createLegacyTerminalSchema(zod: typeof z) {
  return (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new zod.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(zod.transform(normalizeTerminalWireSelectors), (<T extends z.ZodMiniObject>(schema: T) => zod.core.clone(schema, { ...schema._zod.def, catchall: zod.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(createTerminalObjectSchema(zod, 'legacy')).check(zod.superRefine(refineTerminalMode)));
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
  if (value === null || value === undefined) return null;
  const parsed = SessionTerminalControlServiceabilityV1Schema.safeParse(value);
  return parsed.success ? parsed.data.state : null;
}

export function isSessionTerminalPermanentlyAbsent(
  value: SessionTerminalMetadata['controlServiceabilityV1'] | null | undefined,
): boolean {
  return value?.v === 1 && value.retired === true;
}
