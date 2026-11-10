import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';

/** Recap reads existing memory or delivered updates; it never generates or stores a summary. */
export type SessionRecapSynopsis = Readonly<{ synopsis: string; seqTo: number; updatedAtMs: number }>;
export type SessionRecapWorkerUpdate = Readonly<{
  headline: string; body?: string | null; atMs: number; workerSessionId?: string | null;
}>;

const timestamp = () => z.number().check(z.int(), z.nonnegative());
export const SessionRecapSchema = lazyZodSchema(() => z.discriminatedUnion('source', [
  z.strictObject({ source: z.literal('synopsis'), text: z.string().check(z.minLength(1)), atMs: timestamp() }),
  z.strictObject({ source: z.literal('worker_update'), text: z.string().check(z.minLength(1)),
    body: z.optional(z.string().check(z.minLength(1))), atMs: timestamp(),
    workerSessionId: z.optional(z.string().check(z.minLength(1))) }),
]));
export type SessionRecap = z.infer<typeof SessionRecapSchema>;

export const SessionRecapStateSchema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('ready'), recap: SessionRecapSchema }),
  z.strictObject({ status: z.enum(['loading', 'empty', 'unavailable']), recap: z.null() }),
]));
export type SessionRecapState = z.infer<typeof SessionRecapStateSchema>;

/** Closed representation marker: an older activity digest cannot masquerade as a Recap. */
export const SessionRecapActionResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ view: z.literal('recap'), sessionId: z.string().check(z.minLength(1)),
    status: z.literal('ready'), recap: SessionRecapSchema }),
  z.strictObject({ view: z.literal('recap'), sessionId: z.string().check(z.minLength(1)),
    status: z.enum(['loading', 'empty', 'unavailable']), recap: z.null() }),
]));
export type SessionRecapActionResultV1 = z.infer<typeof SessionRecapActionResultV1Schema>;

export type SessionRecapInput = Readonly<{
  memoryEnabled: boolean;
  synopses: readonly SessionRecapSynopsis[];
  latestWorkerUpdate: SessionRecapWorkerUpdate | null;
}>;

function text(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

/** One source-selection policy for the Summary card, Work digest and public Action. */
export function resolveSessionRecap(input: SessionRecapInput): SessionRecap | null {
  let latest: SessionRecapSynopsis | null = null;
  for (const synopsis of input.memoryEnabled ? input.synopses : []) {
    if (!text(synopsis.synopsis)) continue;
    if (!latest || synopsis.seqTo > latest.seqTo || (synopsis.seqTo === latest.seqTo && synopsis.updatedAtMs > latest.updatedAtMs)) latest = synopsis;
  }
  const synopsisText = text(latest?.synopsis);
  if (latest && synopsisText) return { source: 'synopsis', text: synopsisText, atMs: latest.updatedAtMs };
  const worker = input.latestWorkerUpdate;
  const headline = text(worker?.headline);
  if (!worker || !headline) return null;
  const body = text(worker.body);
  return { source: 'worker_update', text: headline, atMs: worker.atMs,
    ...(body ? { body } : {}), ...(worker.workerSessionId ? { workerSessionId: worker.workerSessionId } : {}) };
}

export function resolveSessionRecapState(input: SessionRecapInput & Readonly<{
  contentReadable: boolean; transcriptLoaded: boolean; synopsisStatus?: 'ready' | 'loading' | 'unavailable';
}>): SessionRecapState {
  if (!input.contentReadable) return { status: 'unavailable', recap: null };
  const recap = resolveSessionRecap(input);
  if (recap) return { status: 'ready', recap };
  if (input.memoryEnabled && input.synopsisStatus === 'unavailable') return { status: 'unavailable', recap: null };
  return { status: input.transcriptLoaded && (!input.memoryEnabled || input.synopsisStatus !== 'loading') ? 'empty' : 'loading', recap: null };
}
