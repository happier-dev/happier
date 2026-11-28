import { z } from 'zod';
import { lazySchema } from '@happier-dev/protocol';

import type { PiRpcCommandWithoutId } from '../rpc/types';

/**
 * Wire contract between the Happier runner (shared-terminal host) and the Happier bridge
 * extension running inside an interactive (TUI) Pi process.
 *
 * Transport: loopback TCP opened by the runner; the bridge dials out at `session_start`.
 * Framing: UTF-8 JSONL, one object per line.
 *
 * Bridge → runner:
 * 1. first line: {@link PiSharedControlHello} (pre-auth, bounded by {@link PI_SHARED_CONTROL_HELLO_MAX_BYTES});
 * 2. `{ch:'out', line}`: a record the RPC backend would read from Pi's stdout;
 * 3. `{ch:'err', line}`: a side-channel marker the RPC backend would read from Pi's stderr;
 * 4. `{type:'bye', reason}`: sent immediately before a deliberate close.
 *
 * Runner → bridge: one admission frame after the hello matches the bound native session. Raw Pi
 * RPC command lines follow, with the same shapes as the spawned RPC process.
 *
 * The token travels only in the protected bridge config file, never in env or argv.
 */
export const PI_SHARED_CONTROL_PROTOCOL_VERSION = 1;
export const PI_SHARED_CONTROL_ADMISSION_FRAME = 'happier_session_admitted';

/** Timeout for a command response from the native terminal bridge. */
export const PI_SHARED_CONTROL_RESPONSE_TIMEOUT_MS = 30_000;

/**
 * Pre-auth bound: the most bytes the runner reads before the first newline on an unauthenticated
 * connection. Protects the runner from unauthenticated local peers. Derivation: the hello carries a
 * ~43-byte token, a session UUID and `sessionFile`, which is bounded by the Windows long-path limit
 * of 32 767 characters.
 */
export const PI_SHARED_CONTROL_HELLO_MAX_BYTES = 64 * 1024;

/** Pi RPC commands the bridge executes in shared mode; everything else calls no Pi API. */
export const PI_SHARED_CONTROL_SUPPORTED_COMMANDS = [
  'get_state',
  'get_commands',
  'get_session_stats',
  'prompt',
  'abort',
  'set_model',
  'set_thinking_level',
] as const satisfies readonly PiRpcCommandWithoutId['type'][];

export type PiSharedControlSupportedCommand = (typeof PI_SHARED_CONTROL_SUPPORTED_COMMANDS)[number];

/** A web prompt was refused without being sent: Pi is busy or has native queued input. */
export const PI_SHARED_CONTROL_BUSY_ERROR = 'pi_shared_busy';
/** The command is not supported in shared mode; no Pi API was called. */
export const PI_SHARED_CONTROL_UNSUPPORTED_COMMAND_ERROR = 'pi_shared_unsupported_command';
/** The bridge connection is gone (closed without `bye`, or Pi exited). */
export const PI_SHARED_CONTROL_BRIDGE_UNAVAILABLE_ERROR = 'pi_shared_bridge_unavailable';

/** Failed prompt response when the bridge could not confirm its call to Pi. */
export const PI_SHARED_CONTROL_INDETERMINATE_OUTCOME = 'indeterminate';
export const PI_SHARED_CONTROL_PROMPT_HANDED_OFF = 'handed_off';

/** Pi inter-extension bus channel (`pi.events`) carrying stderr-style side-channel lines in TUI mode. */
export const PI_SHARED_CONTROL_SIDE_CHANNEL_EVENT = 'happier:pi-side-channel';

/** Pi `session_shutdown` reasons; any reason other than `quit` is followed by a new hello. */
export const PI_SHARED_CONTROL_SHUTDOWN_REASONS = ['quit', 'reload', 'new', 'resume', 'fork'] as const;

export type PiSharedControlShutdownReason = (typeof PI_SHARED_CONTROL_SHUTDOWN_REASONS)[number];

/** Endpoint and capability, stored as `sharedControl` in the protected bridge session config. */
export const PiSharedControlConfigSchema = lazySchema(() => z.object({
  host: z.literal('127.0.0.1'),
  port: z.number().int().min(1).max(65_535),
  token: z.string().min(1),
}).strict());

export type PiSharedControlConfig = z.infer<typeof PiSharedControlConfigSchema>;

/** First bridge line on every connection. */
export const PiSharedControlHelloSchema = lazySchema(() => z.object({
  type: z.literal('hello'),
  v: z.literal(PI_SHARED_CONTROL_PROTOCOL_VERSION),
  token: z.string().min(1),
  sessionId: z.string().min(1),
  sessionFile: z.string().min(1).nullable(),
}).strict());

export type PiSharedControlHello = z.infer<typeof PiSharedControlHelloSchema>;

/** Post-hello bridge lines. `line` is JSON text for the existing stdout/stderr line handlers. */
export const PiSharedControlBridgeFrameSchema = lazySchema(() => z.union([
  z.object({ ch: z.literal('out'), line: z.string() }).strict(),
  z.object({ ch: z.literal('err'), line: z.string() }).strict(),
  z.object({ type: z.literal('bye'), reason: z.enum(PI_SHARED_CONTROL_SHUTDOWN_REASONS) }).strict(),
]));

export type PiSharedControlBridgeFrame = z.infer<typeof PiSharedControlBridgeFrameSchema>;
