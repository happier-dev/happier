import { isAbsolute } from 'node:path';
import { Readable } from 'node:stream';
import { z } from 'zod';

/** Host-private stdin framing; the remainder of stdin belongs to the Agent. */
const magic = Buffer.from('HAPAGT1\n', 'ascii');
const nonNullString = z.string().refine((value) => !value.includes('\0'));
const absolutePath = nonNullString.refine(isAbsolute);
const relativeMaterialPath = nonNullString.refine((value) => value.length > 0
  && !isAbsolute(value) && !value.includes('\\')
  && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'));
const base64Bytes = z.string().refine((value) => Buffer.from(value, 'base64').toString('base64') === value);

export const AgentLaunchNativeIdentitySchema = z.object({ username: nonNullString, agentUid: z.number().int().positive(),
  agentGid: z.number().int().positive(), home: absolutePath }).strict();

/** The private runner envelope and stdin frame consume the same file grammar. */
export const AgentLaunchMaterializationSchema = z.object({
  /** Incumbent lease's retained Agent-owned runtime home, never the canonical Agent HOME. */
  runtimeHome: absolutePath,
  environment: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u), nonNullString),
  selectedMaterials: z.array(z.object({ relativePath: relativeMaterialPath, contentBase64: base64Bytes }).strict()),
}).strict().refine((payload) => new Set(payload.selectedMaterials.map((file) => file.relativePath)).size === payload.selectedMaterials.length);

const payloadSchema = AgentLaunchMaterializationSchema.safeExtend({
  v: z.literal(1),
  nativeIdentity: AgentLaunchNativeIdentitySchema.optional(),
  executable: absolutePath,
  args: z.array(nonNullString),
  cwd: absolutePath,
});

export type AgentLaunchSelectedMaterial = Readonly<{ relativePath: string; contentBase64: string }>;
export type AgentLaunchPayload = Readonly<{
  v: 1;
  nativeIdentity?: Readonly<{ username: string; agentUid: number; agentGid: number; home: string }>;
  executable: string;
  args: readonly string[];
  cwd: string;
  runtimeHome: string;
  environment: Readonly<Record<string, string>>;
  selectedMaterials: readonly AgentLaunchSelectedMaterial[];
}>;

export class AgentLaunchFrameError extends Error {
  readonly code = 'agent_launch_frame_invalid';
  constructor() {
    super('agent_launch_frame_invalid');
    this.name = 'AgentLaunchFrameError';
  }
}

export function parseAgentLaunchPayload(input: unknown): AgentLaunchPayload {
  const parsed = payloadSchema.safeParse(input);
  if (!parsed.success) throw new AgentLaunchFrameError();
  return parsed.data;
}

export function encodeAgentLaunchFrame(payload: AgentLaunchPayload): Buffer {
  const body = Buffer.from(JSON.stringify(parseAgentLaunchPayload(payload)), 'utf8');
  const header = Buffer.alloc(magic.length + 4);
  magic.copy(header);
  // The uint32 frame length is the format boundary, not a phase-local data cap.
  header.writeUInt32BE(body.length, magic.length);
  return Buffer.concat([header, body]);
}

async function readExactly(input: Readable, length: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let remaining = length;
  while (remaining > 0) {
    // Read only buffered bytes; do not grow Node's high-water mark to a
    // credential projection's declared frame length.
    const chunk: unknown = input.read(Math.min(remaining, Math.max(input.readableLength, 1)));
    if (chunk !== null) {
      if (!Buffer.isBuffer(chunk)) throw new AgentLaunchFrameError();
      chunks.push(chunk);
      remaining -= chunk.length;
      continue;
    }
    if (input.readableEnded || input.destroyed) throw new AgentLaunchFrameError();
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        input.off('readable', onReadable);
        input.off('end', onEnd);
        input.off('error', onError);
        input.off('close', onEnd);
      };
      const onReadable = () => { cleanup(); resolve(); };
      const onEnd = () => { cleanup(); reject(new AgentLaunchFrameError()); };
      const onError = () => { cleanup(); reject(new AgentLaunchFrameError()); };
      input.once('readable', onReadable);
      input.once('end', onEnd);
      input.once('error', onError);
      input.once('close', onEnd);
    });
  }
  return Buffer.concat(chunks, length);
}

export async function readAgentLaunchFrame(input: Readable, transport?: 'terminal'): Promise<AgentLaunchPayload> {
  if (transport === 'terminal') return readAgentLaunchTerminalFrame(input);
  const header = await readExactly(input, magic.length + 4);
  if (!header.subarray(0, magic.length).equals(magic)) throw new AgentLaunchFrameError();
  const body = await readExactly(input, header.readUInt32BE(magic.length));
  let decoded: unknown;
  try { decoded = JSON.parse(body.toString('utf8')); } catch { throw new AgentLaunchFrameError(); }
  return parseAgentLaunchPayload(decoded);
}

/** A PTY starts in canonical/echo mode. No selected bytes cross it until the
 * receiving shim has made that very terminal raw and emitted this marker. */
export const AGENT_LAUNCH_TERMINAL_READY = '\x1b]777;happier-agent-launch-ready\x07';
export const AGENT_LAUNCH_TERMINAL_ACCEPTED = '\x1b]777;happier-agent-launch-accepted\x07';

/** Preserve the binary frame over PtyProcess's UTF-8 string write boundary. */
export function encodeAgentLaunchTerminalFrame(frame: Uint8Array): string {
  return Buffer.from(frame).toString('base64') + '\n';
}

async function readAgentLaunchTerminalFrame(input: Readable): Promise<AgentLaunchPayload> {
  const encoded: Buffer[] = [];
  while (true) {
    const chunk = await readExactly(input, Math.max(input.readableLength, 1));
    const newline = chunk.indexOf(10);
    if (newline < 0) { encoded.push(chunk); continue; }
    encoded.push(chunk.subarray(0, newline));
    if (newline + 1 < chunk.length) input.unshift(chunk.subarray(newline + 1));
    break;
  }
  const text = Buffer.concat(encoded).toString('ascii');
  const frame = Buffer.from(text, 'base64');
  if (!text.length || frame.toString('base64') !== text) throw new AgentLaunchFrameError();
  const decoded = Readable.from([frame], { objectMode: false });
  const payload = await readAgentLaunchFrame(decoded);
  if (decoded.readableLength || decoded.read() !== null) throw new AgentLaunchFrameError();
  return payload;
}
